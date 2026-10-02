import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DEFAULT_SCENARIO, STRATEGIES, normalizeScenario, evaluateScenario, comparisonScenarios, buildBrief, scenarioIdentity } from '../examples/plugins/asteria-mission-control/scenario.mjs';
import { MANIFEST, SOURCES } from '../examples/plugins/asteria-mission-control/mission-data.mjs';

const root = new URL('../examples/plugins/asteria-mission-control/', import.meta.url);
const csv = await readFile(new URL('data/manifest.csv', root), 'utf8');
const [header, ...lines] = csv.trim().split(/\r?\n/);
const fields = header.split(',');
// Independent source oracle: integer cents-of-kW avoids the model's floating summation.
const rawRows = lines.map(line => Object.fromEntries(line.split(',').map((value, i) => [fields[i], value])));
const cost = rows => rows.reduce((sum, r) => sum + Number(r.quantity) * Number(r.unit_cost_usd), 0);
const mass = rows => rows.reduce((sum, r) => sum + Number(r.quantity) * Number(r.unit_cargo_mass_kg), 0);
const demand = rows => rows.reduce((sum, r) => sum + Number(r.quantity) * Math.round(Number(r.unit_power_demand_kw) * 100), 0) / 100;
const check = (r, id) => {
  const value = r.checks.find(c => c.id === id);
  assert.ok(value, `Missing outcome check ${id}`);
  return value;
};
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-14, `${actual} != ${expected}`);

test('public source hashes and embedded rows exactly match the pinned synthetic kit', async () => {
  assert.equal(SOURCES[0].sha256, 'fe5df21cbc03e71a968ff3281017be28b5b85855cf4ad5c6d6f70a8189097d3b');
  for (const source of SOURCES) {
    const bytes = await readFile(new URL(source.href, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256, source.id);
    if (source.id !== 'manifest') assert.match(bytes.toString(), /SYNTHETIC DEMONSTRATION DATA/);
  }
  assert.equal(MANIFEST.length, 25);
  for (const [i, row] of MANIFEST.entries()) {
    for (const field of fields) assert.equal(row[field] === null ? '' : String(row[field]), rawRows[i][field] === '' ? '' : ['quantity','unit_cost_usd','unit_cargo_mass_kg','unit_power_demand_kw','lead_time_months'].includes(field) ? String(Number(rawRows[i][field])) : rawRows[i][field], `${i}:${field}`);
  }
  assert.equal(cost(rawRows), 2005000);
  assert.equal(cost(rawRows.filter(r => r.item_id !== 'EQU-025')), 1953000);
});

test('default API, normalization and identity are deterministic without mutating caller state', () => {
  assert.deepEqual(normalizeScenario(), { budgetUsd: 2000000, crewMonth: 18, relayMonth: 14, deduplicate: true, fuelCellUpgrade: false, atmosphereUpgrade: false, includeLaboratory: true, strategy: 'power-first' });
  assert.deepEqual(STRATEGIES.map(s => s.id), ['anchor-first','power-first','parallel-sprint']);
  const input = Object.freeze({ relayMonth: 12, budgetUsd: 1900000 });
  assert.equal(scenarioIdentity(input), scenarioIdentity({ budgetUsd: 1900000, relayMonth: 12 }));
  assert.equal(evaluateScenario(input).scenarioId, scenarioIdentity(input));
  for (const key of Object.keys(DEFAULT_SCENARIO)) {
    const value = typeof DEFAULT_SCENARIO[key] === 'boolean' ? !DEFAULT_SCENARIO[key] : key === 'strategy' ? 'anchor-first' : DEFAULT_SCENARIO[key] + 1;
    assert.notEqual(scenarioIdentity(), scenarioIdentity({ [key]: value }), key);
  }
  assert.notEqual(normalizeScenario(), DEFAULT_SCENARIO);
});

test('canonical inputs reject coercion, nonfinite values, unsupported fields and invalid bounds', () => {
  for (const input of [null, [], 'power-first', 3, new Date(), { unknown: 1 }, { strategy: 'Power First' }]) assert.throws(() => normalizeScenario(input));
  for (const key of ['budgetUsd','crewMonth','relayMonth']) {
    for (const value of ['14', true, undefined, null, NaN, Infinity, -1, 1.5, 1000000001]) assert.throws(() => normalizeScenario({ [key]: value }), `${key}=${value}`);
  }
  for (const key of ['deduplicate','fuelCellUpgrade','atmosphereUpgrade','includeLaboratory']) for (const value of [0, 1, 'true', null, undefined]) assert.throws(() => normalizeScenario({ [key]: value }));
  assert.throws(() => normalizeScenario({ crewMonth: 0 }));
  assert.throws(() => normalizeScenario({ crewMonth: 121 }));
  assert.throws(() => normalizeScenario({ relayMonth: 121 }));
  assert.equal(normalizeScenario({ budgetUsd: 0, relayMonth: 0, crewMonth: 1 }).budgetUsd, 0);
  assert.equal(normalizeScenario({ budgetUsd: 1000000000, crewMonth: 120, relayMonth: 120 }).crewMonth, 120);
  assert.equal(check(evaluateScenario({ crewMonth: 19 }), 'crew-window').status, 'fail');
  assert.equal(check(evaluateScenario({ crewMonth: 10 }), 'crew-window').status, 'fail');
});

test('reported baseline metrics agree with independent raw source arithmetic', () => {
  const r = evaluateScenario();
  assert.equal(r.costUsd, 1953000);
  assert.equal(r.massKg, 7315);
  assert.equal(r.demandKw, 6.42);
  assert.equal(r.budgetMarginUsd, 47000);
  close(r.reliability, 0.871862164992);
  assert.equal(r.averageGenerationKw, 5.54);
  assert.equal(r.averageMarginKw, -0.88);
  assert.equal(r.flightCountLowerBound, 3);
  assert.equal(check(r, 'reliability').status, 'fail');
  assert.equal(check(r, 'average-power').status, 'fail');
  assert.equal(r.status, 'blocked');
});

test('all scope/dedup/upgrade combinations derive totals and keep required lab spend in budget', () => {
  for (const deduplicate of [false,true]) for (const includeLaboratory of [false,true]) for (const fuelCellUpgrade of [false,true]) for (const atmosphereUpgrade of [false,true]) {
    const r = evaluateScenario({ deduplicate, includeLaboratory, fuelCellUpgrade, atmosphereUpgrade });
    const rows = rawRows.filter(row => !deduplicate || row.item_id !== 'EQU-025');
    const selected = rows.filter(row => includeLaboratory || row.module !== 'laboratory');
    const upliftCost = Number(fuelCellUpgrade) * 120000 + Number(atmosphereUpgrade) * 64000;
    const upliftMass = Number(fuelCellUpgrade) * 50 + Number(atmosphereUpgrade) * 30;
    assert.equal(r.costUsd, cost(rows) + upliftCost);
    assert.equal(r.currentPhaseCostUsd, cost(selected) + upliftCost);
    assert.equal(r.deferredCostUsd, includeLaboratory ? 0 : 219000);
    assert.equal(r.currentPhaseCostUsd + r.deferredCostUsd, r.costUsd);
    assert.equal(r.massKg, mass(selected) + upliftMass);
    assert.equal(r.wholeProgramMassKg, mass(rows) + upliftMass);
    assert.equal(r.demandKw, demand(selected));
    assert.equal(r.wholeProgramDemandKw, demand(rows));
    assert.equal(r.flightCountLowerBound, Math.ceil((mass(selected) + upliftMass) / 3400));
    assert.equal(r.budgetMarginUsd, 2000000 - cost(rows) - upliftCost);
    close(r.reliability, fuelCellUpgrade ? atmosphereUpgrade ? 0.9112201914816 : 0.894449267712 : atmosphereUpgrade ? 0.8882095805856 : 0.871862164992);
    assert.equal(check(r, 'reliability').status, fuelCellUpgrade && atmosphereUpgrade ? 'pass' : 'fail');
  }
});

test('funded reliability upgrades cannot borrow another scenario’s affordable cost', () => {
  const r = evaluateScenario({ fuelCellUpgrade: true, atmosphereUpgrade: true });
  assert.equal(r.costUsd, 2137000);
  assert.equal(r.massKg, 7395);
  close(r.reliability, 0.9112201914816);
  assert.equal(r.budgetMarginUsd, -137000);
  assert.equal(check(r, 'budget').status, 'fail');
  assert.equal(check(r, 'reliability').status, 'pass');
  assert.equal(r.status, 'blocked');
  const deferred = evaluateScenario({ fuelCellUpgrade: true, atmosphereUpgrade: true, includeLaboratory: false });
  assert.equal(deferred.currentPhaseCostUsd, 1918000);
  assert.equal(deferred.costUsd, 2137000);
  assert.equal(check(deferred, 'budget').status, 'fail');
  assert.equal(check(deferred, 'laboratory').status, 'unknown');
  assert.match(check(deferred, 'laboratory').detail, /month|schedule/);
});

test('15-percent budget follow-up and held-out numeric variants recompute exact margins', () => {
  const reduced = evaluateScenario({ budgetUsd: 2000000 * 0.85, fuelCellUpgrade: true, atmosphereUpgrade: true });
  assert.equal(reduced.scenario.budgetUsd, 1700000);
  assert.equal(reduced.budgetMarginUsd, -437000);
  for (const budgetUsd of [1637429, 1952999, 1953000, 2073117, 2136999, 2137000, 2469123]) {
    const r = evaluateScenario({ budgetUsd, fuelCellUpgrade: true, atmosphereUpgrade: true });
    assert.equal(r.budgetMarginUsd, budgetUsd - 2137000);
    assert.equal(check(r, 'budget').status, budgetUsd >= 2137000 ? 'pass' : 'fail');
    assert.equal(r.costUsd, 2137000);
    close(r.reliability, 0.9112201914816);
  }
});

test('physical source precedence resolves 4.0 to 4.7 without granting continuous-power compliance', async () => {
  const engineering = await readFile(new URL('data/DOC-03.txt', root), 'utf8');
  assert.match(engineering, /THIS SUPERSEDES the 4\.0 kW/);
  assert.match(engineering, /4\.7 kW continuous/);
  const r = evaluateScenario({ includeLaboratory: false });
  assert.equal(r.crewThresholdKw, 4.7);
  assert.equal(check(r, 'power-precedence').status, 'pass');
  assert.match(check(r, 'power-precedence').source, /DOC-03/);
  assert.equal(r.demandKw, 4.87);
  assert.equal(r.averageMarginKw, 0.67);
  assert.equal(check(r, 'average-power').status, 'pass');
  assert.equal(check(r, 'continuous-power').status, 'unknown');
  assert.match(check(r, 'continuous-power').detail, /night duration/);
  assert.match(check(r, 'average-power').detail, /second is a spare/);
});

test('relay dates are explicit alternatives and changing them changes the schedule test', () => {
  const commercial = evaluateScenario({ crewMonth: 14, relayMonth: 12 });
  const operations = evaluateScenario({ crewMonth: 14, relayMonth: 14 });
  assert.equal(check(commercial, 'relay').status, 'pass');
  assert.equal(check(operations, 'relay').status, 'fail');
  assert.notEqual(commercial.scenarioId, operations.scenarioId);
  for (const crewMonth of [11,13,14,15,17,18]) for (const relayMonth of [9,12,13,14,16,19]) {
    const r = evaluateScenario({ crewMonth, relayMonth });
    assert.equal(check(r, 'relay').status, relayMonth >= 12 && relayMonth <= crewMonth - 1 ? 'pass' : 'fail');
    assert.equal(r.earliestCrewMonth, Math.max(11, relayMonth + 1, 13));
    assert.equal(r.nonLabDeliveryMonth, 16);
    assert.equal(check(r, 'known-lead-times').status, 'unknown');
    assert.equal(check(r, 'deployment-schedule').status, 'unknown');
  }
  assert.equal(check(commercial, 'known-lead-times').status, 'unknown');
  assert.match(check(operations, 'relay').detail, /not resolved by physical-limit precedence/);
});

test('optical backup month-16 lead does not alone fail month-14 crew readiness', () => {
  const r = evaluateScenario({ crewMonth: 14, relayMonth: 12, budgetUsd: 3000000, includeLaboratory: false, fuelCellUpgrade: true, atmosphereUpgrade: true });
  assert.equal(r.earliestCrewMonth, 13);
  assert.equal(r.nonLabDeliveryMonth, 16);
  assert.equal(check(r, 'crew-window').status, 'pass');
  assert.equal(check(r, 'relay').status, 'pass');
  assert.equal(check(r, 'known-lead-times').status, 'unknown');
  assert.match(check(r, 'known-lead-times').detail, /Sources do not allocate each item to a required pre-crew phase/);
  assert.match(check(r, 'known-lead-times').detail, /commissioning/);
  assert.ok(r.checks.every(c => c.status !== 'fail'));
  assert.equal(r.status, 'unverified');
  const brief = buildBrief(r.scenario);
  assert.match(brief, /Crew arithmetic lower bound from explicit timing rules only: month 13/);
  assert.match(brief, /non-lab equipment modeled delivery lower bound: month 16/);
  assert.match(brief, /not a mandatory pre-crew delivery requirement/);
});

test('missing EQU-021, unapproved dedup and order assumptions stay unknown', () => {
  for (const deduplicate of [false,true]) {
    const r = evaluateScenario({ deduplicate, budgetUsd: 10000000, crewMonth: 18, relayMonth: 12 });
    assert.equal(check(r, 'missing-lead-time').status, 'unknown');
    assert.match(check(r, 'missing-lead-time').detail, /EQU-021/);
    assert.equal(check(r, 'deduplication').status, 'unknown');
    assert.equal(check(r, 'procurement').status, 'unknown');
    assert.equal(check(r, 'laboratory').status, 'unknown');
    assert.equal(check(r, 'site-clearance').status, 'unknown');
  }
});

test('flight grouping accounts for upgrade mass and never certifies schedule compliance', () => {
  for (const strategy of STRATEGIES.map(s => s.id)) {
    const r = evaluateScenario({ strategy, fuelCellUpgrade: true, atmosphereUpgrade: true });
    assert.equal(r.flightGroups.reduce((sum, group) => sum + group.massKg, 0), r.massKg);
    assert.equal(check(r, 'flight-mass').status, r.flightGroups.every(group => group.massKg <= 3400) ? 'pass' : 'fail');
    assert.equal(check(r, 'deployment-schedule').status, 'unknown');
    assert.match(check(r, 'flight-mass').detail, /not certified/);
  }
  const rawAnchor = evaluateScenario({ strategy: 'anchor-first', deduplicate: false, fuelCellUpgrade: true });
  assert.equal(check(rawAnchor, 'flight-mass').status, 'fail');
  assert.ok(rawAnchor.flightGroups.some(group => group.massKg > 3400));
  assert.equal(rawAnchor.flightCountLowerBound, 3); // Lower bound alone cannot validate proposed packing.
});

test('comparison uses original crew/upgrade assignments and predictably inherits explicit scope and budget', () => {
  const input = { budgetUsd: 1837913, relayMonth: 13, deduplicate: false, includeLaboratory: false, crewMonth: 17, fuelCellUpgrade: true, atmosphereUpgrade: true };
  const comparison = comparisonScenarios(input);
  assert.deepEqual(comparison.map(({ id, result }) => [id,result.scenario.crewMonth,result.scenario.fuelCellUpgrade,result.scenario.atmosphereUpgrade]), [
    ['anchor-first',14,false,false], ['power-first',18,false,false], ['parallel-sprint',11,true,false],
  ]);
  for (const { result } of comparison) {
    for (const key of ['budgetUsd','relayMonth','deduplicate','includeLaboratory']) assert.equal(result.scenario[key], input[key]);
    assert.deepEqual(result, evaluateScenario(result.scenario));
    assert.equal(result.costUsd, 2005000 + (result.scenario.fuelCellUpgrade ? 120000 : 0));
  }
});

test('no unknown mandatory outcome can be promoted to fully feasible even with ample money', () => {
  const r = evaluateScenario({ budgetUsd: 3000000, includeLaboratory: false, fuelCellUpgrade: true, atmosphereUpgrade: true });
  assert.ok(r.checks.every(c => c.status !== 'fail'));
  assert.ok(r.checks.some(c => c.status === 'unknown'));
  assert.equal(r.status, 'unverified');
  assert.match(r.headline, /Unverified/);
  assert.match(r.summary, /No verified feasible plan/);
  for (const c of r.checks) {
    assert.ok(['pass','fail','unknown'].includes(c.status));
    assert.ok(c.label && c.detail && c.source);
  }
  assert.equal(new Set(r.checks.map(c => c.id)).size, r.checks.length);
});

test('brief contains the exact current result and all check details, including follow-up variants', () => {
  for (const input of [{}, { budgetUsd: 1700000, fuelCellUpgrade: true, atmosphereUpgrade: true }, { budgetUsd: 2234567, relayMonth: 17, includeLaboratory: false, deduplicate: false, fuelCellUpgrade: true }, { budgetUsd: 3000000, includeLaboratory: false, fuelCellUpgrade: true, atmosphereUpgrade: true }]) {
    const r = evaluateScenario(input);
    const brief = buildBrief(input);
    assert.ok(brief.includes(r.headline));
    assert.ok(brief.includes(r.summary));
    assert.ok(brief.includes(r.scenarioId));
    for (const metric of [r.costUsd,r.scenario.budgetUsd,r.budgetMarginUsd,r.currentPhaseCostUsd,r.deferredCostUsd,r.upgradeCostUsd]) assert.ok(brief.includes(`USD ${metric.toLocaleString('en-US')}`));
    for (const metric of [r.demandKw,r.wholeProgramDemandKw,r.averageGenerationKw,r.averageMarginKw]) assert.ok(brief.includes(`${metric.toFixed(2)} kW`));
    assert.ok(brief.includes(r.reliability.toFixed(13)));
    assert.ok(brief.includes(`Selected mass: ${r.massKg} kg`));
    assert.ok(brief.includes(`month ${r.earliestCrewMonth}`));
    for (const c of r.checks) assert.ok(brief.includes(`**${c.status.toUpperCase()} — ${c.label}:** ${c.detail} (${c.source})`));
    for (const citation of r.citations) assert.ok(brief.includes(citation.sha256));
    assert.match(brief, /Continuous supply remains unknown/);
    assert.match(brief, /not permanent elimination/);
  }
  assert.notEqual(buildBrief({ budgetUsd: 1700000 }), buildBrief({ budgetUsd: 1700001 }));
});
