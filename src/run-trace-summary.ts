import type {RunTrace, TraceSpan} from './run-trace-client';

/** A bounded diagnostic snapshot, never tool bodies or an execution verdict. */
export function traceDiagnosticSummary(trace: RunTrace, spans: TraceSpan[], hasMore: boolean): string {
  const sampled = spans.slice(0, 500);
  const count = (predicate: (span: TraceSpan) => boolean) => sampled.filter(predicate).length;
  const timings = sampled.reduce((totals, span) => {
    if (span.end_unix_ms !== null && span.duration_origin !== 'instant') {
      totals[span.duration_origin] += Math.max(0, span.end_unix_ms - span.start_unix_ms);
    }
    return totals;
  }, {observed: 0, local_observation: 0});
  return JSON.stringify({
    kind: 'orbit.trace-diagnostic.v1',
    trace_id: trace.trace_id,
    method: trace.method,
    run_id: trace.run_id,
    observed_status: trace.status,
    observation_gaps: trace.partial,
    last_observation_unix_ms: trace.updated_at,
    included_spans: sampled.length,
    more_spans_omitted: hasMore || spans.length > sampled.length,
    open_spans: count(span => span.end_unix_ms === null),
    error_spans: count(span => span.status === 'error'),
    instant_facts: count(span => span.duration_origin === 'instant'),
    summed_span_milliseconds: timings,
    interpretation: 'Derived observed metadata only, not an authoritative execution receipt. Missing events and open spans do not establish failure or completion. Local-observation timing is server observation timing. Summed spans can overlap and are not wall-clock run duration. Snapshot may change as further events arrive.',
  }, null, 2);
}
