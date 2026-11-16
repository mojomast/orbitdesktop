// Rizzstack Observatory — static, catalog-admissible viewer for the
// rizzstack.observability/snapshot/1 document.
//
// No build step, no remote assets, no inline scripts, no credentials in code.
// The snapshot URL is configuration (plugin config fragment, in-app setting,
// or the ./snapshot.json default). The bearer token is operator-entered once
// and kept in localStorage only; it is never placed in code, config fragments,
// URLs or console output, and this module never logs.
'use strict';
(function (global) {
  const SNAPSHOT_SCHEMA = 'rizzstack.observability/snapshot/1';
  const TOKEN_STORAGE_KEY = 'rizzstack.observatory.token';
  const URL_STORAGE_KEY = 'rizzstack.observatory.snapshot_url';
  const DEFAULT_SNAPSHOT_URL = './snapshot.json';
  const CONFIG_FRAGMENT_PREFIX = '#orbit-config=';
  const STALE_AFTER_MS = 10 * 60 * 1000;
  const REFRESH_INTERVAL_MS = 30000;
  const FLEET_COLUMNS = ['id', 'branch', 'model', 'state', 'elapsed'];

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function pick(obj, keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const key of keys) {
      const value = obj[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  }

  function firstDefined(obj, keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const key of keys) if (obj[key] !== undefined) return obj[key];
    return undefined;
  }

  function parseTimestamp(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number') return isFinite(value) ? (value > 1e12 ? value : value * 1000) : null;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      return isFinite(n) ? (n > 1e12 ? n : n * 1000) : null;
    }
    const parsed = Date.parse(trimmed);
    return isFinite(parsed) ? parsed : null;
  }

  function elapsedLabel(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—';
    const totalSeconds = Math.floor(ms / 1000);
    if (totalSeconds < 60) return totalSeconds + 's';
    const minutes = Math.floor(totalSeconds / 60);
    if (minutes < 60) return minutes + 'm ' + (totalSeconds % 60) + 's';
    const hours = Math.floor(minutes / 60);
    return hours + 'h ' + String(minutes % 60).padStart(2, '0') + 'm';
  }

  function relativeLabel(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return 'unknown';
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 15) return 'just now';
    if (seconds < 60) return seconds + 's ago';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
  }

  function stateClass(state) {
    const s = String(state == null ? '' : state).toLowerCase();
    if (!s) return 'unknown';
    if (/(fail|error|block|escalat|reject|crash|dead|offline|unhealthy|denied|timeout|cancel|stuck|stale)/.test(s)) return 'bad';
    if (/(complet|done|succe|accept|integrat|verif|pass|health|alive|merged|ready|ok)/.test(s)) return 'ok';
    if (/(run|stream|work|progress|active|live|start|execut)/.test(s)) return 'active';
    if (/(pend|queue|wait|schedul|defer|retry|hold|review|open|todo)/.test(s)) return 'wait';
    return 'unknown';
  }

  function formatTokens(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '—';
    return new Intl.NumberFormat('en-US').format(Math.round(value));
  }

  function formatCost(value) {
    if (value == null) return 'UNKNOWN';
    if (typeof value === 'number' && isFinite(value)) {
      if (value === 0) return '$0.00';
      return value >= 0.01 ? '$' + value.toFixed(2) : '$' + value.toFixed(4);
    }
    if (typeof value === 'string' && value.trim() !== '' && isFinite(Number(value))) return formatCost(Number(value));
    return 'UNKNOWN';
  }

  function attemptRow(raw, now) {
    if (raw == null) return null;
    if (typeof raw === 'string') {
      return { id: raw, branch: '', model: '', state: 'unknown', stateClass: 'unknown', elapsedMs: null, elapsed: '—' };
    }
    if (typeof raw !== 'object') return null;
    const id = pick(raw, ['id', 'attempt', 'attempt_id', 'attemptId', 'name', 'key']);
    if (id == null) return null;
    const branch = pick(raw, ['branch', 'git_branch', 'ref']);
    const model = pick(raw, ['model', 'model_name', 'model_id']);
    const state = pick(raw, ['state', 'status', 'phase']);
    let elapsedMs = null;
    const directMs = firstDefined(raw, ['elapsed_ms', 'duration_ms', 'elapsedMs', 'durationMs']);
    if (typeof directMs === 'number' && isFinite(directMs)) {
      elapsedMs = Math.max(0, directMs);
    } else {
      const directS = firstDefined(raw, ['elapsed_s', 'elapsed_seconds', 'duration_s', 'duration_seconds']);
      if (typeof directS === 'number' && isFinite(directS)) {
        elapsedMs = Math.max(0, directS * 1000);
      } else {
        const started = parseTimestamp(firstDefined(raw, ['started_at', 'startedAt', 'start', 'begin_at']));
        if (started != null) {
          const ended = parseTimestamp(firstDefined(raw, ['ended_at', 'updated_at', 'finished_at', 'completed_at']));
          const reference = ended != null ? ended : (typeof now === 'number' ? now : Date.now());
          elapsedMs = Math.max(0, reference - started);
        }
      }
    }
    const stateText = state == null ? 'unknown' : String(state);
    return {
      id: String(id),
      branch: branch == null ? '' : String(branch),
      model: model == null ? '' : String(model),
      state: stateText,
      stateClass: stateClass(stateText),
      elapsedMs,
      elapsed: elapsedLabel(elapsedMs),
    };
  }

  function fleetRows(fleet, now) {
    let list = null;
    if (Array.isArray(fleet)) list = fleet;
    else if (fleet && typeof fleet === 'object' && !Array.isArray(fleet)) {
      for (const key of ['attempts', 'rows', 'bees', 'items', 'entries']) {
        if (Array.isArray(fleet[key])) { list = fleet[key]; break; }
      }
    }
    const rows = [];
    if (list) for (const raw of list) { const row = attemptRow(raw, now); if (row) rows.push(row); }
    return rows;
  }

  function sortFleetRows(rows, key, direction) {
    const column = FLEET_COLUMNS.indexOf(key) >= 0 ? key : 'id';
    const dir = direction === -1 ? -1 : 1;
    return rows.slice().sort((a, b) => {
      let result;
      if (column === 'elapsed') {
        result = (a.elapsedMs == null ? -1 : a.elapsedMs) - (b.elapsedMs == null ? -1 : b.elapsedMs);
      } else {
        result = String(a[column] || '').localeCompare(String(b[column] || ''), undefined, { numeric: true, sensitivity: 'base' });
      }
      return result * dir;
    });
  }

  function normalizeGroup(value) {
    const items = [];
    if (value == null) return items;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item == null) continue;
        if (typeof item === 'string') { items.push({ label: item, tokens: null }); continue; }
        if (typeof item !== 'object') continue;
        const label = pick(item, ['label', 'model', 'provider', 'repo', 'name', 'key', 'id']);
        if (label == null) continue;
        const tokens = firstDefined(item, ['tokens', 'count', 'value', 'total', 'tokens_total']);
        items.push({ label: String(label), tokens: toNumber(tokens) });
      }
      return items;
    }
    if (typeof value === 'object') {
      for (const label of Object.keys(value).sort()) {
        const raw = value[label];
        const tokens = typeof raw === 'number' ? raw : raw && typeof raw === 'object' && !Array.isArray(raw) ? firstDefined(raw, ['tokens', 'count', 'value', 'total', 'tokens_total']) : null;
        items.push({ label, tokens: toNumber(tokens) });
      }
    }
    return items;
  }

  function normalizeCostGroup(value) {
    const items = [];
    if (value == null) return items;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item == null) continue;
        if (typeof item === 'string') { items.push({ label: item, cost: null, costKnown: false }); continue; }
        if (typeof item !== 'object') continue;
        const label = pick(item, ['label', 'model', 'provider', 'repo', 'name', 'key', 'id']);
        if (label == null) continue;
        items.push(costItem(String(label), firstDefined(item, ['cost_usd', 'usd', 'cost', 'amount', 'value', 'total'])));
      }
      return items;
    }
    if (typeof value === 'object') {
      for (const label of Object.keys(value).sort()) items.push(costItem(label, value[label]));
    }
    return items;
  }

  function costItem(label, raw) {
    if (typeof raw === 'number' && isFinite(raw)) return { label, cost: raw, costKnown: true };
    if (typeof raw === 'string' && raw.trim() !== '' && isFinite(Number(raw))) return { label, cost: Number(raw), costKnown: true };
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const value = firstDefined(raw, ['cost_usd', 'usd', 'cost', 'amount', 'value', 'total']);
      if (typeof value === 'number' && isFinite(value)) return { label, cost: value, costKnown: true };
      if (typeof value === 'string' && value.trim() !== '' && isFinite(Number(value))) return { label, cost: Number(value), costKnown: true };
    }
    return { label, cost: null, costKnown: false };
  }

  function toNumber(value) {
    if (typeof value === 'number' && isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && isFinite(Number(value))) return Number(value);
    return null;
  }

  function usageSeries(usage) {
    const empty = { present: false, totals: { tokens: null, cost: null, costKnown: false }, groups: [] };
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return empty;
    const tokenSource = usage.tokens && typeof usage.tokens === 'object' && !Array.isArray(usage.tokens) ? usage.tokens : usage;
    let costSource = null;
    for (const key of ['cost', 'costs', 'cost_usd', 'costs_usd']) {
      if (usage[key] && typeof usage[key] === 'object' && !Array.isArray(usage[key])) { costSource = usage[key]; break; }
    }
    const kinds = [
      ['model', ['by_model', 'byModel', 'models', 'model']],
      ['provider', ['by_provider', 'byProvider', 'providers', 'provider']],
      ['repo', ['by_repo', 'byRepo', 'repos', 'repo', 'repositories']],
    ];
    const groups = [];
    let sawAny = typeof usage.tokens === 'number' || typeof usage.cost_usd === 'number';
    for (const [kind, keys] of kinds) {
      const tokens = normalizeGroup(firstDefined(tokenSource, keys));
      const costs = normalizeCostGroup(firstDefined(costSource, keys) || firstDefined(usage, ['cost_by_' + kind]));
      if (tokens.length || costs.length) sawAny = true;
      groups.push({ kind, tokens, costs });
    }
    let totalTokens = null;
    let totalCost = null;
    let totalCostKnown = false;
    for (const key of ['total', 'total_tokens', 'tokens_total', 'sum']) {
      if (typeof tokenSource === 'object' && typeof tokenSource[key] === 'number' && isFinite(tokenSource[key])) { totalTokens = tokenSource[key]; break; }
    }
    if (totalTokens == null && typeof usage.tokens === 'number' && isFinite(usage.tokens)) totalTokens = usage.tokens;
    if (costSource) {
      for (const key of ['total', 'total_usd', 'total_cost', 'sum']) {
        if (typeof costSource[key] === 'number' && isFinite(costSource[key])) { totalCost = costSource[key]; totalCostKnown = true; break; }
      }
    }
    if (!totalCostKnown && typeof usage.cost_usd === 'number' && isFinite(usage.cost_usd)) { totalCost = usage.cost_usd; totalCostKnown = true; }
    const modelGroup = groups.find(group => group.kind === 'model');
    const modelTokens = modelGroup ? modelGroup.tokens : [];
    if (totalTokens == null && modelTokens.length && modelTokens.every(item => item.tokens != null)) {
      totalTokens = modelTokens.reduce((sum, item) => sum + item.tokens, 0);
    }
    const modelCosts = modelGroup ? modelGroup.costs : [];
    if (!totalCostKnown && modelCosts.length && modelCosts.every(item => item.costKnown)) {
      totalCost = modelCosts.reduce((sum, item) => sum + item.cost, 0);
      totalCostKnown = true;
    }
    return { present: sawAny, totals: { tokens: totalTokens, cost: totalCost, costKnown: totalCostKnown }, groups };
  }

  function stageInfo(raw) {
    if (raw == null || raw === '') return { state: null, reason: '' };
    if (typeof raw === 'string') return { state: raw, reason: '' };
    if (typeof raw !== 'object') return { state: String(raw), reason: '' };
    const state = pick(raw, ['state', 'status', 'phase']);
    const reason = pick(raw, ['reason', 'detail', 'message', 'why']);
    return { state: state == null ? null : String(state), reason: reason == null ? '' : String(reason) };
  }

  function flagReason(value, fallback) {
    if (value == null || value === false || value === '') return '';
    if (value === true) return fallback;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      return value.map(item => flagReason(item, fallback)).filter(Boolean).join('; ');
    }
    if (typeof value === 'object') {
      const reason = pick(value, ['reason', 'detail', 'message', 'why', 'text', 'title', 'summary']);
      return reason == null ? fallback : String(reason);
    }
    return String(value);
  }

  function normalizeTask(task, now) {
    if (task == null) return null;
    if (typeof task === 'string') {
      return { id: task, title: task, state: 'unknown', stateClass: 'unknown', attempts: [], stages: blankStages(), escalation: '', blocker: '' };
    }
    if (typeof task !== 'object') return null;
    const stageSource = task.stages && typeof task.stages === 'object' && !Array.isArray(task.stages) ? task.stages : task;
    const stages = {};
    for (const name of ['verify', 'integrate', 'accept']) stages[name] = stageInfo(stageSource[name]);
    const attempts = [];
    const attemptSource = Array.isArray(task.attempts) ? task.attempts : Array.isArray(task.tries) ? task.tries : [];
    for (const raw of attemptSource) { const row = attemptRow(raw, now); if (row) attempts.push(row); }
    const state = String(pick(task, ['state', 'status', 'phase']) ?? 'unknown');
    return {
      id: String(pick(task, ['id', 'key', 'name']) ?? ''),
      title: String(pick(task, ['title', 'name', 'summary']) ?? ''),
      state,
      stateClass: stateClass(state),
      attempts,
      stages,
      escalation: flagReason(pick(task, ['escalation', 'escalated_reason']), 'escalated'),
      blocker: flagReason(pick(task, ['blocker', 'blocked_reason', 'blockers']), 'blocked'),
    };
  }

  function blankStages() {
    return { verify: { state: null, reason: '' }, integrate: { state: null, reason: '' }, accept: { state: null, reason: '' } };
  }

  function pipelineJobs(pipeline, now) {
    if (!pipeline) return [];
    let list = null;
    if (Array.isArray(pipeline)) list = pipeline;
    else if (typeof pipeline === 'object' && !Array.isArray(pipeline)) {
      for (const key of ['jobs', 'runs', 'entries', 'items']) {
        if (Array.isArray(pipeline[key])) { list = pipeline[key]; break; }
      }
    }
    if (!list) return [];
    const jobs = [];
    for (const raw of list) {
      if (raw == null) continue;
      if (typeof raw === 'string') {
        jobs.push({ id: raw, title: raw, state: 'unknown', stateClass: 'unknown', escalation: '', blocker: '', tasks: [] });
        continue;
      }
      if (typeof raw !== 'object') continue;
      const id = String(pick(raw, ['id', 'key', 'name']) ?? '');
      const state = String(pick(raw, ['state', 'status', 'phase']) ?? 'unknown');
      const taskList = Array.isArray(raw.tasks) ? raw.tasks : Array.isArray(raw.children) ? raw.children : [];
      const tasks = [];
      for (const task of taskList) { const normalized = normalizeTask(task, now); if (normalized) tasks.push(normalized); }
      jobs.push({
        id,
        title: String(pick(raw, ['title', 'name', 'summary']) ?? id),
        state,
        stateClass: stateClass(state),
        escalation: flagReason(pick(raw, ['escalation', 'escalated_reason']), 'escalated'),
        blocker: flagReason(pick(raw, ['blocker', 'blocked_reason', 'blockers']), 'blocked'),
        tasks,
      });
    }
    return jobs;
  }

  function normalizeCard(raw) {
    if (raw == null) return null;
    if (typeof raw === 'string') return { id: '', title: raw, assignee: '', points: null };
    if (typeof raw !== 'object') return null;
    const title = pick(raw, ['title', 'name', 'summary', 'text', 'label']);
    if (title == null) return null;
    const points = pick(raw, ['points', 'estimate', 'size']);
    return {
      id: String(pick(raw, ['id', 'key', 'card_id', 'ticket']) ?? ''),
      title: String(title),
      assignee: String(pick(raw, ['assignee', 'owner', 'who']) ?? ''),
      points: typeof points === 'number' && isFinite(points) ? points : null,
    };
  }

  function backlogColumns(backlog) {
    if (!backlog || typeof backlog !== 'object' || Array.isArray(backlog)) return [];
    let columns = null;
    const board = firstDefined(backlog, ['board', 'columns', 'swimlanes']);
    if (Array.isArray(board)) columns = board;
    else if (board && typeof board === 'object') {
      columns = Object.keys(board).sort().map(name => ({ name, [Array.isArray(board[name]) ? 'cards' : 'items']: board[name] }));
    } else if (Array.isArray(backlog.cards)) {
      const groups = new Map();
      for (const raw of backlog.cards) {
        const card = normalizeCard(raw);
        if (!card) continue;
        const name = String(pick(raw, ['column', 'status', 'state', 'lane']) ?? 'Unsorted');
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(card);
      }
      return [...groups.entries()].map(([name, cards]) => ({ name, cards }));
    } else {
      const values = Object.values(backlog);
      if (values.some(value => Array.isArray(value))) {
        columns = Object.keys(backlog).map(name => ({ name, cards: backlog[name] }));
      }
    }
    if (!columns) return [];
    const result = [];
    for (const column of columns) {
      if (column == null) continue;
      if (typeof column === 'string') { result.push({ name: column, cards: [] }); continue; }
      if (typeof column !== 'object') continue;
      const name = pick(column, ['name', 'title', 'column', 'label', 'id']);
      if (name == null) continue;
      const cardsRaw = firstDefined(column, ['cards', 'items', 'tickets', 'issues', 'entries']);
      const cards = Array.isArray(cardsRaw) ? cardsRaw.map(normalizeCard).filter(Boolean) : [];
      result.push({ name: String(name), cards });
    }
    return result;
  }

  function scalarState(value) {
    if (value == null) return { state: 'unknown', detail: '' };
    if (typeof value === 'boolean') return { state: value ? 'ok' : 'bad', detail: '' };
    if (typeof value === 'string') return { state: stateClass(value), detail: value };
    if (typeof value === 'object') {
      const state = pick(value, ['state', 'status', 'phase']);
      if (typeof state === 'boolean') return { state: state ? 'ok' : 'bad', detail: String(pick(value, ['detail', 'message', 'version', 'info', 'pid', 'reason']) ?? '') };
      if (state != null) return { state: stateClass(String(state)), detail: String(pick(value, ['detail', 'message', 'version', 'info', 'pid', 'reason']) ?? state) };
      const healthy = pick(value, ['healthy', 'ok', 'alive', 'running', 'available', 'up']);
      if (typeof healthy === 'boolean') return { state: healthy ? 'ok' : 'bad', detail: String(pick(value, ['detail', 'message', 'version', 'info', 'pid', 'reason']) ?? '') };
      const detail = String(pick(value, ['detail', 'message', 'version', 'info', 'pid', 'reason']) ?? '');
      return detail ? { state: stateClass(detail), detail } : { state: 'unknown', detail: '' };
    }
    return { state: stateClass(String(value)), detail: String(value) };
  }

  function healthChips(health, now) {
    if (!health || typeof health !== 'object' || Array.isArray(health)) return [];
    const chips = [];
    const reference = typeof now === 'number' ? now : Date.now();
    for (const [key, label] of [['launcher', 'Launcher'], ['docker', 'Docker']]) {
      if (!(key in health)) continue;
      const info = scalarState(health[key]);
      chips.push({ key, label, state: info.state, detail: info.detail });
    }
    if ('gateway' in health) {
      const gateway = health.gateway;
      if (gateway && typeof gateway === 'object' && !Array.isArray(gateway)) {
        const running = pick(gateway, ['running', 'gateway_version', 'live', 'served', 'version']);
        const installed = pick(gateway, ['installed', 'installed_version', 'bundled', 'package']);
        if (running != null && installed != null) {
          const same = String(running) === String(installed);
          chips.push({
            key: 'gateway',
            label: 'Gateway parity',
            state: same ? 'ok' : 'warn',
            detail: same ? 'gateway = installed (' + running + ')' : 'gateway ' + running + ' ≠ installed ' + installed,
          });
        } else {
          chips.push({
            key: 'gateway',
            label: 'Gateway parity',
            state: 'unknown',
            detail: 'parity unknown' + (running != null ? ' — gateway ' + running : '') + (installed != null ? ' — installed ' + installed : ''),
          });
        }
      } else {
        const info = scalarState(gateway);
        chips.push({ key: 'gateway', label: 'Gateway', state: info.state, detail: info.detail });
      }
    }
    if ('quota' in health) {
      const quota = health.quota;
      if (quota && typeof quota === 'object' && !Array.isArray(quota)) {
        const used = pick(quota, ['used', 'current', 'count', 'x', 'value']);
        const max = pick(quota, ['max', 'limit', 'maximum', 'cap', 'of']);
        if (typeof used === 'number' && isFinite(used) && typeof max === 'number' && isFinite(max) && max > 0) {
          const ratio = used / max;
          chips.push({
            key: 'quota',
            label: 'Quota',
            state: ratio >= 1 ? 'bad' : ratio >= 0.9 ? 'warn' : 'ok',
            detail: used + ' / ' + max,
          });
        } else {
          const shownUsed = used != null ? String(used) : '?';
          const shownMax = max != null ? String(max) : '?';
          chips.push({ key: 'quota', label: 'Quota', state: 'unknown', detail: used != null || max != null ? shownUsed + ' / ' + shownMax : 'unknown' });
        }
      } else {
        chips.push({ key: 'quota', label: 'Quota', state: 'unknown', detail: quota == null ? 'unknown' : String(quota) });
      }
    }
    if ('scheduler' in health) {
      const scheduler = health.scheduler;
      if (scheduler && typeof scheduler === 'object' && !Array.isArray(scheduler)) {
        const alive = pick(scheduler, ['alive', 'healthy', 'responsive', 'ok', 'running']);
        const beat = parseTimestamp(firstDefined(scheduler, ['last_beat_at', 'last_beat', 'last_heartbeat', 'heartbeat_at', 'beat_at']));
        let state = 'unknown';
        if (typeof alive === 'boolean') state = alive ? 'ok' : 'bad';
        else if (alive != null) state = stateClass(String(alive));
        const details = [];
        if (beat != null) {
          const age = reference - beat;
          details.push('last beat ' + relativeLabel(age));
          if (state === 'unknown') state = age > STALE_AFTER_MS ? 'warn' : 'ok';
        }
        const extra = pick(scheduler, ['detail', 'message', 'reason']);
        if (extra != null) details.push(String(extra));
        chips.push({ key: 'scheduler', label: 'Scheduler', state, detail: details.join(' · ') });
      } else {
        const info = scalarState(scheduler);
        chips.push({ key: 'scheduler', label: 'Scheduler', state: info.state, detail: info.detail });
      }
    }
    return chips;
  }

  function alertBanners(alerts) {
    if (!Array.isArray(alerts)) return [];
    const banners = [];
    for (const raw of alerts) {
      if (raw == null) continue;
      if (typeof raw === 'string') { banners.push({ level: 'info', message: raw, detail: '' }); continue; }
      if (typeof raw !== 'object') { banners.push({ level: 'info', message: String(raw), detail: '' }); continue; }
      const message = pick(raw, ['message', 'title', 'text', 'summary', 'detail']);
      if (message == null) continue;
      const level = String(pick(raw, ['level', 'severity', 'kind']) ?? 'info').toLowerCase();
      banners.push({
        level: /error|crit|fatal|fail|red|emergency|alert/.test(level) ? 'error' : /warn|yellow|degrad/.test(level) ? 'warn' : 'info',
        message: String(message),
        detail: String(pick(raw, ['detail', 'description', 'context', 'hint']) ?? ''),
      });
    }
    return banners;
  }

  function normalizeSnapshot(raw, now) {
    const invalid = raw == null || typeof raw !== 'object' || Array.isArray(raw);
    const result = {
      invalid,
      schemaValue: null,
      schemaOk: null,
      generatedAt: null,
      stale: null,
      present: { fleet: false, usage: false, pipeline: false, backlog: false, health: false, alerts: false },
      fleet: [],
      usage: usageSeries(null),
      pipeline: [],
      backlog: [],
      healthChips: [],
      alerts: [],
    };
    if (invalid) return result;
    const reference = typeof now === 'number' ? now : Date.now();
    const schemaValue = typeof raw.schema === 'string' ? raw.schema : typeof raw.schema_version === 'string' ? raw.schema_version : null;
    result.schemaValue = schemaValue;
    result.schemaOk = schemaValue == null ? null : schemaValue === SNAPSHOT_SCHEMA;
    const generatedAt = parseTimestamp(firstDefined(raw, ['generated_at', 'generatedAt', 'updated_at', 'taken_at', 'timestamp']));
    result.generatedAt = generatedAt;
    result.stale = generatedAt == null ? null : generatedAt + STALE_AFTER_MS < reference;
    result.present.fleet = raw.fleet != null;
    result.present.usage = raw.usage != null;
    result.present.pipeline = raw.pipeline != null;
    result.present.backlog = raw.backlog != null;
    result.present.health = raw.health != null;
    result.present.alerts = raw.alerts != null;
    result.fleet = fleetRows(raw.fleet, reference);
    result.usage = usageSeries(raw.usage);
    result.pipeline = pipelineJobs(raw.pipeline, reference);
    result.backlog = backlogColumns(raw.backlog);
    result.healthChips = healthChips(raw.health, reference);
    result.alerts = alertBanners(raw.alerts);
    return result;
  }

  function buildRequest(url, token) {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    return { url: String(url), init: { headers, cache: 'no-store', credentials: 'omit' } };
  }

  async function loadSnapshot(options) {
    const opts = options || {};
    const effectiveFetch = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!opts.url) throw new Error('No snapshot URL configured');
    if (!effectiveFetch) throw new Error('No fetch implementation available');
    const request = buildRequest(opts.url, opts.token);
    const response = await effectiveFetch(request.url, request.init);
    if (!response || typeof response.ok !== 'boolean') throw new Error('Snapshot fetch failed: invalid response');
    if (!response.ok) throw new Error('Snapshot request failed: HTTP ' + response.status);
    const raw = await response.json();
    return { snapshot: normalizeSnapshot(raw, typeof opts.now === 'number' ? opts.now : Date.now()) };
  }

  function readConfigFragment(fragment) {
    if (typeof fragment !== 'string' || fragment.indexOf(CONFIG_FRAGMENT_PREFIX) !== 0) return {};
    try {
      const parsed = JSON.parse(decodeURIComponent(fragment.slice(CONFIG_FRAGMENT_PREFIX.length)));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  // The token is deliberately never read from the config fragment: plugin
  // config is public and visible in the iframe URL. Only the snapshot URL is
  // configuration; the token lives in localStorage and is typed by the operator.
  function resolveConfig(options) {
    const opts = options || {};
    const fragmentConfig = readConfigFragment(opts.fragment);
    const fragmentUrl = typeof fragmentConfig.snapshot_url === 'string' && fragmentConfig.snapshot_url.trim() ? fragmentConfig.snapshot_url.trim() : null;
    const storedUrl = typeof opts.storedUrl === 'string' && opts.storedUrl.trim() ? opts.storedUrl.trim() : null;
    const fallback = typeof opts.fallbackUrl === 'string' && opts.fallbackUrl.trim() ? opts.fallbackUrl.trim() : DEFAULT_SNAPSHOT_URL;
    const snapshotUrl = fragmentUrl || storedUrl || fallback;
    return { snapshotUrl, source: fragmentUrl ? 'config' : storedUrl ? 'operator' : 'default' };
  }

  function getStore() {
    try {
      return global && global.localStorage ? global.localStorage : null;
    } catch {
      return null;
    }
  }

  function storageGet(key, store) {
    const target = store != null ? store : getStore();
    if (!target) return null;
    try {
      return target.getItem(key);
    } catch {
      return null;
    }
  }

  function storageSet(key, value, store) {
    const target = store != null ? store : getStore();
    if (!target) return false;
    try {
      target.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function storageRemove(key, store) {
    const target = store != null ? store : getStore();
    if (!target) return false;
    try {
      target.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }

  function storageAvailable(store) {
    const target = store != null ? store : getStore();
    if (!target) return false;
    try {
      target.setItem('__rizzstack_probe__', '1');
      const ok = target.getItem('__rizzstack_probe__') === '1';
      target.removeItem('__rizzstack_probe__');
      return ok;
    } catch {
      return false;
    }
  }

  function renderAlerts(banners) {
    if (!banners || !banners.length) return '';
    return banners.map(banner =>
      '<div class="alert ' + banner.level + '"' + (banner.level === 'error' ? ' role="alert"' : '') + '>' +
      '<span class="alert-level">' + banner.level.toUpperCase() + '</span>' +
      '<div><p>' + escapeHtml(banner.message) + '</p>' +
      (banner.detail ? '<p class="alert-detail">' + escapeHtml(banner.detail) + '</p>' : '') +
      '</div></div>'
    ).join('');
  }

  function renderHealth(chips) {
    if (!chips || !chips.length) return '';
    return '<ul class="health-strip">' + chips.map(chip =>
      '<li class="chip ' + chip.state + '"><span class="chip-label">' + escapeHtml(chip.label) + '</span>' +
      '<span class="chip-detail">' + escapeHtml(chip.detail || chip.state) + '</span></li>'
    ).join('') + '</ul>';
  }

  function renderFleet(rows) {
    if (!rows || !rows.length) return '';
    return rows.map(row =>
      '<tr>' +
      '<td class="mono">' + escapeHtml(row.id) + '</td>' +
      '<td class="mono">' + escapeHtml(row.branch || '—') + '</td>' +
      '<td>' + escapeHtml(row.model || '—') + '</td>' +
      '<td><span class="state ' + row.stateClass + '">' + escapeHtml(row.state) + '</span></td>' +
      '<td class="mono">' + escapeHtml(row.elapsed) + '</td>' +
      '</tr>'
    ).join('');
  }

  function renderUsage(series) {
    if (!series || !series.groups || !series.groups.length) return '';
    const parts = [];
    const totals = series.totals || { tokens: null, cost: null, costKnown: false };
    parts.push(
      '<div class="usage-total">' +
      '<span class="label">Total tokens</span><span class="value mono">' + escapeHtml(totals.tokens == null ? '—' : formatTokens(totals.tokens)) + '</span>' +
      '<span class="label">Total cost</span><span class="value mono' + (totals.costKnown ? '' : ' unknown-cost') + '">' + escapeHtml(totals.costKnown ? formatCost(totals.cost) : 'UNKNOWN') + '</span>' +
      '</div>'
    );
    for (const group of series.groups) {
      const maxTokens = group.tokens.reduce((max, item) => (item.tokens != null && item.tokens > max ? item.tokens : max), 0);
      parts.push('<div class="usage-group"><h3>Tokens by ' + escapeHtml(group.kind) + '</h3>');
      if (group.tokens.length) {
        parts.push('<ul class="bars">' + group.tokens.map(item => {
          const width = maxTokens > 0 && item.tokens != null ? Math.max(2, Math.round(1000 * item.tokens / maxTokens) / 10) : 0;
          return '<li><span class="bar-label mono">' + escapeHtml(item.label) + '</span>' +
            '<span class="bar-track"><span class="bar-fill" style="width:' + width + '%"></span></span>' +
            '<span class="bar-value mono">' + escapeHtml(item.tokens == null ? '—' : formatTokens(item.tokens)) + '</span></li>';
        }).join('') + '</ul>');
      } else {
        parts.push('<p class="mini-empty">No token breakdown.</p>');
      }
      const costs = group.costs.length ? group.costs : group.tokens.map(item => ({ label: item.label, cost: null, costKnown: false }));
      parts.push('<h4 class="cost-heading">Cost by ' + escapeHtml(group.kind) + '</h4>');
      if (costs.length) {
        parts.push('<ul class="costs">' + costs.map(item =>
          '<li><span class="bar-label mono">' + escapeHtml(item.label) + '</span>' +
          '<span class="bar-value mono' + (item.costKnown ? '' : ' unknown-cost') + '">' + escapeHtml(item.costKnown ? formatCost(item.cost) : 'UNKNOWN') + '</span></li>'
        ).join('') + '</ul>');
      } else {
        parts.push('<p class="mini-empty">No cost data.</p>');
      }
      parts.push('</div>');
    }
    return parts.join('');
  }

  function renderPipeline(jobs) {
    if (!jobs || !jobs.length) return '';
    const stageNames = ['verify', 'integrate', 'accept'];
    return '<ol class="timeline">' + jobs.map(job =>
      '<li class="node ' + job.stateClass + '">' +
      '<div class="node-head"><span class="state ' + job.stateClass + '">' + escapeHtml(job.state) + '</span>' +
      '<span class="node-title">' + escapeHtml(job.title || job.id || '(unnamed job)') + '</span></div>' +
      (job.escalation ? '<p class="reason escalation">Escalation: ' + escapeHtml(job.escalation) + '</p>' : '') +
      (job.blocker ? '<p class="reason blocker">Blocker: ' + escapeHtml(job.blocker) + '</p>' : '') +
      (job.tasks.length
        ? '<ul class="tasks">' + job.tasks.map(task =>
          '<li class="node ' + task.stateClass + '">' +
          '<div class="node-head"><span class="state ' + task.stateClass + '">' + escapeHtml(task.state) + '</span>' +
          '<span class="node-title">' + escapeHtml(task.title || task.id || '(unnamed task)') + '</span></div>' +
          (task.attempts.length
            ? '<ul class="attempts">' + task.attempts.map(attempt =>
              '<li><span class="mono">' + escapeHtml(attempt.id) + '</span><span>' + escapeHtml(attempt.model || '—') + '</span>' +
              '<span class="state ' + attempt.stateClass + '">' + escapeHtml(attempt.state) + '</span>' +
              '<span class="mono">' + escapeHtml(attempt.elapsed) + '</span></li>').join('') + '</ul>'
            : '') +
          '<ul class="stages">' + stageNames.map(name => {
            const stage = task.stages[name] || { state: null, reason: '' };
            return '<li class="stage ' + (stage.state ? stateClass(stage.state) : 'unknown') + '"><span class="stage-name">' + name + '</span>' +
              '<span class="stage-state">' + escapeHtml(stage.state || '—') + '</span>' +
              (stage.reason ? '<span class="reason">' + escapeHtml(stage.reason) + '</span>' : '') + '</li>';
          }).join('') + '</ul>' +
          (task.escalation ? '<p class="reason escalation">Escalation: ' + escapeHtml(task.escalation) + '</p>' : '') +
          (task.blocker ? '<p class="reason blocker">Blocker: ' + escapeHtml(task.blocker) + '</p>' : '') +
          '</li>').join('') + '</ul>'
        : '') +
      '</li>').join('') + '</ol>';
  }

  function renderBacklog(columns) {
    if (!columns || !columns.length) return '';
    return '<div class="board">' + columns.map(column =>
      '<div class="board-column"><h3><span>' + escapeHtml(column.name) + '</span><span class="count">' + column.cards.length + '</span></h3>' +
      (column.cards.length
        ? '<ul>' + column.cards.map(card => {
          const meta = [card.id, card.assignee, card.points == null ? '' : card.points + ' pts'].filter(Boolean).join(' · ');
          return '<li><span class="card-title">' + escapeHtml(card.title) + '</span>' + (meta ? '<span class="card-meta">' + escapeHtml(meta) + '</span>' : '') + '</li>';
        }).join('') + '</ul>'
        : '<p class="mini-empty">No cards.</p>') +
      '</div>').join('') + '</div>';
  }

  const api = {
    SNAPSHOT_SCHEMA,
    TOKEN_STORAGE_KEY,
    URL_STORAGE_KEY,
    DEFAULT_SNAPSHOT_URL,
    CONFIG_FRAGMENT_PREFIX,
    STALE_AFTER_MS,
    REFRESH_INTERVAL_MS,
    FLEET_COLUMNS,
    escapeHtml,
    parseTimestamp,
    elapsedLabel,
    relativeLabel,
    stateClass,
    formatTokens,
    formatCost,
    fleetRows,
    sortFleetRows,
    usageSeries,
    pipelineJobs,
    backlogColumns,
    healthChips,
    alertBanners,
    normalizeSnapshot,
    buildRequest,
    loadSnapshot,
    readConfigFragment,
    resolveConfig,
    storageGet,
    storageSet,
    storageRemove,
    storageAvailable,
    renderAlerts,
    renderHealth,
    renderFleet,
    renderUsage,
    renderPipeline,
    renderBacklog,
  };
  global.RizzstackObservatory = api;

  function bootstrap() {
    const $ = id => document.getElementById(id);
    const elements = {
      freshness: $('freshness'),
      status: $('status'),
      refresh: $('refresh'),
      openSettings: $('open-settings'),
      schemaNote: $('schema-note'),
      alertsSection: $('alerts-section'),
      health: $('health'),
      healthEmpty: $('health-empty'),
      fleetTable: $('fleet-table'),
      fleetBody: $('fleet-body'),
      fleetEmpty: $('fleet-empty'),
      usage: $('usage'),
      usageEmpty: $('usage-empty'),
      pipeline: $('pipeline'),
      pipelineEmpty: $('pipeline-empty'),
      backlog: $('backlog'),
      backlogEmpty: $('backlog-empty'),
      dialog: $('settings-dialog'),
      form: $('settings-form'),
      urlInput: $('setting-url'),
      tokenInput: $('setting-token'),
      forgetToken: $('forget-token'),
      settingsClose: $('settings-close'),
    };
    if (!elements.status || !elements.fleetBody) return;
    const state = { url: null, token: '', sortKey: 'id', sortDir: 1, last: null, busy: false, storageNote: '' };
    const canStore = storageAvailable();
    if (!canStore) state.storageNote = 'browser storage unavailable; settings are session-only';
    const config = resolveConfig({
      fragment: typeof location === 'object' && location ? String(location.hash || '') : '',
      storedUrl: canStore ? storageGet(URL_STORAGE_KEY) : null,
    });
    state.url = config.snapshotUrl;
    if (canStore) state.token = storageGet(TOKEN_STORAGE_KEY) || '';
    elements.urlInput.value = config.source === 'operator' ? state.url : (config.source === 'default' ? '' : state.url);
    elements.urlInput.placeholder = DEFAULT_SNAPSHOT_URL;
    elements.tokenInput.placeholder = state.token ? 'Stored in this browser — leave blank to keep' : 'Not stored';

    function applyView(snapshot) {
      const now = Date.now();
      let freshness;
      if (!snapshot) freshness = { text: 'NO DATA', cls: 'unknown' };
      else if (snapshot.invalid) freshness = { text: 'INVALID SNAPSHOT', cls: 'bad' };
      else if (snapshot.stale === true) freshness = { text: 'STALE · ' + relativeLabel(now - snapshot.generatedAt) + ' old', cls: 'bad' };
      else if (snapshot.stale === null) freshness = { text: 'FRESHNESS UNKNOWN', cls: 'warn' };
      else freshness = { text: 'FRESH', cls: 'ok' };
      elements.freshness.textContent = freshness.text;
      elements.freshness.className = 'badge ' + freshness.cls;
      if (snapshot && snapshot.schemaOk === false) {
        elements.schemaNote.textContent = 'Unrecognized snapshot schema' + (snapshot.schemaValue ? ': ' + snapshot.schemaValue : '') + ' — expected ' + SNAPSHOT_SCHEMA + '.';
        elements.schemaNote.className = '';
        elements.schemaNote.hidden = false;
      } else if (snapshot && snapshot.schemaOk === null) {
        elements.schemaNote.textContent = 'Snapshot does not declare a schema version; rendering as ' + SNAPSHOT_SCHEMA + '.';
        elements.schemaNote.className = 'info';
        elements.schemaNote.hidden = false;
      } else {
        elements.schemaNote.hidden = true;
      }
      const banners = snapshot ? snapshot.alerts : [];
      elements.alertsSection.hidden = banners.length === 0;
      elements.alertsSection.innerHTML = renderAlerts(banners);
      const chips = snapshot ? snapshot.healthChips : [];
      if (chips.length) {
        elements.health.innerHTML = renderHealth(chips);
        elements.health.hidden = false;
        elements.healthEmpty.hidden = true;
      } else {
        elements.health.hidden = true;
        elements.healthEmpty.hidden = false;
        elements.healthEmpty.textContent = snapshot ? (snapshot.present.health ? 'No health data in this snapshot.' : 'No health section in this snapshot.') : 'No snapshot loaded yet.';
      }
      const rows = snapshot ? sortFleetRows(snapshot.fleet, state.sortKey, state.sortDir) : [];
      elements.fleetBody.innerHTML = renderFleet(rows);
      elements.fleetTable.hidden = rows.length === 0;
      elements.fleetEmpty.hidden = rows.length !== 0;
      elements.fleetEmpty.textContent = snapshot ? (snapshot.present.fleet ? 'No live attempts in this snapshot.' : 'No fleet section in this snapshot.') : 'No snapshot loaded yet.';
      const usageHtml = snapshot ? renderUsage(snapshot.usage) : '';
      elements.usage.innerHTML = usageHtml;
      elements.usage.hidden = !usageHtml;
      elements.usageEmpty.hidden = !!usageHtml;
      elements.usageEmpty.textContent = snapshot ? (snapshot.present.usage ? 'No usage data in this snapshot.' : 'No usage section in this snapshot.') : 'No snapshot loaded yet.';
      const pipelineHtml = snapshot ? renderPipeline(snapshot.pipeline) : '';
      elements.pipeline.innerHTML = pipelineHtml;
      elements.pipeline.hidden = !pipelineHtml;
      elements.pipelineEmpty.hidden = !!pipelineHtml;
      elements.pipelineEmpty.textContent = snapshot ? (snapshot.present.pipeline ? 'No pipeline jobs in this snapshot.' : 'No pipeline section in this snapshot.') : 'No snapshot loaded yet.';
      const backlogHtml = snapshot ? renderBacklog(snapshot.backlog) : '';
      elements.backlog.innerHTML = backlogHtml;
      elements.backlog.hidden = !backlogHtml;
      elements.backlogEmpty.hidden = !!backlogHtml;
      elements.backlogEmpty.textContent = snapshot ? (snapshot.present.backlog ? 'No backlog columns in this snapshot.' : 'No backlog section in this snapshot.') : 'No snapshot loaded yet.';
    }

    async function update(manual) {
      if (state.busy) return;
      state.busy = true;
      elements.refresh.disabled = true;
      elements.status.classList.remove('error');
      elements.status.textContent = manual ? 'Refreshing…' : 'Refreshing automatically…';
      try {
        const loaded = await loadSnapshot({ url: state.url, token: state.token });
        state.last = loaded.snapshot;
        applyView(loaded.snapshot);
        elements.status.textContent = 'Updated ' + new Date().toLocaleTimeString() + (state.storageNote ? ' · ' + state.storageNote : '');
      } catch (error) {
        const message = error && error.message ? String(error.message) : 'Snapshot unavailable';
        const hint = /HTTP 40[13]/.test(message) ? ' Set the bearer token in Settings.' : '';
        elements.status.textContent = 'Snapshot unavailable: ' + message + hint + (state.storageNote ? ' · ' + state.storageNote : '');
        elements.status.classList.add('error');
        if (!state.last) applyView(null);
      } finally {
        state.busy = false;
        elements.refresh.disabled = false;
      }
    }

    elements.refresh.addEventListener('click', () => void update(true));
    for (const button of document.querySelectorAll('th button[data-sort]')) {
      button.addEventListener('click', () => {
        const key = button.getAttribute('data-sort');
        if (FLEET_COLUMNS.indexOf(key) < 0) return;
        state.sortDir = state.sortKey === key ? -state.sortDir : 1;
        state.sortKey = key;
        for (const other of document.querySelectorAll('th[data-sort-key]')) {
          other.setAttribute('aria-sort', other.getAttribute('data-sort-key') === key ? (state.sortDir === 1 ? 'ascending' : 'descending') : 'none');
        }
        if (state.last) applyView(state.last);
      });
    }
    elements.openSettings.addEventListener('click', () => {
      elements.urlInput.value = state.url;
      elements.tokenInput.value = '';
      elements.tokenInput.placeholder = state.token ? 'Stored in this browser — leave blank to keep' : 'Not stored';
      if (typeof elements.dialog.showModal === 'function') elements.dialog.showModal();
      else elements.dialog.setAttribute('open', '');
    });
    elements.form.addEventListener('submit', event => {
      event.preventDefault();
      const url = elements.urlInput.value.trim();
      if (url && url !== state.url) {
        state.url = url;
        if (!storageSet(URL_STORAGE_KEY, url)) state.storageNote = 'browser storage unavailable; settings are session-only';
      }
      const token = elements.tokenInput.value.trim();
      if (token) {
        state.token = token;
        if (!storageSet(TOKEN_STORAGE_KEY, token)) state.storageNote = 'browser storage unavailable; settings are session-only';
      }
      elements.tokenInput.value = '';
      elements.tokenInput.placeholder = state.token ? 'Stored in this browser — leave blank to keep' : 'Not stored';
      if (typeof elements.dialog.close === 'function') elements.dialog.close('save');
      else elements.dialog.removeAttribute('open');
      void update(true);
    });
    elements.forgetToken.addEventListener('click', () => {
      storageRemove(TOKEN_STORAGE_KEY);
      state.token = '';
      elements.tokenInput.placeholder = 'Not stored';
    });
    elements.settingsClose.addEventListener('click', () => {
      if (typeof elements.dialog.close === 'function') elements.dialog.close('cancel');
      else elements.dialog.removeAttribute('open');
    });
    setInterval(() => void update(false), REFRESH_INTERVAL_MS);
    void update(false);
  }

  if (typeof document !== 'undefined' && document && typeof document.getElementById === 'function') {
    try {
      bootstrap();
    } catch {
      // Never log: bootstrap failures stay silent by contract (no token leakage).
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
