// Read-only desks. Inputs are the public projection, never raw snapshot rows.
const desks = [
  { tab: 'Work', scope: 'job', kinds: ['job'], title: 'Jobs on record', note: 'Task counts and base revisions come from the pipeline. A recorded job has no job-level verdict.' },
  { tab: 'Workers', scope: 'attempt', kinds: ['attempt'], title: 'Worker attempts', note: 'Each entry is a reported attempt. Its route does not establish a worker identity or a dispatch binding.' },
  { tab: 'Queue', scope: 'queue', kinds: ['backlog', 'bottleneck'], title: 'Queue & pressure', note: 'Feature states, dependencies and station pressure. A queue observation does not authorize dispatch.' },
  { tab: 'Decisions', scope: 'decision', kinds: ['decision'], title: 'Owner decisions', note: 'Reported requests from the decision queue. A signature or consumption receipt is not supplied.' },
  { tab: 'Evidence', scope: 'evidence', kinds: ['ci', 'failure', 'event'], title: 'Evidence register', note: 'Inspect pull requests, failures and recorded events. Release qualification has its own dossier.' },
  { tab: 'Usage', scope: 'usage', kinds: ['usage'], title: 'Usage & pricing', note: 'Reported requests, tokens and list-price subtotals. Unpriced requests are not free.' },
  { tab: 'All', scope: 'all', kinds: [], title: 'All work records', note: 'Search across every projected job, attempt, queue item, decision, evidence and usage record.' },
];
const scopes = {
  job: 'Jobs', attempt: 'Attempts', queue: 'Queue records', backlog: 'Backlog', bottleneck: 'Station pressure',
  decision: 'Decisions', evidence: 'Evidence records', ci: 'Pull requests', failure: 'Failures', event: 'Recorded events',
  usage: 'Usage', all: 'All objects',
};
const sourceNames = { job: 'pipeline', attempt: 'fleet', backlog: 'backlog', bottleneck: 'bottlenecks', decision: 'decisions', ci: 'ci', failure: 'failures', usage: 'usage' };
const activeStates = new Set(['starting', 'running', 'working', 'backoff']);
const PAGE = 24, HOME = 6, QUERY = 120;
const known = s => typeof s === 'string' && s.trim() !== '' && s.toLowerCase() !== 'unknown';
const titleCase = s => s.charAt(0).toUpperCase() + s.slice(1);
const human = s => titleCase(s.replace(/[_-]+/g, ' '));
const label = r => r.kind === 'attempt' ? (known(r.detail) ? r.detail : known(r.taskId) ? human(r.taskId) : 'Task unknown')
  : r.kind === 'job' && r.title === `Job ${r.jobId}` && known(r.jobId) ? human(r.jobId) : r.title || r.id;
const idKey = r => `${r.kind}:${r.id}`;
const date = s => typeof s === 'string' && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : '';
const timeOf = (at, snapshot) => {
  const t = date(at);
  return t ? (t.slice(0, 10) === date(snapshot).slice(0, 10) ? t.slice(11, 19) : t.slice(0, 16).replace('T', ' ')) : 'Unknown';
};
const timeKey = at => Number.isFinite(Date.parse(at)) ? Date.parse(at) : -Infinity;
const newer = (a, b) => timeKey(b.at) - timeKey(a.at) || a.id.localeCompare(b.id);
const boundedRows = (arr, cap) => (Array.isArray(arr) ? arr.slice(0, cap) : []).filter(r => known(r?.id));
const write = (node, text) => { if (node.textContent !== text) node.textContent = text; };

export function createWorkbench({ root, shift, onChoose, onRelease }) {
  const doc = root.ownerDocument;
  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const button = (text, cls, fn) => {
    const b = el('button', cls, text);
    b.type = 'button'; b.addEventListener('click', fn); return b;
  };
  const labelled = (caption, control) => {
    const n = el('label', 'hw-field'); n.append(el('span', '', caption), control); return n;
  };
  const select = (id, options) => {
    const control = el('select'); control.id = id;
    for (const [value, text] of Object.entries(options)) {
      const option = el('option', '', text); option.value = value; control.append(option);
    }
    return control;
  };
  const heading = (kicker, title) => {
    const head = el('header', 'hw-head'), box = el('div');
    box.append(el('small', 'hw-kicker', kicker), title); head.append(box); return head;
  };
  const columns = names => {
    const line = el('div', 'hw-columns'); line.setAttribute('aria-hidden', 'true');
    for (const name of names) line.append(el('span', '', name));
    return line;
  };
  let view = null, historical = false, demo = false, all = [], fleet = [], page = 0, lastPick = null;
  let desk = desks[0], queueShown = null, queueEpoch = 0, docket=null;
  const section = name => view?.sections?.find(r => r.id === name)?.state;
  const old = r => historical || (r.quality && r.quality !== 'live' && r.quality !== 'known') ||
    ['stale', 'unavailable', 'absent'].includes(section(sourceNames[r.kind]));
  const confirmedFleet = () => !historical && section('fleet') === 'live' && Number.isInteger(view?.metrics?.active);
  const inFlight = r => confirmedFleet() && r.quality === 'live' && activeStates.has(r.state);

  const title = el('h2'), head = heading('Operations / Workbench', title), basis = el('span', 'hw-basis');
  head.append(basis);
  const tabs = el('div', 'hw-tabs'), panels = el('div', 'hw-panels'), content = el('div');
  tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Workbench registers');
  const switches = desks.map((d, i) => {
    const tab = button(d.tab, 'hw-tab', () => setScope(d.scope)), panel = el('section');
    tab.id = `hw-tab-${d.scope}`; panel.id = `hw-panel-${d.scope}`;
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', panel.id);
    panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id);
    tab.addEventListener('keydown', e => {
      const index = { ArrowLeft: (i + desks.length - 1) % desks.length, ArrowRight: (i + 1) % desks.length, Home: 0, End: desks.length - 1 }[e.key];
      if (index == null) return;
      e.preventDefault(); setScope(desks[index].scope); switches[index].tab.focus();
    });
    tabs.append(tab); panels.append(panel); return { d, tab, panel };
  });
  const filters = el('div', 'hw-filters'), search = el('input'), scope = select('scope', scopes);
  search.id = 'search'; search.type = 'search'; search.maxLength = QUERY; search.placeholder = 'ID, task, route or source…';
  const sort = select('hw-sort', { recent: 'Last observed', name: 'Name · A to Z', state: 'State · A to Z' });
  filters.append(labelled('Find a record', search), labelled('Scope', scope), labelled('Sort by', sort));
  const note = el('p', 'hw-note'), info = el('div', 'hw-register-info'), count = el('span', 'hw-count'), source = el('span', 'hw-source');
  count.id = 'result-count'; count.setAttribute('role', 'status'); info.append(count, source);
  const list = el('ul', 'hw-list'); list.id = 'rows';
  const empty = el('p', 'hw-empty'), foot = el('div', 'hw-pages');
  const prev = button('← Previous', 'hw-turn', () => turn(-1)), next = button('Next records →', 'hw-turn', () => turn(1));
  next.id = 'more'; foot.append(prev, next);
  const queue = el('section', 'hw-queue'), release = button('Open release dossier ↗', 'hw-link', () => {
    lastPick = { release: true }; onRelease?.();
  });
  const headers = columns(['Record / public ID', 'Source observation', 'State', 'Observed · UTC']);
  queue.id='queue-evidence';
  content.append(note, filters, info, headers, list, empty, foot, release, queue);
  root.classList.add('hw-work'); root.replaceChildren(head, tabs, panels);

  const shiftTitle = el('h2', '', 'Current assignments'), shiftHead = heading('Shift / Attempt ledger', shiftTitle);
  const tally = el('span', 'hw-basis'), shiftList = el('ul', 'hw-list'), shiftEmpty = el('p', 'hw-empty');
  const shiftNote = el('p', 'hw-ledger-note'), shiftCols = columns(['Task / attempt', 'Route / job', 'State', 'Observed · UTC']);
  shiftHead.append(tally); shiftList.setAttribute('aria-label', 'Observed worker attempts');
  shift.classList.add('hw-shift'); shift.replaceChildren(shiftHead, shiftCols, shiftList, shiftEmpty, shiftNote);

  // Reuse native buttons even if a refresh changes their time, content or sort order.
  // Keep no detached rows or callbacks holding prior projections after a reset.
  function reconcile(ul, items, home) {
    const by = new Map([...ul.children].map(n => [n.dataset.key, n]));
    const focused = doc.activeElement, hadFocus = ul.contains(focused);
    for (const [i, r] of items.entries()) {
      const key = idKey(r);
      let li = by.get(key);
      if (li) by.delete(key);
      else {
        li = el('li'); li.dataset.key = key;
        const kind = r.kind, id = r.id;
        const b = button('', home ? 'hw-row' : 'hw-row obj', () => {
          if (!ul.contains(li)) return;
          lastPick = { key, home }; onChoose?.({ kind, id });
        });
        const pair = (cls, first) => { const span = el('span', cls); span.append(el(first), el('small')); return span; };
        b.append(pair('hw-ident', 'strong'), pair('hw-detail', 'span'), pair('hw-state', 'span'), el('span', 'hw-time'));
        li.append(b);
      }
      const b = li.firstElementChild, [name, detail, state, time] = b.children;
      const attempt = r.kind === 'attempt';
      write(name.children[0], label(r)); write(name.children[1], attempt && known(r.taskId) ? `${r.taskId} / ${r.id}` : r.id);
      write(detail.children[0], attempt ? (r.route || 'Route unknown') : (r.detail || 'No detail reported'));
      write(detail.children[1], attempt ? `Job: ${r.jobId || 'unknown'}${!home && r.repo ? ` · ${r.repo}` : ''}` : r.source || 'Source unknown');
      const recordedState = known(r.state) ? r.state : 'unknown';
      const active = attempt && inFlight(r);
      const qualifier = old(r) ? 'Last observed' : active ? 'Active' : attempt ? (activeStates.has(recordedState) ? 'Unconfirmed' : 'Recent record') : r.kind;
      write(state.children[0], titleCase(recordedState)); write(state.children[1], qualifier);
      state.dataset.active = String(active);
      write(time, timeOf(r.at, view?.generatedAt)); time.title = date(r.at) || 'Observation time unknown';
      b.setAttribute('aria-label', [label(r), `${r.kind} ${r.id}`, attempt ? `Task: ${r.taskId || 'unknown'}. Route: ${r.route || 'unknown'}.` : detail.children[0].textContent,
        detail.children[1].textContent, `State: ${recordedState}. ${qualifier}.`, `Observed: ${time.title}`].join(' '));
      if (ul.children[i] !== li) ul.insertBefore(li, ul.children[i] || null);
    }
    for (const n of by.values()) n.remove();
    if (hadFocus && doc.activeElement !== focused) {
      const fallback = home ? shiftTitle : search;
      (ul.contains(focused) ? focused : fallback).focus({ preventScroll: true });
    }
  }

  function drawShift() {
    const measured = confirmedFleet();
    const active = fleet.filter(inFlight).sort(newer), recent = fleet.filter(r => !inFlight(r)).sort(newer);
    const take = Math.min(active.length, HOME - Math.min(recent.length, 2));
    const shown = [...active.slice(0, take), ...recent.slice(0, HOME - take)];
    write(shiftTitle, historical || (section('fleet') && section('fleet') !== 'live') ? 'Last observed assignments' : 'Current assignments');
    write(tally, measured ? `${view.metrics.active} in flight` : 'In flight unknown');
    shiftCols.hidden = !fleet.length; shiftEmpty.hidden = !!fleet.length;
    write(shiftEmpty, 'No public attempts in this observation.');
    write(shiftNote, `${shown.length} of ${fleet.length} public attempts shown · Time is the source observation. Elapsed time and worker binding are not supplied.`);
    reconcile(shiftList, shown, true);
  }

  // The simulated reconciliation packet has its own provenance. Never attach it
  // to a live host, an interrupted read, a degraded fixture or a replay frame.
  function drawQueue() {
    const eligible = demo && !historical && view?.health === 'live' && section('backlog') === 'live' && section('pipeline') === 'live';
    const mode = desk.scope !== 'queue' ? 'off' : docket && !demo && !historical ? 'enrolled' : eligible ? 'fixture' : 'unavailable';
    if (mode === queueShown) return;
    queueShown = mode; const epoch = ++queueEpoch;
    queue.replaceChildren(); queue.hidden = mode === 'off';
    if(mode==='enrolled') {
      content.insertBefore(queue,note);
      import('./queue-provider.js').then(({renderQueueDocket})=>{if(epoch===queueEpoch)renderQueueDocket(queue,docket);}).catch(()=>{if(epoch===queueEpoch)write(queue,'Enrolled queue report unavailable.');});
    } else if (mode === 'unavailable') {
      queue.append(el('h3', '', 'Draft reconciliation'), el('p', '', 'No confirmed queue-evidence reader for this observation.'));
    } else if (mode === 'fixture') {
      import('./queue-desk.js').then(({ renderQueueDesk }) => {
        if (epoch === queueEpoch) renderQueueDesk(queue, { demo: true });
      }).catch(() => {
        if (epoch === queueEpoch) write(queue, 'Draft reconciliation evidence unavailable.');
      });
    }
  }

  function drawRegister() {
    const value = scope.value, query = search.value.slice(0, QUERY).trim().toLowerCase();
    const scoped = all.filter(r => value === 'all' || (value === desk.scope ? desk.kinds.includes(r.kind) : r.kind === value));
    const rows = scoped.filter(r => !query || [label(r), r.id, r.kind, r.taskId, r.jobId, r.repo, r.route, r.state, r.source, r.stage, r.detail].some(s => typeof s === 'string' && s.toLowerCase().includes(query)));
    rows.sort((a, b) => {
      if (sort.value === 'name') return label(a).localeCompare(label(b)) || newer(a, b);
      if (sort.value === 'state') return (a.state || '').localeCompare(b.state || '') || newer(a, b);
      return newer(a, b);
    });
    page = Math.max(0, Math.min(page, Math.ceil(rows.length / PAGE) - 1));
    const start = page * PAGE, portion = rows.slice(start, start + PAGE);
    write(title, desk.title); write(note, desk.note);
    write(basis, historical ? 'Historical · last confirmed' : demo ? 'Fixture observation' : view?.generatedAt ? 'Public observation' : 'Awaiting source');
    write(count, rows.length ? `${start + 1}–${start + portion.length} of ${rows.length} matching` : '0 matching records');
    const kinds = value === desk.scope ? desk.kinds : [value];
    const sources = kinds.map(k => sourceNames[k]).filter(Boolean);
    const coverage = sources.map(s => `${titleCase(s)}: ${section(s) || 'unknown'}`).join(' · ');
    write(source, desk.scope === 'usage' ? `${historical ? 'Last observed subtotal' : 'Known subtotal'}: ${Number.isFinite(view?.metrics?.cost) ? `USD ${view.metrics.cost}` : 'unknown'} · ${view?.metrics?.costCoverage || 'pricing coverage unknown'}`
      : historical ? 'Current state unconfirmed' : coverage || 'Public records only');
    write(headers.children[1], desk.scope === 'attempt' ? 'Route / job' : 'Source observation');
    list.setAttribute('aria-label', desk.title);
    headers.hidden = !rows.length; empty.hidden = !!rows.length;
    write(empty, query && scoped.length ? 'No matching records. Try a different ID, route or source.' : 'No public records in this scope. Check source coverage.');
    prev.disabled = page === 0; next.disabled = start + PAGE >= rows.length; foot.hidden = rows.length <= PAGE;
    release.hidden = desk.scope !== 'evidence' || typeof onRelease !== 'function';
    reconcile(list, portion, false); drawQueue();
  }
  function turn(delta) {
    page += delta; drawRegister();
    (list.firstElementChild?.firstElementChild || search).focus();
  }
  function setScope(value) {
    const d = desks.find(d => d.scope === value || d.kinds.includes(value) || d.tab.toLowerCase() === value);
    if (!d) return;
    const focused = doc.activeElement;
    desk = d; scope.value = Object.hasOwn(scopes, value) ? value : d.scope; page = 0;
    for (const { d, tab, panel } of switches) {
      const selected = desk === d;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; panel.hidden = !selected;
      if (selected && content.parentNode !== panel) panel.append(content);
    }
    drawRegister();
    if (focused === scope && doc.activeElement !== scope) scope.focus({ preventScroll: true });
  }
  scope.addEventListener('change', () => setScope(scope.value));
  sort.addEventListener('change', () => { page = 0; drawRegister(); });
  search.addEventListener('input', () => { page = 0; drawRegister(); });
  function update(v, options = {}) {
    const h = !!options.historical, d = options.demo === true;
    if (view === v && historical === h && demo === d) return;
    view = v; historical = h; demo = d;
    fleet = boundedRows(v?.attempts, 100).map(r => ({ ...r, kind: 'attempt' }));
    all = [...fleet, ...boundedRows(v?.records, 200).filter(r => desks.some(d => d.kinds.includes(r.kind)))];
    drawShift(); drawRegister();
  }
  function reset() {
    lastPick = null; view = null; all = []; fleet = []; demo = false; historical = false;docket=null;queueShown=null;
    search.value = ''; sort.value = 'recent'; setScope('job'); drawShift();
  }
  function restoreFocus() {
    const home = lastPick?.home && !shift.closest('[hidden]');
    const ul = home ? shiftList : list;
    const row = [...ul.children].find(n => n.dataset.key === lastPick?.key)?.firstElementChild;
    const target = lastPick?.release && !release.hidden ? release : row || (home ? shiftTitle : search);
    target.focus();
  }
  shiftTitle.tabIndex = -1; reset();
  return { update, reset, setScope, focusSearch: () => search.focus(), restoreFocus,
    setDocket(next){if(next===docket)return;docket=next;queueShown=null;drawQueue();} };
}
