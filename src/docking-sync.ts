import type { DockingPlacement } from './docking-placement';

type SaveResult = { placement_revision?: number; conflict?: boolean; ok?: boolean };

export function createDockingSync({ applyPlacement, savePlacement, reload, status, debounceMs = 400,
  setTimer = setTimeout, clearTimer = clearTimeout }: {
  applyPlacement: (placement: DockingPlacement) => void;
  savePlacement: (placement: DockingPlacement) => Promise<SaveResult>;
  reload: () => Promise<unknown>;
  status: (message: string) => void;
  debounceMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}) {
  let hydrated = false, disposed = false, applying = false, conflict = false;
  let appliedPlacementRevision = 0;
  let generation = 0;
  let queued: DockingPlacement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | null = null;
  const cancelTimer = () => { if (timer !== undefined) clearTimer(timer); timer = undefined; };
  const apply = (placement: DockingPlacement) => {
    applying = true;
    try { applyPlacement(placement); } finally { applying = false; }
  };
  function hydrate(placement: DockingPlacement, revision: number) {
    if (disposed) return;
    generation++;
    cancelTimer(); queued = null;
    appliedPlacementRevision = revision;
    apply(placement);
    hydrated = true; conflict = false;
    status('Saved docking placement restored');
  }
  function remote(placement: DockingPlacement, revision: number) {
    if (disposed) return;
    if (!hydrated && !conflict) { hydrate(placement, revision); return; }
    if (revision === appliedPlacementRevision && !conflict) return;
    generation++;
    const lost = queued !== null || inFlight !== null || conflict;
    cancelTimer(); queued = null;
    apply(placement);
    appliedPlacementRevision = revision;
    hydrated = true;
    conflict = false;
    if (lost) status('Remote docking placement replaced unsaved local changes; reload to review');
  }
  function run(): Promise<void> {
    cancelTimer();
    if (inFlight || !queued || disposed || !hydrated || conflict) return inFlight ?? Promise.resolve();
    const placement = queued; queued = null;
    const saveGeneration = generation;
    let drainQueued = false;
    inFlight = (async () => {
      let result: SaveResult;
      try { result = await savePlacement(placement); }
      catch { result = { ok: false }; }
      if (disposed) return;
      if (saveGeneration !== generation) { drainQueued = true; return; }
      if (result.conflict) {
        conflict = true; hydrated = false; queued = null; cancelTimer();
        try { await reload(); } catch { /* conflict remains visible even offline */ }
        status('Docking placement conflict; reload to review saved placement');
      } else if (result.ok === false || !Number.isSafeInteger(result.placement_revision)) {
        queued ??= placement;
        status('Docking placement was not saved; reconnect and retry');
      } else {
        appliedPlacementRevision = result.placement_revision!;
        drainQueued = true;
        status('Docking placement saved');
      }
    })().finally(() => {
      inFlight = null;
      if (drainQueued && queued && hydrated && !conflict && !disposed && timer === undefined) {
        timer = setTimer(() => { timer = undefined; void run(); }, debounceMs);
      }
    });
    return inFlight;
  }
  function local(placement: DockingPlacement) {
    if (disposed || applying || conflict) return;
    if (!hydrated) { status('Docking placement is not saved: connect host to load the workspace first'); return; }
    queued = placement;
    cancelTimer();
    timer = setTimer(() => { timer = undefined; void run(); }, debounceMs);
  }
  async function flush() {
    while (true) {
      cancelTimer();
      if (inFlight) await inFlight;
      else if (queued && hydrated && !conflict) await run();
      else return;
      // A failed save is kept for a later explicit retry; avoid a busy loop.
      if (queued && !timer && !inFlight) return;
    }
  }
  function dispose() { disposed = true; cancelTimer(); queued = null; }
  return { get enabled() { return hydrated && !disposed && !conflict; }, hydrate, remote, local, flush, dispose };
}
