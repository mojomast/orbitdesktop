// Ephemeral display state. No write methods, persistent payloads or event log.
export function createStore() {
  const initial = () => ({ kind: "station", id: "build" });
  let state = { view: null, status: "unavailable", selection: initial() },
    digest = "",
    time = -Infinity,
    conflict = false;
  return {
    get current() {
      return state;
    },
    reset() {
      state = { view: null, status: "loading", selection: initial() };
      digest = "";
      time = -Infinity;
      conflict = false;
    },
    select(kind, id) {
      state = { ...state, selection: { kind, id } };
    },
    transport(status) {
      if (status === "unauthorized") {
        this.reset();
      }
      if (conflict && ["loading", "connected"].includes(status)) {
        state = { ...state, status: "conflict" };
        return;
      }
      state = { ...state, status };
    },
    hydrate(v) {
      const t = Date.parse(v?.generatedAt);
      if (!Number.isFinite(t)) return "invalid";
      if (t < time) return "old";
      const next = JSON.stringify(v);
      if (t === time) {
        if (next !== digest) {
          conflict = true;
          state = { ...state, status: "conflict" };
          return "conflict";
        }
        if (!conflict) state = { ...state, status: "connected" };
        return "duplicate";
      }
      digest = next;
      conflict = false;
      time = t;
      state = { ...state, status: "connected", view: v };
      return "new";
    },
  };
}
