// `continuous` is the transport's positive assertion of uninterrupted host
// reads. The adapter dates quality by heartbeat; `at` can be a much older
// updated_at. Compare origin times to their respective collector clocks too.
const WINDOW = 10 * 60_000, SKEW = 60_000;
const observedStates = new Set(['queued','starting','running','working','backoff','blocked','succeeded','failed','cancelled','accepted','rejected','not_started','done']);
const stamp = v => typeof v === 'string' ? Date.parse(v) : NaN;
const fresh = (at, sample) => sample - at <= WINDOW && sample - at >= -SKEW;
function usable(v) {
  if (!['degraded','live'].includes(v?.health) || !Array.isArray(v.attempts)) return false;
  // Some embedding projections omit the coverage table. If supplied, stale
  // fleet coverage cannot be repaired by a fresh collector timestamp.
  const fleet = v.sections?.find(s => s?.id === 'fleet');
  return !fleet || (fleet.state === 'live' && fresh(stamp(fleet.at), stamp(v.generatedAt)));
}
function indexed(rows) {
  const by = new Map();
  for(const row of rows) {
    const id = row?.id;
    if (typeof id === 'string' && id.trim() && id !== 'unknown') by.set(id, by.has(id) ? null : row);
  }
  return by;
}
export function confirmedChanges(oldView, newView, continuous = false) {
  const ids = new Set();
  if (continuous !== true || !usable(oldView) || !usable(newView)) return ids;
  const before = stamp(oldView.generatedAt), after = stamp(newView.generatedAt);
  if (!(after > before && after - before <= WINDOW)) return ids;
  const by = indexed(oldView.attempts);
  for (const [id,r] of indexed(newView.attempts)) {
    const p = by.get(id);
    if (
      !r || !p ||
      r.quality !== "live" ||
      p.quality !== "live" ||
      typeof r.source !== 'string' || !r.source.trim() || ['unknown','snapshot/1:fleet','snapshot/1:fleet:dispatch_leases'].includes(r.source) || r.source !== p.source ||
      !observedStates.has(p.state) || !observedStates.has(r.state) ||
      r.state === p.state ||
      !fresh(stamp(r.at),after) || !fresh(stamp(p.at),before) || !(stamp(r.at) > stamp(p.at))
    )
      continue;
    ids.add(r.id);
  }
  return ids;
}
