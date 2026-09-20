# Jev-assisted workspace actions (experimental)

## Research

Open-web discovery used WebXNG/SearXNG; generic Jev searches returned no results. Existing local RouteTok research identified Jev as TypeSafe's System One model. Official docs were then fetched directly with curl because this session's web extraction backend is search-only.

- https://docs.typesafe.ai/demos/smart-home — published demonstration of typed decisions over state, speculative fan-out and conversational LLM fallback. This is a vendor demo, not independently verified production adoption; its page says source will be available at release.
- https://docs.typesafe.ai/patterns/fan-out — ask several independent/speculative questions in one call, then let code choose relevant results.
- https://docs.typesafe.ai/patterns/intent-routing — deterministic handlers versus specialist models/humans.
- https://docs.typesafe.ai/api — POST https://api.typesafe.ai/v1/systemone, Bearer key, model/state/questions; Choice, Score and Noul answers.
- https://docs.typesafe.ai/confidence — confidence is derived from the distribution, not a guarantee of correct execution.

The applicable pattern is not “ask Jev to generate arbitrary commands.” Provide known actions and current state, ask typed questions in parallel, validate, and map the result to code-owned operations. Hermes remains responsible for open-ended building and reasoning. In a future expansion, generate candidates for additional typed parameter combinations, benchmark ambiguity and target selection, then increase coverage only with evidence.

## Implemented

Hermes tools → Jev quick actions. Supply a TypeSafe key in a password field and explicitly authorize transmission. The key exists in dialog/request memory only, not localStorage, checkpoints or files. Closing clears the field. The server uses a fixed HTTPS endpoint, no redirects/retries, 8-second timeout and bounded 64KB response. No external call occurs without consent.

The outbound state contains the user's request, current view/sidebar, window count and installed plugin names/IDs plus supported action descriptions. It excludes chat history, terminal content, iframe URLs, plugin config and workspace credentials. Users should not type secrets into their request. It deliberately does NOT send the full workspace or every available tool.

One call asks a Choice for action and a Noul for ambiguity/compound intent. Supported actions: Windows/Spatial view, show/hide sidebar, enable/disable an installed plugin. Unknown, complex or compound requests return “use Hermes chat”; there is no automatic forwarding or hidden extra model call. Confidence >=0.9 and ambiguity <0.2 are provisional, uncalibrated thresholds, not a safety proof.

A returned candidate is previewed, never auto-executed. Explicit apply uses current revision, deterministic allowlisted operations, state validation and an automatic checkpoint. This endpoint is an authenticated quick-action executor, not proof that Jev endorsed a candidate; an authenticated client can choose an allowed action directly. The server stores neither prompts nor keys. Existing deployment logging outside this code must also avoid request bodies.

## Evidence and limitations

Contract tests use explicit synthetic responses, not a live Jev service. They test payload minimization, typed fan-out, deterministic action mapping, malformed response rejection, consent and low-confidence abstention. Workspace tests cover confirmation, stale revisions and checkpoints. No working TypeSafe credential was used for a paid live inference in this implementation. API compatibility, actual decision quality, latency/cost and speed improvement remain unverified with the provider.

This is an optional UI fast path, NOT automatic acceleration of all Hermes turns or a complete all-tools planner. Keep it experimental until measured. Compare end-to-end request-to-browser-ack latency (p50/p95), action/target correctness, false confident actions, abstention rate, provider errors and cost per successful change against Hermes-only on held-out requests. Include clarification/confirmation time. Raw classifier latency alone does not establish a faster user workflow. Build thresholds on a separate calibration set and retain checkpoint rollback.
