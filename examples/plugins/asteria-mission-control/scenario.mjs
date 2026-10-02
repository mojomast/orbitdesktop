import { MANIFEST, SOURCES, INPUT_SHA256, MODEL_VERSION, FLIGHT_LIMIT_KG, STRATEGY_PLANS } from './mission-data.mjs';

export const DEFAULT_SCENARIO = Object.freeze({ budgetUsd: 2000000, crewMonth: 18, relayMonth: 14, deduplicate: true, fuelCellUpgrade: false, atmosphereUpgrade: false, includeLaboratory: true, strategy: 'power-first' });
export const STRATEGIES = Object.freeze([
  { id: 'anchor-first', label: 'Anchor First' },
  { id: 'power-first', label: 'Power First' },
  { id: 'parallel-sprint', label: 'Parallel Sprint' },
].map(Object.freeze));

// Bounds describe the simulator's input domain, not mission compliance.
// Out-of-window crew dates within that domain are accepted and fail an outcome check.
export function normalizeScenario(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new TypeError('Scenario must be a plain object');
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_SCENARIO, key)) throw new TypeError(`Unknown scenario field: ${key}`);
  const scenario = { ...DEFAULT_SCENARIO, ...input };
  for (const [key, min, max] of [['budgetUsd',0,1000000000],['crewMonth',1,120],['relayMonth',0,120]]) {
    if (!Number.isSafeInteger(scenario[key]) || scenario[key] < min || scenario[key] > max) throw new RangeError(`${key} must be an integer from ${min} to ${max}`);
  }
  for (const key of ['deduplicate','fuelCellUpgrade','atmosphereUpgrade','includeLaboratory']) if (typeof scenario[key] !== 'boolean') throw new TypeError(`${key} must be boolean`);
  if (!STRATEGIES.some(({ id }) => id === scenario.strategy)) throw new RangeError('Unknown strategy');
  return scenario;
}

// Deliberately a canonical string, not a cryptographic digest. Includes source/model identity.
export function scenarioIdentity(input = {}) {
  return `${MODEL_VERSION}:${INPUT_SHA256}:${JSON.stringify(normalizeScenario(input))}`;
}

const round = value => Number(value.toFixed(8));
const usd = value => `USD ${value.toLocaleString('en-US')}`;

export function evaluateScenario(input = {}) {
  const scenario = normalizeScenario(input);
  const rows = MANIFEST.filter(row => !scenario.deduplicate || row.item_id !== 'EQU-025');
  const selected = rows.filter(row => scenario.includeLaboratory || row.module !== 'laboratory');
  const sum = (items, key) => round(items.reduce((total, row) => total + row.quantity * row[key], 0));
  const upgradeCostUsd = (scenario.fuelCellUpgrade ? 120000 : 0) + (scenario.atmosphereUpgrade ? 64000 : 0);
  const upgradeMassKg = (scenario.fuelCellUpgrade ? 50 : 0) + (scenario.atmosphereUpgrade ? 30 : 0);
  // Mandatory lab remains in the programme's equipment cap even when deferred.
  const costUsd = sum(rows, 'unit_cost_usd') + upgradeCostUsd;
  const currentPhaseCostUsd = sum(selected, 'unit_cost_usd') + upgradeCostUsd;
  const deferredCostUsd = costUsd - currentPhaseCostUsd;
  const massKg = sum(selected, 'unit_cargo_mass_kg') + upgradeMassKg;
  const wholeProgramMassKg = sum(rows, 'unit_cargo_mass_kg') + upgradeMassKg;
  const demandKw = sum(selected, 'unit_power_demand_kw');
  const wholeProgramDemandKw = sum(rows, 'unit_power_demand_kw');
  // Five documented three-decimal factors: integer product stays below 2^53.
  const reliability = [980, scenario.fuelCellUpgrade ? 990 : 965, 972, 988, scenario.atmosphereUpgrade ? 978 : 960].reduce((product, factor) => product * factor, 1) / 1000 ** 5;
  const averageGenerationKw = 5.54;
  const crewThresholdKw = 4.7;
  const averageMarginKw = round(averageGenerationKw - demandKw);
  const budgetMarginUsd = scenario.budgetUsd - costUsd;
  const nonLabDeliveryMonth = Math.max(...rows.filter(row => row.module !== 'laboratory').map(row => row.lead_time_months ?? 0));
  const earliestCrewMonth = Math.max(11, scenario.relayMonth + 1, 13);
  const flightGroups = STRATEGY_PLANS[scenario.strategy].groups.map((modules, index) => {
    const includedModules = modules.filter(module => scenario.includeLaboratory || module !== 'laboratory');
    const massKg = sum(selected.filter(row => includedModules.includes(row.module)), 'unit_cargo_mass_kg')
      + (includedModules.includes('power') && scenario.fuelCellUpgrade ? 50 : 0)
      + (includedModules.includes('life_support') && scenario.atmosphereUpgrade ? 30 : 0);
    return { id: `flight-${index + 1}`, modules: includedModules, massKg, withinLimit: massKg <= FLIGHT_LIMIT_KG };
  }).filter(group => group.modules.length);
  const checks = [];
  const check = (id, label, status, detail, source) => checks.push({ id, label, status, detail, source });
  check('budget', 'Whole-program equipment budget', budgetMarginUsd >= 0 ? 'pass' : 'fail', `${usd(costUsd)} required against ${usd(scenario.budgetUsd)}; margin ${usd(budgetMarginUsd)}. Current phase ${usd(currentPhaseCostUsd)}; deferred mandatory lab ${usd(deferredCostUsd)}. Launch, operations and contingency are excluded.`, 'DOC-01 §2–3; DOC-02 §4; manifest');
  check('reliability', 'Stage-2 critical-path reliability', reliability >= 0.9 ? 'pass' : 'fail', `${reliability.toFixed(13)} versus 0.900; laboratory is excluded from this path. Selected upgrades cost ${usd(upgradeCostUsd)}.`, 'DOC-03 §6–8; DOC-02 §4');
  check('crew-window', 'Crew arrival window', scenario.crewMonth >= 11 && scenario.crewMonth <= 18 ? 'pass' : 'fail', `Crew month ${scenario.crewMonth}; binding window months 11–18.`, 'DOC-01 §3');
  check('relay', 'Relay operational before crew', scenario.relayMonth <= scenario.crewMonth - 1 && scenario.relayMonth >= 12 ? 'pass' : 'fail', `Assumed operational month ${scenario.relayMonth}; needed by month ${scenario.crewMonth - 1}. Commercial delivery is month 12; operations uses month 14. These are separate assumptions, not resolved by physical-limit precedence.`, 'DOC-01 §7; DOC-02 §3; DOC-04 §3');
  check('known-lead-times', 'Stage-2 equipment readiness', 'unknown', `Known-lead non-lab items have a modeled delivery lower bound of month ${nonLabDeliveryMonth}, assuming orders at month 0. Sources do not allocate each item to a required pre-crew phase; this is not a mandatory crew-date bound. Missing item/stage allocation, unconfirmed leads and commissioning prevent a verified earliest occupancy date.`, 'manifest; DOC-01 §3,8; DOC-03 §1,7');
  check('missing-lead-time', 'Unconfirmed rover battery lead time', 'unknown', 'EQU-021 has no lead time. No delivery date or schedule compliance is inferred.', 'manifest EQU-021; DOC-04 §4');
  check('procurement', 'Month-0 order commitments', 'unknown', 'Month-0 orders are modeled, not evidenced. Relay and all items with lead times ≥12 months require programme-start orders; upgrade lead times are unconfirmed.', 'DOC-01 §7–8; DOC-02 §3–4');
  check('deduplication', 'Finance manifest reconciliation', 'unknown', scenario.deduplicate ? 'Assumes EQU-025 duplicates EQU-011; keeps EQU-011 (9-month lead). Removal is not Finance-confirmed.' : 'Both suspected duplicate rows are retained; Finance reconciliation remains outstanding.', 'manifest EQU-011/EQU-025; DOC-02 §7; DOC-04 §6');
  check('power-precedence', 'Binding crew power threshold', 'pass', 'Resolved discrepancy: DOC-03 §4 supersedes DOC-04’s 4.0 kW with 4.7 kW. Average crew margin is +0.84 kW, not proof of continuous supply.', 'DOC-01 §6,9; DOC-03 §4; DOC-04 preamble, §2');
  check('average-power', 'Selected-scope average power balance', averageMarginKw >= 0 ? 'pass' : 'fail', `${averageGenerationKw.toFixed(2)} kW average generation minus ${demandKw.toFixed(2)} kW selected demand = ${averageMarginKw.toFixed(2)} kW. Only one primary fuel cell counts; the second is a spare.`, 'DOC-03 §1–4; manifest');
  check('continuous-power', 'Continuous supply including lunar night', 'unknown', 'Average generation does not establish continuous supply at 4.7 kW. Battery energy, night duration, fuel inventory and storage assumptions are missing.', 'DOC-01 §6; DOC-03 §1–4');
  check('flight-mass', 'Modeled flight-group mass limits', flightGroups.every(group => group.withinLimit) ? 'pass' : 'fail', `${flightGroups.map(group => `${group.id}: ${group.massKg} kg`).join('; ')}; limit ${FLIGHT_LIMIT_KG} kg each. Equipment-only module groupings; not certified payloads or approved flight plans.`, 'DOC-01 §4; DOC-03 §5,9; manifest');
  check('deployment-schedule', 'Deployment and commissioning evidence', 'unknown', 'Flight groups contain no launch dates, installation durations or commissioning evidence. Mass compliance does not establish Stage-2 readiness.', 'DOC-01 §3,7–8; DOC-04 §1');
  check('laboratory', 'Mandatory laboratory operational by month 28', 'unknown', `${scenario.includeLaboratory ? 'Laboratory is in selected scope' : `Laboratory is deferred with ${usd(deferredCostUsd)} still required`}; no commissioning schedule or dedicated continuous 0.60 kW feed is evidenced. Deferral is not permanent elimination.`, 'DOC-01 §3; DOC-03 §9');
  check('site-clearance', 'Solar deployment clearance', 'unknown', 'No site layout demonstrates the required 8 m clear radius.', 'DOC-03 §9');
  const failures = checks.filter(check => check.status === 'fail');
  const unknowns = checks.filter(check => check.status === 'unknown');
  const status = failures.length ? 'blocked' : 'unverified';
  const headline = failures.length ? `Blocked: ${failures.length} mandatory checks fail` : 'Unverified: mandatory evidence is missing';
  const summary = `${usd(costUsd)} whole-program equipment; budget margin ${usd(budgetMarginUsd)}; reliability ${reliability.toFixed(4)} against 0.900. ${failures.length} failed and ${unknowns.length} unknown checks. Explicit timing rules give a crew lower bound of month ${earliestCrewMonth}; item/stage allocation and commissioning remain unverified. No verified feasible plan under these assumptions.`;
  const assumptions = [
    'All figures are synthetic demonstration data; this model is not an engineering certification.',
    scenario.deduplicate ? 'Proposed deduplication drops EQU-025, not confirmed by Finance.' : 'Raw manifest retains both suspected duplicate antenna rows.',
    `Relay is assumed operational at month ${scenario.relayMonth}; delivery, installation and commissioning are not interchangeable. One month models the 30-day relay buffer.`,
    `Known procurement leads assume month-0 orders; known-lead non-lab equipment has a modeled delivery lower bound of month ${nonLabDeliveryMonth}. Sources do not establish that every non-lab item is required before crew. EQU-021 and upgrade lead times are unconfirmed.`,
    'DOC-03 governs physical limits. 4.7 kW supersedes 4.0 kW; average 5.54 kW is not a continuous-power guarantee.',
    'Upgrade uplifts are the documented variant package totals, not multiplied again by equipment quantity; no generation or demand uplift is documented.',
    'Lab inclusion controls selected-phase mass and demand only. Whole-program budget and mandatory month-28 lab requirement always retain the laboratory.',
    'Earliest crew month uses only explicit timing rules: month 11 minimum, assumed relay operational month plus one, and month 13 minimum from commercial relay delivery no earlier than month 12. Missing item/stage allocation and commissioning prevent a verified earliest date. Flight count is an arithmetic lower bound, not packing/launch certification.',
  ];
  return { scenario, costUsd, currentPhaseCostUsd, deferredCostUsd, upgradeCostUsd, upgradeMassKg, massKg, wholeProgramMassKg, demandKw, wholeProgramDemandKw, budgetMarginUsd, reliability, reliabilityTarget: 0.9, averageGenerationKw, crewThresholdKw, averageMarginKw, earliestCrewMonth, nonLabDeliveryMonth, flightCountLowerBound: Math.ceil(massKg / FLIGHT_LIMIT_KG), wholeProgramFlightCountLowerBound: Math.ceil(wholeProgramMassKg / FLIGHT_LIMIT_KG), flightGroups, checks, status, headline, summary, assumptions, citations: SOURCES.map(source => ({ ...source })), inputSha256: INPUT_SHA256, modelVersion: MODEL_VERSION, scenarioId: scenarioIdentity(scenario) };
}

export function comparisonScenarios(input = {}) {
  const scenario = normalizeScenario(input);
  // Original documented strategy assignments replace crew/upgrades; explicit budget,
  // relay, deduplication and selected lab scope carry through from the current input.
  return STRATEGIES.map(({ id, label }) => {
    const plan = STRATEGY_PLANS[id];
    return { id, label, result: evaluateScenario({ ...scenario, strategy: id, crewMonth: plan.crewMonth, fuelCellUpgrade: plan.fuelCellUpgrade, atmosphereUpgrade: plan.atmosphereUpgrade }) };
  });
}

export function buildBrief(input = {}) {
  const r = evaluateScenario(input);
  return [
    '# Asteria scenario decision brief', '', '**SYNTHETIC DEMONSTRATION DATA**', '',
    `## ${r.headline}`, '', r.summary, '',
    `- Strategy: ${STRATEGIES.find(s => s.id === r.scenario.strategy).label}; crew month ${r.scenario.crewMonth}; relay month ${r.scenario.relayMonth}.`,
    `- Fuel-cell upgrade: ${r.scenario.fuelCellUpgrade}; atmosphere upgrade: ${r.scenario.atmosphereUpgrade}; uplift ${usd(r.upgradeCostUsd)}, ${r.upgradeMassKg} kg.`,
    `- Whole-program equipment cost: ${usd(r.costUsd)}; cap ${usd(r.scenario.budgetUsd)}; margin ${usd(r.budgetMarginUsd)}.`,
    `- Current phase cost: ${usd(r.currentPhaseCostUsd)}; deferred mandatory lab cost: ${usd(r.deferredCostUsd)}.`,
    `- Selected mass: ${r.massKg} kg; whole-program mass: ${r.wholeProgramMassKg} kg. Selected flight-count lower bound: ${r.flightCountLowerBound}; whole-program lower bound: ${r.wholeProgramFlightCountLowerBound}.`,
    `- Selected demand: ${r.demandKw.toFixed(2)} kW; whole-program demand: ${r.wholeProgramDemandKw.toFixed(2)} kW.`,
    `- Average generation: ${r.averageGenerationKw.toFixed(2)} kW; average selected margin: ${r.averageMarginKw.toFixed(2)} kW. Binding crew threshold: ${r.crewThresholdKw.toFixed(1)} kW. Continuous supply remains unknown.`,
    `- Critical-path reliability: ${r.reliability.toFixed(13)}; target ${r.reliabilityTarget.toFixed(3)}.`,
    `- Crew arithmetic lower bound from explicit timing rules only: month ${r.earliestCrewMonth}; missing item/stage allocation, unconfirmed leads and commissioning prevent a verified earliest date.`,
    `- Known-lead non-lab equipment modeled delivery lower bound: month ${r.nonLabDeliveryMonth}, assuming month-0 orders; not a mandatory pre-crew delivery requirement.`,
    '', '## Mandatory outcome checks', '',
    ...r.checks.map(c => `- **${c.status.toUpperCase()} — ${c.label}:** ${c.detail} (${c.source})`),
    '', '## Assumptions and limits', '', ...r.assumptions.map(a => `- ${a}`),
    '', '## Provenance', '', `- Model: ${r.modelVersion}`, `- Scenario identity (canonical string, not a hash): \`${r.scenarioId}\``, `- Input CSV SHA-256: \`${r.inputSha256}\``,
    ...r.citations.map(c => `- [${c.id}: ${c.label}](${c.href}); SHA-256 \`${c.sha256}\``), '',
  ].join('\n');
}
