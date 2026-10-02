import { DEFAULT_SCENARIO, STRATEGIES, normalizeScenario, evaluateScenario, comparisonScenarios, buildBrief, scenarioIdentity } from './scenario.mjs';

const $ = (id) => document.getElementById(id);
const form = $('scenario-form');
const usd = (value) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
const decimal = (value, digits = 2) => Number(value).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const percent = (value) => `${decimal(value * 100)}%`;
const signed = (value, format) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${format(Math.abs(value))}`;
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
let generation = 0;
let current = null;
let baseline;
let notificationTimer;
const sourceCache = new Map();
let sourceRequest;
let sourceRevision = 0;
let viewedSource = null;

function populate(scenario) {
  for (const [key, value] of Object.entries(scenario)) {
    const control = form.elements.namedItem(key);
    if (!control) continue;
    if (control.type === 'checkbox') control.checked = value;
    else control.value = value;
  }
}

function readScenario() {
  const input = {};
  for (const key of Object.keys(DEFAULT_SCENARIO)) {
    const control = form.elements.namedItem(key);
    if (control.type === 'checkbox') input[key] = control.checked;
    else if (control.type === 'number') {
      if (control.value.trim() === '' || !control.validity.valid) throw new Error(`Enter a valid ${control.labels[0].childNodes[0].textContent.toLowerCase()}.`);
      input[key] = control.valueAsNumber;
    } else input[key] = control.value;
  }
  return normalizeScenario(input);
}

function metric(title, value, note, delta, options = {}) {
  const card = node('article', 'metric');
  card.append(node('h3', 'metric-label', title));
  const amount = node('p', 'metric-value', value);
  if (options.id) { amount.id = options.id; amount.dataset.testid = options.id; }
  card.append(amount);
  if (options.ratio !== undefined) {
    const bar = node('progress', options.fail ? 'fail' : '');
    bar.max = 1;
    bar.value = Math.max(0, Math.min(1, options.ratio));
    bar.setAttribute('aria-label', options.barLabel);
    card.append(bar);
  }
  card.append(node('p', `metric-note ${options.fail ? 'fail' : options.ratio !== undefined ? 'pass' : ''}`, note));
  card.append(node('p', 'delta', delta));
  return card;
}

function renderMetrics(result) {
  const margin = result.budgetMarginUsd;
  const costNote = margin < 0 ? `${usd(-margin)} above ${usd(result.scenario.budgetUsd)} cap` : `${usd(margin)} remaining · ${usd(result.scenario.budgetUsd)} cap`;
  const cost = metric('Total program equipment', usd(result.costUsd), costNote,
    `${signed(result.costUsd - baseline.costUsd, usd)} vs baseline`, {
      id: 'budget-cost', ratio: result.scenario.budgetUsd / result.costUsd, fail: margin < 0,
      barLabel: `Budget covers ${percent(result.scenario.budgetUsd / result.costUsd)} of total program equipment cost`,
    });
  if (result.currentPhaseCostUsd !== undefined && !result.scenario.includeLaboratory) {
    cost.append(node('p', 'metric-note', `Current phase ${usd(result.currentPhaseCostUsd)} · deferred ${usd(result.deferredCostUsd)}. Total unchanged by deferral.`));
  }
  const reliability = metric('Critical-path reliability', percent(result.reliability),
    `${result.reliability >= result.reliabilityTarget ? 'Meets' : 'Below'} ${percent(result.reliabilityTarget)} target`,
    `${signed((result.reliability - baseline.reliability) * 100, (v) => `${decimal(v)} pp`)} vs baseline`, {
      id: 'reliability-value', ratio: result.reliability / result.reliabilityTarget,
      fail: result.reliability < result.reliabilityTarget, barLabel: `Reliability ${percent(result.reliability)}; target ${percent(result.reliabilityTarget)}`,
    });
  const power = metric('Average power margin', `${signed(result.averageMarginKw, (v) => decimal(v))} kW`,
    `${decimal(result.averageGenerationKw)} kW average · ${decimal(result.demandKw)} kW demand`,
    `${signed(result.averageMarginKw - baseline.averageMarginKw, (v) => `${decimal(v)} kW`)} vs baseline · ${decimal(result.crewThresholdKw, 1)} kW crew threshold`);
  power.append(node('p', 'metric-note', 'Average only · continuous power unverified'));
  power.append(node('p', 'metric-note', `${decimal(result.massKg, 0)} kg manifest · ${result.flightCountLowerBound} flights minimum (mass bound)`));
  $('metrics').replaceChildren(cost, reliability, power);
}

function renderComparisons(comparisons, result) {
  $('comparison').replaceChildren(...comparisons.map((entry) => {
    const candidate = entry.result;
    const selected = scenarioIdentity(candidate.scenario) === scenarioIdentity(result.scenario);
    const card = node('article', `strategy-card${selected ? ' selected' : ''}`);
    card.dataset.strategy = entry.id;
    const content = node('div', 'strategy-card-content');
    const top = node('div', 'strategy-top');
    top.append(node('h3', '', entry.label));
    if (selected) top.append(node('span', 'strategy-tag', 'CURRENT'));
    const numbers = node('div', 'strategy-numbers');
    const cost = node('span', '', usd(candidate.costUsd));
    cost.append(node('small', '', 'TOTAL EQUIPMENT'));
    const reliability = node('span', '', percent(candidate.reliability));
    reliability.append(node('small', '', 'RELIABILITY'));
    numbers.append(cost, reliability);
    const upgrades = [candidate.scenario.fuelCellUpgrade && 'fuel cell', candidate.scenario.atmosphereUpgrade && 'life support'].filter(Boolean);
    content.append(top, numbers,
      node('p', 'strategy-inputs', `Crew M${candidate.scenario.crewMonth} · ${upgrades.length ? upgrades.join(' + ') : 'no reliability upgrades'}`),
      node('p', 'strategy-outcome', `${candidate.status === 'blocked' ? 'Blocked' : 'Unverified'} · crew lower bound M${candidate.earliestCrewMonth}`));
    const button = node('button', '', selected ? `Selected · ${entry.label}` : `Select ${entry.label} →`);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(selected));
    button.addEventListener('click', () => { populate(candidate.scenario); update(); });
    card.append(content, button);
    return card;
  }));
}

function svgNode(tag, attributes, text) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderTimeline(result) {
  const end = Math.max(30, result.scenario.crewMonth + 2, result.scenario.relayMonth + 2, result.earliestCrewMonth + 2);
  const startX = 175;
  const width = 580;
  const x = (month) => startX + month / end * (width - startX - 28);
  const svg = svgNode('svg', { viewBox: `0 0 ${width} 168`, role: 'img', 'aria-labelledby': 'timeline-description' });
  svg.append(svgNode('title', { id: 'timeline-description' }, `Relay available month ${result.scenario.relayMonth}; crew planned month ${result.scenario.crewMonth}; modeled crew lower bound month ${result.earliestCrewMonth}; laboratory required by month 28. The lower bound is not a verified feasible date. Dates do not verify missing lead times or continuous power.`));
  const step = end > 60 ? 20 : end > 36 ? 10 : 6;
  for (let month = 0; month <= end; month += step) {
    svg.append(svgNode('line', { x1: x(month), x2: x(month), y1: 23, y2: 148, class: 'grid-line' }));
    svg.append(svgNode('text', { x: x(month), y: 12, 'text-anchor': 'middle', class: 'axis-label' }, `M${month}`));
  }
  const events = [
    ['Relay available', result.scenario.relayMonth, 'event-dot'],
    ['Crew planned', result.scenario.crewMonth, 'crew-dot'],
    ['Modeled crew lower bound', result.earliestCrewMonth, 'event-dot'],
    ['Laboratory deadline', 28, 'event-dot'],
  ];
  events.forEach(([label, month, dot], index) => {
    const y = 38 + index * 34;
    svg.append(svgNode('text', { x: 0, y: y + 4, class: 'event-label' }, label));
    svg.append(svgNode('line', { x1: startX, x2: width - 28, y1: y, y2: y, class: 'track' }));
    svg.append(svgNode('circle', { cx: x(month), cy: y, r: 4, class: dot }));
    svg.append(svgNode('text', { x: x(month), y: y - 9, 'text-anchor': 'middle', class: 'event-month' }, `M${month}`));
  });
  $('scenario-timeline').replaceChildren(svg);
  $('schedule-caption').textContent = STRATEGIES.find((s) => s.id === result.scenario.strategy)?.label || result.scenario.strategy;
  $('schedule-note').textContent = `Crew ${result.scenario.crewMonth < result.earliestCrewMonth ? 'precedes' : 'meets'} the modeled lower bound (M${result.earliestCrewMonth}), not a verified feasible date. Equipment lead times and commissioning remain evidence gates.`;
  $('flight-groups').replaceChildren(...(result.flightGroups || []).map((group) => {
    const card = node('div', `flight-group ${group.withinLimit ? 'pass' : 'fail'}`);
    card.append(node('strong', '', `${group.id.replace('flight-', 'Group ')} · ${decimal(group.massKg, 0)} kg`),
      node('p', '', group.modules.map((name) => name.replaceAll('_', ' ')).join(' / ')),
      node('small', '', group.withinLimit ? 'Within modeled mass limit' : 'Exceeds modeled mass limit'));
    return card;
  }));
}

function safeSourceHref(href) {
  // Sources are bundled public synthetic files; no external navigation is needed.
  return typeof href === 'string' && /^\.\/data\/[A-Za-z0-9_.-]+(?:#[A-Za-z0-9_.-]+)?$/.test(href) ? href : null;
}

function evidenceLink(citation, className, label) {
  const href = safeSourceHref(citation.href);
  const link = node(href ? 'a' : 'span', className, label);
  if (href) {
    link.href = href;
    link.setAttribute('aria-haspopup', 'dialog');
    link.addEventListener('click', (event) => {
      event.preventDefault();
      openEvidence(citation);
    });
  }
  return link;
}

async function openEvidence(citation) {
  const href = safeSourceHref(citation.href);
  if (!href) return;
  const revision = ++sourceRevision;
  sourceRequest?.abort();
  sourceRequest = new AbortController();
  viewedSource = null;
  $('evidence-download').disabled = true;
  $('evidence-title').textContent = citation.label;
  $('evidence-status').textContent = `Loading ${citation.id} from the published source bundle…`;
  $('evidence-text').textContent = '';
  $('evidence-hash').textContent = citation.sha256 ? `Source SHA-256: ${citation.sha256}` : '';
  $('evidence-dialog').setAttribute('aria-busy', 'true');
  if (!$('evidence-dialog').open) $('evidence-dialog').showModal();
  try {
    let text = sourceCache.get(href);
    if (text === undefined) {
      const response = await fetch(new URL(href, location.href), {
        credentials: 'omit', mode: 'cors', redirect: 'error', signal: sourceRequest.signal,
      });
      if (!response.ok) throw new Error(`Source request returned HTTP ${response.status}.`);
      text = await response.text();
      sourceCache.set(href, text);
    }
    if (revision !== sourceRevision || !$('evidence-dialog').open) return;
    viewedSource = { citation, text };
    $('evidence-text').textContent = text;
    $('evidence-text').scrollTop = 0;
    $('evidence-status').textContent = `${citation.id} · bundled public evidence. Your scenario is preserved.`;
    $('evidence-download').disabled = false;
  } catch (error) {
    if (revision !== sourceRevision || error.name === 'AbortError') return;
    $('evidence-status').textContent = `Unable to read this bundled source. ${error.message}`;
  } finally {
    if (revision === sourceRevision) $('evidence-dialog').setAttribute('aria-busy', 'false');
  }
}

$('evidence-close').addEventListener('click', () => $('evidence-dialog').close());
$('evidence-dialog').addEventListener('close', () => {
  ++sourceRevision;
  sourceRequest?.abort();
  viewedSource = null;
  $('evidence-dialog').setAttribute('aria-busy', 'false');
});
$('evidence-download').addEventListener('click', () => {
  if (!viewedSource) return;
  const { citation, text } = viewedSource;
  const filename = safeSourceHref(citation.href).split('/').pop().split('#')[0];
  download(text, filename, filename.endsWith('.csv') ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8');
});

function renderEvidence(result, identity) {
  $('checks').replaceChildren(...result.checks.map((check) => {
    const row = node('div', `check ${check.status}`);
    row.dataset.check = check.id;
    const icon = node('span', 'check-icon', check.status === 'pass' ? '✓' : check.status === 'fail' ? '×' : '?');
    icon.setAttribute('aria-hidden', 'true');
    const details = node('details');
    const summary = node('summary', '', check.label);
    summary.append(node('span', 'sr-only', ` — ${check.status}`));
    details.append(summary, node('p', 'check-detail', check.detail));
    const sourceText = Array.isArray(check.source) ? check.source.join(', ') : typeof check.source === 'string' ? check.source : JSON.stringify(check.source);
    if (sourceText) details.append(node('p', 'check-source muted', `Evidence · ${sourceText}`));
    const links = node('div', 'evidence-links');
    for (const citation of result.citations.filter((item) => sourceText?.includes(item.id))) {
      const href = safeSourceHref(citation.href);
      if (!href) continue;
      const link = evidenceLink(citation, 'check-source', citation.id);
      link.setAttribute('aria-label', `Open ${citation.label} for ${check.label}`);
      links.append(link);
    }
    details.append(links);
    row.append(icon, details);
    return row;
  }));
  $('assumptions').replaceChildren(...result.assumptions.map((text) => node('li', '', text)));
  $('citations').replaceChildren(...result.citations.map((citation) => evidenceLink(citation, '', citation.label)));
  $('model-version').textContent = result.modelVersion;
  $('input-identity').textContent = identity;
  $('source-fingerprint').textContent = result.inputSha256;
}

function setExports(enabled) {
  $('export-brief').disabled = !enabled;
  $('export-json').disabled = !enabled;
}

async function update() {
  const revision = ++generation;
  current = null;
  setExports(false);
  $('scenario-result').setAttribute('aria-busy', 'true');
  $('input-error').hidden = true;
  $('decision-status').textContent = 'Evaluating';
  $('decision-headline').textContent = 'Updating the mission decision…';
  $('decision-summary').textContent = 'Recomputing the current constraints and deployment alternatives.';
  // Remove old conclusions immediately, including plots and evidence.
  for (const id of ['metrics', 'comparison', 'scenario-timeline', 'flight-groups', 'checks', 'decision-counts', 'assumptions', 'citations']) $(id).replaceChildren();
  for (const id of ['schedule-note', 'schedule-caption', 'model-version', 'input-identity', 'source-fingerprint', 'decision-interpretation']) $(id).textContent = '';
  try {
    const scenario = readScenario();
    const [result, comparisons] = await Promise.all([evaluateScenario(scenario), comparisonScenarios(scenario)]);
    if (revision !== generation) return;
    const identity = scenarioIdentity(result.scenario);
    current = { result, identity, comparisons };
    $('decision-status').textContent = result.status === 'blocked' ? 'Decision blocked' : 'Not yet verified';
    $('decision-headline').textContent = result.headline;
    $('decision-summary').textContent = result.summary;
    const failedLabels = result.checks.filter((check) => check.status === 'fail').map((check) => check.label);
    const unknownLabels = result.checks.filter((check) => check.status === 'unknown').map((check) => check.label);
    $('decision-interpretation').textContent = failedLabels.length
      ? `Resolve these failed gates: ${failedLabels.join('; ')}. Passing them still leaves unverified evidence gates.`
      : `Calculated gates pass; verification is still needed for ${unknownLabels.slice(0, 2).join(' and ')}${unknownLabels.length > 2 ? ' and the remaining evidence gates' : ''}.`;
    $('decision-counts').replaceChildren(...['fail', 'unknown', 'pass'].map((status) => {
      const count = result.checks.filter((check) => check.status === status).length;
      return node('span', `gate-count ${status}`, `${count} ${status === 'fail' ? 'blocked' : status === 'unknown' ? 'unverified' : 'passed'} gates`);
    }));
    renderMetrics(result);
    renderComparisons(comparisons, result);
    renderTimeline(result);
    renderEvidence(result, identity);
    document.querySelectorAll('[data-relay]').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.relay) === scenario.relayMonth)));
    setExports(true);
    $('announcement').textContent = `${result.headline}. Equipment ${usd(result.costUsd)}. Reliability ${percent(result.reliability)}.`;
  } catch (error) {
    if (revision !== generation) return;
    $('input-error').textContent = error.message || 'The scenario could not be evaluated.';
    $('input-error').hidden = false;
    $('decision-status').textContent = 'Input needed';
    $('decision-headline').textContent = 'Complete the scenario to continue.';
    $('decision-summary').textContent = 'Correct the highlighted input before assessing or exporting this mission.';
    $('announcement').textContent = $('input-error').textContent;
  } finally {
    if (revision === generation) $('scenario-result').setAttribute('aria-busy', 'false');
  }
}

function download(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = node('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  $('export-message').hidden = false;
  $('export-message').textContent = `Download requested: ${filename}`;
  clearTimeout(notificationTimer);
  notificationTimer = setTimeout(() => { $('export-message').hidden = true; }, 5000);
}

form.addEventListener('submit', (event) => event.preventDefault());
form.addEventListener('input', update);
$('budget-cut').addEventListener('click', () => { form.elements.budgetUsd.value = 1700000; update(); });
$('both-upgrades').addEventListener('click', () => {
  form.elements.fuelCellUpgrade.checked = true;
  form.elements.atmosphereUpgrade.checked = true;
  update();
});
$('reset').addEventListener('click', () => { populate(DEFAULT_SCENARIO); update(); });
document.querySelectorAll('[data-relay]').forEach((button) => button.addEventListener('click', () => {
  form.elements.relayMonth.value = button.dataset.relay;
  update();
}));
$('export-json').addEventListener('click', () => {
  if (!current) return;
  download(JSON.stringify({ scenarioIdentity: current.identity, result: current.result, comparisons: current.comparisons }, null, 2), 'asteria-scenario.json', 'application/json');
});
$('export-brief').addEventListener('click', async () => {
  if (!current) return;
  const snapshot = current;
  try {
    let brief = await buildBrief(snapshot.result.scenario);
    for (const citation of snapshot.result.citations) {
      const href = safeSourceHref(citation.href);
      if (href) brief = brief.replaceAll(`](${href})`, `](${new URL(href, location.href).href})`);
    }
    if (snapshot !== current) return;
    download(brief, 'asteria-decision-brief.md', 'text/markdown;charset=utf-8');
  } catch (error) {
    $('export-message').hidden = false;
    $('export-message').textContent = `Export failed: ${error.message}`;
  }
});

async function initialize() {
  $('strategy').replaceChildren(...STRATEGIES.map((strategy) => {
    const option = node('option', '', strategy.label);
    option.value = strategy.id;
    return option;
  }));
  populate(DEFAULT_SCENARIO);
  try {
    baseline = await evaluateScenario(DEFAULT_SCENARIO);
    await update();
  } catch (error) {
    $('decision-status').textContent = 'Model unavailable';
    $('decision-headline').textContent = 'The mission model could not initialize.';
    $('decision-summary').textContent = error.message;
    $('scenario-result').setAttribute('aria-busy', 'false');
  }
}
initialize();
