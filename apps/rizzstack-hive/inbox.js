// Classification is about the evidence behind the item, not its paint color.
export function inboxItems(v, historical = false) {
  const records = new Map(v.records.map((r) => [r.id, r]));
  return v.attention
    .map((a) => {
      const linked = records.get(a.id) || records.get(a.detail),
        record = linked?.source === a.source ? linked : null;
      const section = v.sections.find((s) => a.source === `snapshot/1:${s.id}`);
      const owner =
        record?.kind === "decision" &&
        record.state === "pending" &&
        section?.id === "decisions" &&
        section.state === "live";
      const pressure = record?.kind === "bottleneck";
      const diagnostic = !record && a.id.startsWith("section:");
      const category = historical
        ? "Last observed"
        : owner
          ? "Owner decision"
          : diagnostic
            ? "Source integrity"
            : pressure
              ? a.stage === "verify"
                ? "Verification queue"
                : "Pipeline pressure"
              : record?.kind === "ci"
                ? "Check failure"
                : record?.kind === "failure"
                  ? "Failure record"
                  : "Investigate";
      const time = Date.parse(v.generatedAt) - Date.parse(a.at);
      const age =
        Number.isFinite(time) && time >= 0
          ? time < 60000
            ? "at snapshot"
            : time < 3600000
              ? `${Math.floor(time / 60000)}m before snapshot`
              : `${Math.floor(time / 3600000)}h before snapshot`
          : null;
      return {
        id: a.id,
        category,
        owner: owner && !historical,
        rank:
          diagnostic && a.level === "danger" ? 0 : owner ? 1 : pressure ? 2 : 3,
        title: record?.kind === "decision" ? record.title : a.title,
        note: owner
          ? "Awaiting an owner response."
          : pressure
            ? a.reason
            : diagnostic
              ? "Current facts cannot be confirmed."
              : a.reason,
        age,
        stage: a.stage,
        level: historical ? "unknown" : a.level,
        target: { kind: record?.kind || "attention", id: record?.id || a.id },
      };
    })
    .sort((a, b) => a.rank - b.rank);
}

export function emptyInbox(v) {
  if (!v.generatedAt)
    return "Awaiting a source. Owner requests, pressure and failures are unknown.";
  const sections = ["decisions", "bottlenecks", "failures", "alerts"];
  const missing = sections.filter(
    (id) => !v.sections.some((x) => x.id === id && x.state === "live"),
  );
  if (!missing.includes('decisions') && !v.stations?.some(s=>s.id==='receiver' && s.quality==='live' && s.depth===0)) missing.push('current owner requests');
  return missing.length
    ? `No signals in this observation. Incomplete coverage: ${missing.join(", ")}.`
    : "No active attention signals reported by the covered sources.";
}
