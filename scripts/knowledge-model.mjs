import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  MODEL,
  MODEL_FILES,
  verifyModel,
  assertPrivatePath,
} from "../server/knowledge-model.mjs";
import { hash } from "../server/knowledge-chunker.mjs";
const [action, root] = process.argv.slice(2);
if (!["provision", "verify"].includes(action) || !root)
  throw Error(
    "Usage: node scripts/knowledge-model.mjs provision|verify RUNTIME_ROOT",
  );
assertPrivatePath(root, true);
const parent = path.join(root, "knowledge-index");
if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
assertPrivatePath(parent, true);
const dest = path.join(parent, "model");
if (action === "verify") {
  if (!verifyModel(dest)) throw Error("Model absent or integrity mismatch");
  console.log("Verified offline MiniLM q8", MODEL.revision);
} else if (fs.existsSync(dest)) {
  if (!verifyModel(dest))
    throw Error("Existing model mismatched; refusing overwrite");
  console.log("Already verified");
} else {
  const temp = path.join(parent, `.model-${randomUUID()}`);
  fs.mkdirSync(temp, { mode: 0o700 });
  fs.mkdirSync(path.join(temp, "onnx"), { mode: 0o700 });
  try {
    for (const [name, size, sha] of MODEL_FILES) {
      const response = await fetch(
        `https://huggingface.co/${MODEL.id}/resolve/${MODEL.revision}/${name}`,
        { signal: AbortSignal.timeout(120000) },
      );
      if (!response.ok) throw Error(`Download failed: ${name}`);
      const parts = [];
      let total = 0;
      for await (const part of response.body) {
        total += part.length;
        if (total > size) throw Error("Artifact exceeds reviewed bound");
        parts.push(part);
      }
      const bytes = Buffer.concat(parts);
      if (total !== size || hash(bytes) !== sha)
        throw Error(`SHA256 mismatch: ${name}`);
      const fd = fs.openSync(path.join(temp, name), "wx", 0o600);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    const fd = fs.openSync(path.join(temp, "model.json"), "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ ...MODEL, files: MODEL_FILES }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (const dir of [path.join(temp, "onnx"), temp]) {
      const fd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    fs.renameSync(temp, dest);
    const parentFd = fs.openSync(parent, "r");
    try {
      fs.fsyncSync(parentFd);
    } finally {
      fs.closeSync(parentFd);
    }
    console.log(
      "Provisioned verified public Apache-2.0 MiniLM q8",
      MODEL.revision,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
