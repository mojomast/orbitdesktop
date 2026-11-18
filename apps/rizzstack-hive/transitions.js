// Highlight observations, not inferred work. First hydrate, replay, stale data,
// missing join keys and reconnects cannot generate a transition.
export function confirmedChanges(oldView, newView, continuous = false) {
  const ids = new Set();
  if (
    !continuous ||
    !oldView ||
    !newView ||
    Date.parse(newView.generatedAt) <= Date.parse(oldView.generatedAt)
  )
    return ids;
  const by = new Map(oldView.attempts.map((r) => [r.id, r]));
  for (const r of newView.attempts) {
    const p = by.get(r.id);
    if (
      !p ||
      r.quality !== "live" ||
      p.quality !== "live" ||
      r.source !== p.source ||
      !r.state ||
      r.state === "unknown" ||
      r.state === p.state ||
      !(Date.parse(r.at) > Date.parse(p.at))
    )
      continue;
    ids.add(r.id);
  }
  return ids;
}
