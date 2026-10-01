import { fork } from "node:child_process";
import { MODEL, verifyModel } from "./knowledge-model.mjs";
export function createEmbedder({ modelDir }) {
  let worker = null,
    serial = 0,
    ready = false,
    closed = false,
    present = null,
    lastError = null;
  const pending = new Map();
  function rejectAll() {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(Error("Semantic worker stopped"));
    }
    pending.clear();
    ready = false;
  }
  function status() {
    present ??= verifyModel(modelDir);
    return {
      ...MODEL,
      present,
      ready,
      worker_alive: !!worker,
      error: lastError,
      note:
        lastError ??
        (present
          ? "Offline local model; indexing on demand"
          : "Model absent or unverified; keyword search available"),
    };
  }
  async function cancel() {
    const old = worker;
    worker = null;
    rejectAll();
    if (old && old.exitCode === null && old.signalCode === null)
      await new Promise((resolve) => {
        old.once("exit", resolve);
        old.kill("SIGKILL");
      });
  }
  function embed(texts) {
    if (
      closed ||
      !status().present ||
      !Array.isArray(texts) ||
      !texts.length ||
      texts.length > 16 ||
      !texts.every((t) => typeof t === "string" && t.length <= 1200) ||
      pending.size >= 8
    )
      return Promise.reject(Error("Semantic unavailable or busy"));
    if (!worker) {
      worker = fork(
        new URL("./knowledge-embed-worker.mjs", import.meta.url),
        [modelDir],
        {
          serialization: "advanced",
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          execArgv: ["--max-old-space-size=256"],
        },
      );
      const own = worker;
      own.on("message", (message) => {
        if (worker !== own) return;
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error) {
          lastError = message.error;
          item.reject(Error(message.error));
        } else {
          lastError = null;
          ready = true;
          item.resolve(message.vectors.map((v) => new Float32Array(v)));
        }
      });
      own.on("error", () => {
        if (worker === own) {
          lastError = "Semantic worker unavailable; keyword fallback";
          worker = null;
          rejectAll();
        }
      });
      own.on("exit", () => {
        if (worker === own) {
          lastError = "Semantic worker exited; keyword fallback";
          worker = null;
          rejectAll();
        }
      });
    }
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void cancel();
      }, 120000);
      pending.set(id, { resolve, reject, timer });
      worker.send({ id, texts }, (error) => {
        if (error) {
          const item = pending.get(id);
          if (item) {
            clearTimeout(item.timer);
            pending.delete(id);
            item.reject(Error("Semantic IPC unavailable"));
          }
        }
      });
    });
  }
  return {
    status,
    embed,
    cancel,
    async dispose() {
      closed = true;
      await cancel();
    },
  };
}
