# Asteria Mission Control simulator

This source example implements the first outcome-oriented improvement identified
during the Asteria walkthrough: one shared scenario model drives a functioning
interactive analysis, comparisons and exported brief.

Source: `examples/plugins/asteria-mission-control/`. It uses the existing
[sandboxed plugin lifecycle](PLUGINS.md), with a new content-addressed publication
for every changed bundle. Installing it does not require a core service restart.
The source checkout contains the example; the portable Hermes archive does not
automatically install or include repository examples.

## Experience

The primary view exposes budget, upgrade choices, reconciliation assumptions,
crew arrival and relay availability. Changes recompute actual budget/reliability
and schedule checks. Strategy comparisons and exports use the canonical model,
avoiding separately authored conclusions that can disagree with the numbers.

Quick actions include **Add both reliability upgrades**, **Apply 15% budget cut**,
and **Reset scenario**. **Export decision brief** and **Export scenario JSON**
capture the current analysis. Source references and remaining assumptions are
available alongside the result. This is deterministic local computation; no
provider call is needed for an interaction.

Source links open a keyboard-accessible evidence viewer inside the simulator,
preserving the current scenario. The viewer reads bundled public text with omitted
credentials and offers an explicit download. Brief exports use absolute published
source links, so references still work from the downloaded file.

## Calculation and evidence boundaries

- The raw 25-row CSV totals $2,005,000. Under the explicit assumption that EQU-025
  duplicates EQU-011, reconciled equipment costs $1,953,000, weighs 7,315 kg and
  has 6.42 kW modeled demand.
- Both reliability upgrades add $184,000 and 80 kg. The resulting total equipment
  cost is **$2,137,000**, $137,000 above the original $2,000,000 budget. The baseline
  reliability product is approximately 0.8719; both upgrades give approximately
  0.9112. The price and reliability displayed must always describe the same choices.
- A 15% cut to the original budget sets a **$1,700,000** cap. The unchanged
  upgraded equipment has a **$437,000** gap.
- DOC-03 explicitly supersedes the earlier crew threshold with **4.7 kW**.
  This is a resolved source discrepancy, not a choice for the owner to arbitrate.
- The modeled 5.54 kW average generation does not prove continuous power. Storage,
  night duration and fuel assumptions are incomplete, and the missing EQU-021
  lead time also remains visible. Partial checks cannot establish full feasibility.
- Relay estimates of month 12 and month 14 are separate timing assumptions. A
  month-14 crew arrival has different relay-constraint results under those choices.
- The crew timing lower bound reflects the explicit crew window and relay buffer.
  The known non-laboratory deliveries extend to month 16, but the sources do not
  allocate every item to a mandatory pre-crew phase. That equipment date alone
  does not establish a failed Stage-2 readiness check; allocation and commissioning
  remain unknown.
- The laboratory is required by month 28. Deferring it from a phase cannot erase
  its equipment cost from the programme budget or prove later delivery.

All data is synthetic. Source precedence and arithmetic validation do not certify
a physical mission. Results distinguish failed modeled constraints from missing
evidence and do not claim a fully feasible plan while mandatory checks are unknown.

## State and interoperability

The bundle carries a fixed dataset and model version. The app's state is page
memory; reload resets it, and exports are local downloads. It does not use an
owner API, modify private libraries, submit a conversation or infer a source grant.
Existing Knowledge sources, Data workbench, document/canvas and A2UI libraries
retain their separate identities. This simulator is the specialized calculation
and comparison view for the synthetic task.

The broader proposed Normal task intake, delegated Data query tools, selected-
document revision authority and durable multi-run task context are separate work.

## Acceptance

`tests/asteria-scenario.test.mjs` covers model invariants and outcome consistency.
`tests/asteria-simulator.browser.py` uses the real static-app handler, content-
addressed publisher and browser sandbox in a disposable runtime. It tests actual
control changes, cost/reliability coupling, budget shock, dedup sensitivity,
arbitrary budget values, exports, reset and narrow-screen layout.

Use `npm run check`, publisher tests and the browser journey before publication.
Keep synthetic screenshots outside Git. A successful source test is separate from
live workspace acknowledgement and owner visual acceptance.
