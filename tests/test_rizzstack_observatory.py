"""Static-bundle, rendering and token-handling tests for the Rizzstack Observatory app.

The bundle under apps/rizzstack-observatory/ must stay catalog-admissible
(static files, relative assets, no credentials) and its pure core must render
every section of a rizzstack.observability/snapshot/1 document, including
unknown costs (UNKNOWN, never 0), stale markers and empty states.
"""
import copy
import datetime
import json
import re
import shutil
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / 'apps' / 'rizzstack-observatory'
README = ROOT / 'extensions' / 'rizzstack-observatory' / 'README.md'
PUBLISH = ROOT / 'scripts' / 'plugin_publish.py'

NOW_MS = 1_800_000_000_000
TOKEN = 'operator-entered-secret-abc123'


def iso(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


FIXTURE = {
    'schema': 'rizzstack.observability/snapshot/1',
    'generated_at': iso(NOW_MS - 60_000),
    'fleet': {
        'attempts': [
            {'id': 'bee-a1', 'branch': 'feat/bee-usage-observability', 'model': 'zoo/glm-5.3-flash', 'state': 'running', 'elapsed_ms': 93_000},
            {'id': 'bee-b2', 'branch': 'main', 'model': 'other/model', 'state': 'completed', 'elapsed_s': 150},
            {'id': 'bee-c3', 'branch': 'fix/quota', 'model': 'zoo/glm-5.3-flash', 'state': 'failed', 'started_at': iso(NOW_MS - 3_600_000)},
        ]
    },
    'usage': {
        'tokens': {
            'total': 12345,
            'by_model': {'zoo/glm-5.3-flash': 8000, 'other/model': 4345},
            'by_provider': {'zoo': 12345},
            'by_repo': {'orbitdesktop': 12345},
        },
        'cost': {
            'total_usd': None,
            'by_model': {'zoo/glm-5.3-flash': 0.42, 'other/model': None},
            'by_provider': {'zoo': 0.42},
            'by_repo': {'orbitdesktop': None},
        },
    },
    'pipeline': {
        'jobs': [
            {
                'id': 'job-1',
                'title': 'Ship observatory',
                'state': 'running',
                'tasks': [
                    {
                        'id': 'task-1',
                        'title': 'Render snapshot',
                        'state': 'blocked',
                        'attempts': [{'id': 'bee-a1', 'model': 'zoo/glm-5.3-flash', 'state': 'running', 'elapsed_ms': 93_000}],
                        'stages': {
                            'verify': {'state': 'passed'},
                            'integrate': {'state': 'blocked', 'reason': 'conflict with main'},
                            'accept': {'state': 'waiting'},
                        },
                        'escalation': {'reason': 'human review requested'},
                        'blocker': {'reason': 'merge conflict'},
                    },
                    {
                        'id': 'task-2',
                        'title': 'Quota guard',
                        'state': 'completed',
                        'stages': {'verify': {'state': 'passed'}, 'integrate': {'state': 'integrated'}, 'accept': {'state': 'accepted'}},
                    },
                ],
            }
        ]
    },
    'backlog': {
        'board': [
            {'name': 'Todo', 'cards': [{'id': 'BL-12', 'title': 'Add stale markers', 'assignee': 'bee-a1', 'points': 3}]},
            {'name': 'Doing', 'cards': [{'id': 'BL-13', 'title': 'Usage charts', 'assignee': 'bee-b2'}]},
            {'name': 'Done', 'cards': [{'id': 'BL-11', 'title': 'Snapshot schema', 'points': 5}]},
        ]
    },
    'health': {
        'launcher': {'state': 'ok', 'detail': 'pid 4242'},
        'docker': {'state': 'ok', 'detail': 'docker 24.0'},
        'gateway': {'installed': '1.2.3', 'running': '1.2.4'},
        'quota': {'used': 3, 'max': 10},
        'scheduler': {'alive': False, 'last_beat_at': iso(NOW_MS - 600_000)},
    },
    'alerts': [
        {'level': 'error', 'message': 'Gateway version mismatch', 'detail': 'running 1.2.4 vs installed 1.2.3'},
        {'level': 'warn', 'message': 'Quota above 90% on worker pool', 'detail': '9 / 10'},
        'Scheduler missed its heartbeat',
    ],
}


# The frozen schema shape the collector workflow actually emits (contract:
# rizzstack.observability/snapshot/1). Field-level drift found in live
# integration: fleet attempts carry `route`/`route_label` instead of `model`,
# elapsed comes from `started_at`/`updated_at` ISO timestamps, pipeline jobs
# carry `job_id` (no state) with `tasks[]` using `task_id`/`task_state`, health
# quota is an ARRAY of quota_row {kind, value, cap, remaining, unit, status},
# and scheduler health is {liveness, last_event_age_s}.
SCHEMA_FIXTURE = {
    'schema': 'rizzstack.observability/snapshot/1',
    'generated_at': iso(NOW_MS - 60_000),
    'fleet': {
        'attempts': [
            {'id': 'bee-a1', 'branch': 'feat/bee-usage-observability', 'route': 'zoo/glm-5.3-flash',
             'state': 'running', 'started_at': iso(NOW_MS - 93_000), 'updated_at': iso(NOW_MS)},
            {'id': 'bee-c3', 'branch': 'fix/quota', 'route': {'provider': 'zoo', 'model': 'deepseek/go'},
             'state': 'failed', 'started_at': iso(NOW_MS - 3_600_000), 'updated_at': iso(NOW_MS - 600_000)},
            {'id': 'bee-d4', 'branch': 'main', 'route_label': 'go/llama-4', 'model': 'legacy-model', 'state': 'queued'},
        ]
    },
    'pipeline': {
        # Frozen pipeline_section: reasons live at SECTION level (escalations[]/
        # blockers[] rows keyed by job_id/task_id) and on pipeline_task.reason;
        # jobs carry no state/escalations and tasks carry no escalation/blocker.
        # stages/verify_state are NOT snapshot/1 task fields - kept deliberately
        # as legacy-tolerance coverage for the stage renderer (the collector
        # cannot emit them; fixture-schema-validation follow-up stays open).
        'status': 'live',
        'error': None,
        'collected_at': iso(NOW_MS - 60_000),
        'jobs': [
            {
                'schema': 'rizzstack.observability/snapshot/1',
                'generated_at': iso(NOW_MS - 60_000),
                'job_id': 'job-1',
                'repo': 'mojomast/hyvv',
                'base_rev': 'a' * 40,
                'task_count': 2,
                'escalation_count': 1,
                'tasks': [
                    {
                        'schema': 'rizzstack.observability/snapshot/1',
                        'generated_at': iso(NOW_MS - 60_000),
                        'task_id': 'task-1',
                        'state': 'blocked',
                        'attempts_count': 2,
                        'reason': 'human review requested',
                        'stages': {
                            'verify': {'state': 'passed'},
                            'integrate': {'state': 'blocked', 'reason': 'conflict with main'},
                            'accept': {'state': 'waiting'},
                        },
                    },
                    {
                        'schema': 'rizzstack.observability/snapshot/1',
                        'generated_at': iso(NOW_MS - 60_000),
                        'task_id': 'task-2',
                        'state': 'completed',
                        'attempts_count': 1,
                        'reason': None,
                        'verify_state': 'passed',
                        'integrate_state': 'integrated',
                        'accept_state': 'accepted',
                    },
                ],
            },
            {
                'schema': 'rizzstack.observability/snapshot/1',
                'generated_at': iso(NOW_MS - 60_000),
                'job_id': 'job-2',
                'repo': None,
                'base_rev': None,
                'task_count': 0,
                'escalation_count': 0,
                'tasks': [],
            },
            {
                'schema': 'rizzstack.observability/snapshot/1',
                'generated_at': iso(NOW_MS - 60_000),
                'job_id': 'job-3',
                'repo': None,
                'base_rev': None,
                'task_count': 0,
                'escalation_count': 1,
                'tasks': [],
            },
        ],
        'counts': {},
        'escalations': [
            {'schema': 'rizzstack.observability/snapshot/1', 'generated_at': iso(NOW_MS - 60_000),
             'job_id': 'job-1', 'reason': 'needs_agent', 'detail': 'capacity review',
             'created_at': iso(NOW_MS - 60_000)},
            {'schema': 'rizzstack.observability/snapshot/1', 'generated_at': iso(NOW_MS - 60_000),
             'job_id': 'job-3', 'reason': 'needs_owner_signoff', 'detail': None, 'created_at': None},
        ],
        'blockers': [
            {'schema': 'rizzstack.observability/snapshot/1', 'generated_at': iso(NOW_MS - 60_000),
             'job_id': 'job-1', 'task_id': 'task-1', 'reason': 'merge_conflict', 'detail': 'conflict with main',
             'created_at': iso(NOW_MS - 60_000)},
        ],
    },
    'health': {
        'quota': [
            {'kind': 'worker_pool', 'value': 3, 'cap': 10, 'remaining': 7, 'unit': 'tasks', 'status': 'ok'},
            {'kind': 'worker_pool', 'value': 2, 'cap': 10, 'remaining': 5, 'unit': 'tasks', 'status': 'ok'},
            {'kind': 'tool_calls', 'value': 950, 'cap': 1000, 'unit': 'calls', 'status': 'warn'},
        ],
        'scheduler': {'liveness': 'alive', 'last_event_age_s': 42},
    },
    'alerts': {
        # Frozen alerts_section: {status, error, collected_at, active[]} of
        # alert_row {schema, generated_at, key, severity, message, observed,
        # threshold, ts}. severity is warn-only in snapshot/1.
        'status': 'live',
        'error': None,
        'collected_at': iso(NOW_MS - 60_000),
        'active': [
            {'schema': 'rizzstack.observability/snapshot/1', 'generated_at': iso(NOW_MS - 60_000),
             'key': 'tool_calls_warn_at', 'severity': 'warn', 'message': 'Tool call quota above 90%',
             'observed': 950.0, 'threshold': 900.0, 'ts': iso(NOW_MS - 30_000)},
        ],
    },
}


NODE_RUNNER = """
const fs = require('fs');
const source = fs.readFileSync(process.argv[1], 'utf8');
(0, eval)(source);
const R = globalThis.RizzstackObservatory;
if (!R || typeof R.normalizeSnapshot !== 'function') {
  process.stderr.write('app.js did not expose RizzstackObservatory');
  process.exit(1);
}
const fixture = JSON.parse(process.argv[2]);
const fn = new Function('R', 'fixture', 'return (' + process.argv[3] + ');');
Promise.resolve(fn(R, fixture)).then(value => {
  process.stdout.write(JSON.stringify(value === undefined ? null : value), () => process.exit(0));
}).catch(error => {
  process.stderr.write(String(error && error.stack || error));
  process.exit(1);
});
"""


def run_node(expression, fixture=FIXTURE):
    proc = subprocess.run(
        ['node', '-e', NODE_RUNNER, str(BUNDLE / 'app.js'), json.dumps(fixture), expression],
        capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        raise AssertionError('node evaluation failed:\n' + proc.stderr)
    return json.loads(proc.stdout)


BOOTSTRAP_RUNNER = """
const fs = require('fs');
function makeElement(id, attrs) {
  const attributes = Object.assign({}, attrs || {});
  const listeners = {};
  const el = {
    id: id,
    textContent: '', innerHTML: '', hidden: false, value: '', placeholder: '',
    disabled: false, className: '',
    classList: { add() {}, remove() {} },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    setAttribute(key, value) { attributes[key] = String(value); },
    getAttribute(key) { return key in attributes ? attributes[key] : null; },
    showModal() { el._open = true; },
    close() { el._open = false; },
  };
  el._listeners = listeners;
  return el;
}
const ids = ['freshness', 'status', 'refresh', 'open-settings', 'schema-note', 'alerts-section',
  'health', 'health-empty', 'fleet-table', 'fleet-body', 'fleet-empty', 'usage', 'usage-empty',
  'pipeline', 'pipeline-empty', 'backlog', 'backlog-empty', 'settings-dialog', 'settings-form',
  'setting-url', 'setting-token', 'forget-token', 'settings-close'];
const elements = {};
for (const id of ids) elements[id] = makeElement(id);
const keys = ['id', 'branch', 'model', 'state', 'elapsed'];
const sortButtons = keys.map(key => makeElement('sort-' + key, { 'data-sort': key }));
const ths = keys.map(key => makeElement('th-' + key, { 'data-sort-key': key, 'aria-sort': 'none' }));
globalThis.document = {
  getElementById: id => (id in elements ? elements[id] : null),
  querySelectorAll: selector => (selector === 'th button[data-sort]' ? sortButtons : selector === 'th[data-sort-key]' ? ths : []),
};
globalThis.location = { hash: '' };
globalThis.setInterval = () => 0;
(0, eval)(fs.readFileSync(process.argv[1], 'utf8'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// A fixed sleep races the async snapshot update (the fetch rejection lands in
// microtasks but can exceed 30 ms under load). Poll the status line until the
// pending update has settled instead.
const settled = async () => {
  for (let i = 0; i < 200; i++) {
    const text = elements.status.textContent;
    if (text && !/^(Connect|Refresh)/.test(text)) return;
    await wait(10);
  }
};
(async () => {
  await settled();
  const out = {};
  out.freshness = elements.freshness.textContent;
  out.freshnessClass = elements.freshness.className;
  out.fleetEmpty = elements['fleet-empty'].textContent;
  out.status = elements.status.textContent;
  out.tableHidden = elements['fleet-table'].hidden;
  elements['setting-url'].value = 'https://configured.invalid/snapshot.json';
  elements['setting-token'].value = 'tok-123';
  elements['settings-form']._listeners.submit[0]({ preventDefault() {} });
  await settled();
  out.dialogClosed = elements['settings-dialog']._open === false;
  out.tokenPlaceholderAfterSave = elements['setting-token'].placeholder;
  sortButtons[4]._listeners.click[0]();
  out.ariaSortElapsed = ths[4].getAttribute('aria-sort');
  elements['forget-token']._listeners.click[0]();
  out.tokenPlaceholderAfterForget = elements['setting-token'].placeholder;
  elements.refresh._listeners.click[0]();
  await settled();
  out.statusAfterRefresh = elements.status.textContent;
  return out;
})().then(value => {
  process.stdout.write(JSON.stringify(value), () => process.exit(0));
}, error => {
  process.stderr.write(String(error && error.stack || error));
  process.exit(1);
});
"""


def run_bootstrap():
    proc = subprocess.run(['node', '-e', BOOTSTRAP_RUNNER, str(BUNDLE / 'app.js')],
                          capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        raise AssertionError('bootstrap evaluation failed:\n' + proc.stderr)
    return json.loads(proc.stdout)


def view(now=NOW_MS, fixture=FIXTURE):
    return run_node('R.normalizeSnapshot(fixture, %d)' % now, fixture=fixture)


def bundle_source():
    return ''.join((BUNDLE / name).read_text() for name in ('index.html', 'app.js', 'styles.css'))


class StaticBundleAdmission(unittest.TestCase):
    def test_bundle_files_present_small_and_clean(self):
        # The runtime bundle stays three files; DESIGN-v2.md and mockup-v2/
        # are Observatory-v2 design-spike artifacts that live beside it.
        names = sorted(item.name for item in BUNDLE.iterdir())
        self.assertEqual(
            names,
            ['DESIGN-v2.md', 'app.js', 'index.html', 'mockup-v2', 'styles.css'])
        total = 0
        for name in ('app.js', 'index.html', 'styles.css'):
            path = BUNDLE / name
            self.assertFalse(path.is_symlink(), name + ' must not be a symlink')
            self.assertTrue(path.is_file())
            total += path.stat().st_size
        self.assertLess(total, 20 * 1024 * 1024)

    def test_relative_assets_only(self):
        html = (BUNDLE / 'index.html').read_text()
        refs = re.findall(r'(?:src|href)\s*=\s*"([^"]+)"', html)
        self.assertEqual(set(refs), {'./styles.css', './app.js', '#main'})
        scripts = re.findall(r'<script\b([^>]*)>', html)
        self.assertEqual(len(scripts), 1)
        self.assertIn('src="./app.js"', scripts[0])
        self.assertNotIn('onclick', html)
        for name in ('index.html', 'app.js', 'styles.css'):
            source = (BUNDLE / name).read_text()
            self.assertNotIn('http://', source, name)
            self.assertNotIn('https://', source, name)
            self.assertNotIn('src="//', source, name)
        css = (BUNDLE / 'styles.css').read_text()
        self.assertNotIn('@import', css)
        self.assertNotIn('url(', css)

    def test_no_credentials_or_private_endpoints_in_code(self):
        app = (BUNDLE / 'app.js').read_text()
        html = (BUNDLE / 'index.html').read_text()
        self.assertEqual(len(re.findall(r'\bBearer\b', app)), 1, 'Bearer must appear only in the header construction')
        self.assertIn("'Bearer ' + token", app)
        self.assertEqual(re.findall(r'\bBearer\b', html), ['Bearer'], 'the only page Bearer mention is the field label')
        self.assertNotRegex(app, r'Bearer\s+[A-Za-z0-9_\-.]{16,}')
        self.assertNotRegex(app, r'(?i)\b(api[_-]?key|secret|passwd)\b\s*[:=]\s*["\']')
        for match in re.findall(r'["\']([A-Za-z0-9_-]{32,})["\']', app):
            self.fail('suspicious credential-like literal in bundle: ' + match)
        self.assertIn('rizzstack.observatory.token', app)
        self.assertIn('rizzstack.observatory.snapshot_url', app)

    def test_no_logging_calls(self):
        self.assertNotIn('console.', bundle_source())

    def test_publisher_accepts_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'source'
            shutil.copytree(BUNDLE, source)
            command = ['python3', str(PUBLISH), str(source), '--id', 'rizzstack-observatory',
                       '--version', '1.0.0', '--title', 'Rizzstack Observatory', '--runtime', str(root / 'runtime')]
            proc = subprocess.run(command, capture_output=True, text=True, timeout=120)
            self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
            manifest = json.loads(proc.stdout)
            self.assertEqual(manifest['apiVersion'], 1)
            self.assertEqual(manifest['id'], 'rizzstack-observatory')
            self.assertTrue(manifest['entry'].startswith('/apps/rizzstack-observatory-'))
            self.assertTrue(manifest['entry'].endswith('/index.html'))


class SnapshotRendering(unittest.TestCase):
    def test_fleet_table_renders_attempts(self):
        snapshot = view()
        rows = snapshot['fleet']
        self.assertEqual([row['id'] for row in rows], ['bee-a1', 'bee-b2', 'bee-c3'])
        self.assertEqual(rows[0]['branch'], 'feat/bee-usage-observability')
        self.assertEqual(rows[0]['model'], 'zoo/glm-5.3-flash')
        self.assertEqual(rows[0]['state'], 'running')
        self.assertEqual(rows[0]['elapsed'], '1m 33s')
        self.assertEqual(rows[1]['elapsed'], '2m 30s')
        self.assertEqual(rows[2]['elapsed'], '1h 00m')
        self.assertEqual(rows[0]['stateClass'], 'active')
        self.assertEqual(rows[1]['stateClass'], 'ok')
        self.assertEqual(rows[2]['stateClass'], 'bad')
        html = run_node('R.renderFleet(R.normalizeSnapshot(fixture, %d).fleet)' % NOW_MS)
        for expected in ('bee-a1', 'feat/bee-usage-observability', 'zoo/glm-5.3-flash', '1m 33s'):
            self.assertIn(expected, html)

    def test_usage_renders_unknown_costs_never_zero(self):
        snapshot = view()
        usage = snapshot['usage']
        self.assertTrue(usage['present'])
        self.assertEqual(usage['totals']['tokens'], 12345)
        self.assertFalse(usage['totals']['costKnown'])
        model_group = next(group for group in usage['groups'] if group['kind'] == 'model')
        costs = {item['label']: item for item in model_group['costs']}
        self.assertTrue(costs['zoo/glm-5.3-flash']['costKnown'])
        self.assertAlmostEqual(costs['zoo/glm-5.3-flash']['cost'], 0.42)
        self.assertFalse(costs['other/model']['costKnown'])
        html = run_node('R.renderUsage(R.normalizeSnapshot(fixture, %d).usage)' % NOW_MS)
        self.assertIn('UNKNOWN', html)
        self.assertIn('$0.42', html)
        self.assertNotIn('$0.00', html)
        self.assertEqual(run_node('R.formatCost(null)'), 'UNKNOWN')
        self.assertEqual(run_node('R.formatCost(undefined)'), 'UNKNOWN')
        self.assertEqual(run_node('R.formatCost(0)'), '$0.00')
        self.assertEqual(run_node('R.formatCost(0.0042)'), '$0.0042')

    def test_usage_without_cost_section_is_all_unknown(self):
        fixture = copy.deepcopy(FIXTURE)
        del fixture['usage']['cost']
        snapshot = view(fixture=fixture)
        html = run_node('R.renderUsage(R.normalizeSnapshot(fixture, %d).usage)' % NOW_MS, fixture=fixture)
        self.assertEqual(html.count('UNKNOWN'), 4 + 1)  # one per model/provider/repo entry plus the total
        self.assertNotIn('$', html)
        self.assertFalse(snapshot['usage']['totals']['costKnown'])

    def test_pipeline_renders_stages_and_reasons(self):
        snapshot = view()
        jobs = snapshot['pipeline']
        self.assertEqual(len(jobs), 1)
        task = jobs[0]['tasks'][0]
        self.assertEqual(task['escalation'], 'human review requested')
        self.assertEqual(task['blocker'], 'merge conflict')
        self.assertEqual(task['stages']['integrate']['reason'], 'conflict with main')
        self.assertEqual(task['stages']['verify']['state'], 'passed')
        self.assertEqual(jobs[0]['tasks'][1]['escalation'], '')
        html = run_node('R.renderPipeline(R.normalizeSnapshot(fixture, %d).pipeline)' % NOW_MS)
        for expected in ('Escalation: human review requested', 'Blocker: merge conflict',
                         'conflict with main', 'verify', 'integrate', 'accept', 'Quota guard'):
            self.assertIn(expected, html)
        self.assertEqual(html.count('Blocker:'), 1)

    def test_backlog_board_mirror(self):
        snapshot = view()
        columns = snapshot['backlog']
        self.assertEqual([column['name'] for column in columns], ['Todo', 'Doing', 'Done'])
        self.assertEqual(len(columns[0]['cards']), 1)
        html = run_node('R.renderBacklog(R.normalizeSnapshot(fixture, %d).backlog)' % NOW_MS)
        for expected in ('Todo', 'Add stale markers', 'bee-a1', '3 pts', 'Done'):
            self.assertIn(expected, html)

    def test_backlog_accepts_column_map_and_flat_cards(self):
        as_map = run_node('R.backlogColumns(fixture)', fixture={'board': {'Todo': [{'title': 'a'}], 'Doing': []}})
        self.assertEqual([column['name'] for column in as_map], ['Doing', 'Todo'])
        flat = run_node('R.backlogColumns(fixture)', fixture={'cards': [
            {'title': 'a', 'status': 'Todo'}, {'title': 'b', 'column': 'Doing'}, {'title': 'c'}]})
        self.assertEqual(flat[0]['name'], 'Todo')
        self.assertEqual(flat[1]['name'], 'Doing')
        self.assertEqual(flat[2]['name'], 'Unsorted')

    def test_health_strip(self):
        snapshot = view()
        chips = {chip['key']: chip for chip in snapshot['healthChips']}
        self.assertEqual(chips['launcher']['state'], 'ok')
        self.assertEqual(chips['launcher']['detail'], 'pid 4242')
        self.assertEqual(chips['docker']['state'], 'ok')
        self.assertEqual(chips['gateway']['state'], 'warn')
        self.assertIn('1.2.4', chips['gateway']['detail'])
        self.assertIn('1.2.3', chips['gateway']['detail'])
        self.assertEqual(chips['quota']['detail'], '3 / 10')
        self.assertEqual(chips['quota']['state'], 'ok')
        self.assertEqual(chips['scheduler']['state'], 'bad')
        self.assertIn('last beat', chips['scheduler']['detail'])
        html = run_node('R.renderHealth(R.normalizeSnapshot(fixture, %d).healthChips)' % NOW_MS)
        self.assertIn('3 / 10', html)
        self.assertIn('Gateway parity', html)

    def test_health_gateway_parity_variants(self):
        result = run_node('R.healthChips(fixture, %d)' % NOW_MS, fixture={'gateway': {'installed': '1.2.3', 'running': '1.2.3'}})
        self.assertEqual(result[0]['state'], 'ok')
        result = run_node('R.healthChips(fixture, %d)' % NOW_MS, fixture={'gateway': {'version': '1.2.4'}})
        self.assertEqual(result[0]['state'], 'unknown')
        result = run_node('R.healthChips(fixture, %d)' % NOW_MS, fixture={'quota': {'used': 10, 'max': 10}})
        self.assertEqual(result[0]['state'], 'bad')
        result = run_node('R.healthChips(fixture, %d)' % NOW_MS, fixture={'scheduler': {'alive': True}})
        self.assertEqual(result[0]['state'], 'ok')

    def test_alert_banners(self):
        snapshot = view()
        levels = [banner['level'] for banner in snapshot['alerts']]
        self.assertEqual(levels, ['error', 'warn', 'info'])
        self.assertEqual(snapshot['alerts'][2]['message'], 'Scheduler missed its heartbeat')
        html = run_node('R.renderAlerts(R.normalizeSnapshot(fixture, %d).alerts)' % NOW_MS)
        self.assertEqual(html.count('role="alert"'), 1)
        self.assertIn('Gateway version mismatch', html)
        self.assertIn('running 1.2.4 vs installed 1.2.3', html)
        self.assertIn('Scheduler missed its heartbeat', html)

    def test_stale_marker_badges(self):
        self.assertFalse(view()['stale'])
        self.assertTrue(view(now=NOW_MS + 20 * 60 * 1000)['stale'])
        fixture = copy.deepcopy(FIXTURE)
        del fixture['generated_at']
        self.assertIsNone(view(fixture=fixture)['stale'])

    def test_missing_sections_and_empty_states(self):
        snapshot = view(fixture={})
        self.assertFalse(any(snapshot['present'].values()))
        self.assertEqual(snapshot['fleet'], [])
        self.assertEqual(snapshot['pipeline'], [])
        self.assertEqual(snapshot['backlog'], [])
        self.assertEqual(snapshot['healthChips'], [])
        self.assertEqual(snapshot['alerts'], [])
        for renderer in ('renderFleet', 'renderPipeline', 'renderBacklog', 'renderHealth', 'renderUsage'):
            self.assertEqual(run_node('R.%s([])' % renderer), '')

    def test_invalid_documents(self):
        self.assertTrue(run_node('R.normalizeSnapshot(fixture).invalid', fixture='just a string'))
        self.assertTrue(run_node('R.normalizeSnapshot(fixture).invalid', fixture=None))
        self.assertTrue(run_node('R.normalizeSnapshot(fixture).invalid', fixture=[1, 2]))

    def test_schema_mismatch_banner_input(self):
        fixture = copy.deepcopy(FIXTURE)
        fixture['schema'] = 'rizzstack.observability/snapshot/2'
        snapshot = view(fixture=fixture)
        self.assertFalse(snapshot['schemaOk'])
        self.assertEqual(snapshot['schemaValue'], 'rizzstack.observability/snapshot/2')
        fixture = copy.deepcopy(FIXTURE)
        del fixture['schema']
        snapshot = view(fixture=fixture)
        self.assertIsNone(snapshot['schemaOk'])

    def test_rendering_escapes_snapshot_text(self):
        fixture = copy.deepcopy(FIXTURE)
        fixture['fleet']['attempts'] = [{'id': '<b>x&y</b>', 'branch': 'a"b', 'model': 'm', 'state': 'running'}]
        html = run_node('R.renderFleet(R.normalizeSnapshot(fixture, %d).fleet)' % NOW_MS, fixture=fixture)
        self.assertIn('&lt;b&gt;x&amp;y&lt;/b&gt;', html)
        self.assertIn('a&quot;b', html)
        self.assertNotIn('<b>', html)

    def test_fleet_sorting(self):
        rows = view()['fleet']
        descending = run_node('R.sortFleetRows(fixture, "elapsed", -1)', fixture=rows)
        self.assertEqual([row['id'] for row in descending], ['bee-c3', 'bee-b2', 'bee-a1'])
        ascending = run_node('R.sortFleetRows(fixture, "elapsed", 1)', fixture=rows)
        self.assertEqual([row['id'] for row in ascending], ['bee-a1', 'bee-b2', 'bee-c3'])


class SchemaShapeRendering(unittest.TestCase):
    """Rendering of the frozen rizzstack.observability/snapshot/1 shape the
    collector workflow emits: route labels instead of model keys, ISO
    started_at/updated_at timestamps, job_id/task_state pipeline rows,
    quota_row arrays and scheduler_health liveness."""

    def schema_view(self, now=NOW_MS, fixture=None):
        return run_node('R.normalizeSnapshot(fixture, %d)' % now, fixture=SCHEMA_FIXTURE if fixture is None else fixture)

    def test_fleet_model_column_renders_route(self):
        rows = self.schema_view()['fleet']
        self.assertEqual([row['id'] for row in rows], ['bee-a1', 'bee-c3', 'bee-d4'])
        self.assertEqual([row['model'] for row in rows], ['zoo/glm-5.3-flash', 'zoo/deepseek/go', 'go/llama-4'])
        html = run_node('R.renderFleet(R.normalizeSnapshot(fixture, %d).fleet)' % NOW_MS, fixture=SCHEMA_FIXTURE)
        for expected in ('zoo/glm-5.3-flash', 'zoo/deepseek/go', 'go/llama-4'):
            self.assertIn(expected, html)
        self.assertNotIn('[object Object]', html)

    def test_elapsed_derives_from_iso_timestamps(self):
        rows = self.schema_view()['fleet']
        self.assertEqual(rows[0]['elapsed'], '1m 33s')
        self.assertEqual(rows[1]['elapsed'], '50m 00s')
        self.assertEqual(rows[2]['elapsed'], '—')

    def test_timestamp_parser_consumes_collector_iso_variants(self):
        started_ms, updated_ms = NOW_MS - 93_000, NOW_MS
        variants = [
            (iso(started_ms), iso(updated_ms)),
            (iso(started_ms).replace('T', ' '), iso(updated_ms).replace('T', ' ')),
            (iso(started_ms)[:-1] + ',500Z', iso(updated_ms)[:-1] + ',500Z'),
            (iso(started_ms)[:-1] + ',500', iso(updated_ms)[:-1] + ',500'),
            (iso(started_ms).replace('-', '').replace(':', ''), iso(updated_ms).replace('-', '').replace(':', '')),
            (iso(started_ms)[:-1], iso(updated_ms)[:-1].replace('Z', '')),
            (iso(started_ms + 7_200_000)[:-1] + '+02:00', iso(updated_ms + 7_200_000)[:-1] + '+02:00'),
            (iso(started_ms + 7_200_000)[:-1] + '+0200', iso(updated_ms + 7_200_000)[:-1] + '+0200'),
        ]
        for started_text, updated_text in variants:
            fixture = {'fleet': {'attempts': [{'id': 'x', 'started_at': started_text, 'updated_at': updated_text}]}}
            elapsed = run_node('R.normalizeSnapshot(fixture).fleet[0].elapsed', fixture=fixture)
            self.assertEqual(elapsed, '1m 33s', (started_text, updated_text))

    def test_pipeline_renders_schema_jobs(self):
        jobs = self.schema_view()['pipeline']
        self.assertEqual([job['title'] for job in jobs], ['job-1', 'job-2', 'job-3'])
        self.assertEqual(jobs[0]['state'], 'blocked')
        self.assertEqual(jobs[0]['stateClass'], 'bad')
        self.assertEqual(jobs[0]['escalation'], 'needs_agent — capacity review')
        self.assertEqual(jobs[1]['state'], 'no tasks')
        self.assertEqual(jobs[1]['stateClass'], 'unknown')
        self.assertEqual(jobs[2]['state'], 'escalated')
        self.assertEqual(jobs[2]['escalation'], 'needs_owner_signoff')
        tasks = jobs[0]['tasks']
        self.assertEqual([task['id'] for task in tasks], ['task-1', 'task-2'])
        self.assertEqual([task['title'] for task in tasks], ['task-1', 'task-2'])
        self.assertEqual([task['state'] for task in tasks], ['blocked', 'completed'])
        self.assertEqual(tasks[0]['escalation'], 'human review requested')
        self.assertEqual(tasks[0]['blocker'], 'merge_conflict — conflict with main')
        self.assertEqual(tasks[1]['stages']['verify']['state'], 'passed')
        self.assertEqual(tasks[1]['stages']['integrate']['state'], 'integrated')
        self.assertEqual(tasks[1]['stages']['accept']['state'], 'accepted')
        html = run_node('R.renderPipeline(R.normalizeSnapshot(fixture, %d).pipeline)' % NOW_MS, fixture=SCHEMA_FIXTURE)
        for expected in ('job-1', 'job-2', 'job-3', 'No tasks in this job.', 'blocked', 'completed',
                         'verify', 'integrate', 'accept', 'conflict with main',
                         'Escalation: human review requested', 'Escalation: needs_agent — capacity review',
                         'Escalation: needs_owner_signoff', 'Blocker: merge_conflict — conflict with main'):
            self.assertIn(expected, html)
        self.assertNotIn('(unnamed job)', html)
        self.assertNotIn('[object Object]', html)

    def test_alerts_section_renders_active_rows(self):
        snapshot = self.schema_view()
        self.assertTrue(snapshot['present']['alerts'])
        self.assertEqual([banner['level'] for banner in snapshot['alerts']], ['warn'])
        self.assertEqual(snapshot['alerts'][0]['message'], 'Tool call quota above 90%')
        self.assertIn('950', snapshot['alerts'][0]['detail'])
        self.assertIn('900', snapshot['alerts'][0]['detail'])
        html = run_node('R.renderAlerts(R.normalizeSnapshot(fixture, %d).alerts)' % NOW_MS, fixture=SCHEMA_FIXTURE)
        self.assertIn('Tool call quota above 90%', html)
        self.assertNotIn('[object Object]', html)

    def test_alerts_unavailable_section_surfaces_error(self):
        fixture = {'alerts': {'status': 'unavailable', 'error': 'alerts source refused',
                              'collected_at': iso(NOW_MS), 'active': []}}
        snapshot = self.schema_view(fixture=fixture)
        self.assertEqual([banner['level'] for banner in snapshot['alerts']], ['error'])
        self.assertEqual(snapshot['alerts'][0]['message'], 'alerts source refused')

    def test_section_escalations_and_blockers_thread_to_jobs_and_tasks(self):
        jobs = self.schema_view()['pipeline']
        self.assertIn('needs_agent', jobs[0]['escalation'])
        self.assertIn('capacity review', jobs[0]['escalation'])
        self.assertEqual(jobs[2]['escalation'], 'needs_owner_signoff')
        self.assertEqual(jobs[2]['state'], 'escalated')
        tasks = jobs[0]['tasks']
        self.assertEqual(tasks[0]['escalation'], 'human review requested')
        self.assertIn('merge_conflict', tasks[0]['blocker'])
        self.assertIn('conflict with main', tasks[0]['blocker'])
        self.assertEqual(tasks[1]['escalation'], '')
        self.assertEqual(tasks[1]['blocker'], '')
        html = run_node('R.renderPipeline(R.normalizeSnapshot(fixture, %d).pipeline)' % NOW_MS, fixture=SCHEMA_FIXTURE)
        self.assertIn('Escalation: needs_agent', html)
        self.assertIn('Blocker: merge_conflict', html)

    def test_job_state_aggregation_variants(self):
        def aggregate(jobs_fixture):
            return run_node('R.pipelineJobs(fixture).map(job => job.state)', fixture={'jobs': jobs_fixture})
        self.assertEqual(aggregate([{'job_id': 'j', 'tasks': [
            {'task_id': 't1', 'task_state': 'completed'}, {'task_id': 't2', 'task_state': 'running'}]}]),
            ['running'])
        self.assertEqual(aggregate([{'job_id': 'j', 'tasks': [{'task_id': 't', 'task_state': 'waiting'}]}]),
            ['waiting'])
        self.assertEqual(aggregate([{'job_id': 'j', 'tasks': [
            {'task_id': 't1', 'task_state': 'completed'}, {'task_id': 't2', 'task_state': 'failed'}]}]),
            ['failed'])
        self.assertEqual(aggregate([{'job_id': 'j', 'tasks': [], 'escalations': [{'state': 'accepted'}]}]),
            ['completed'])
        self.assertEqual(aggregate([{'job_id': 'j'}]), ['no tasks'])
        self.assertEqual(aggregate([{'job_id': 'j', 'state': 'paused'}]), ['paused'])

    def test_health_quota_array_renders_rows_per_kind(self):
        chips = {chip['key']: chip for chip in self.schema_view()['healthChips']}
        self.assertEqual(chips['quota:worker_pool']['detail'], '5 / 20 tasks · 12 free')
        self.assertEqual(chips['quota:worker_pool']['state'], 'ok')
        self.assertEqual(chips['quota:tool_calls']['detail'], '950 / 1000 calls')
        self.assertEqual(chips['quota:tool_calls']['state'], 'warn')
        self.assertEqual(chips['scheduler']['state'], 'ok')
        self.assertIn('alive', chips['scheduler']['detail'])
        self.assertIn('last event 42s ago', chips['scheduler']['detail'])
        html = run_node('R.renderHealth(R.normalizeSnapshot(fixture, %d).healthChips)' % NOW_MS, fixture=SCHEMA_FIXTURE)
        self.assertIn('5 / 20 tasks · 12 free', html)
        self.assertIn('950 / 1000 calls', html)
        self.assertNotIn('[object Object]', html)

    def test_quota_row_status_drives_state(self):
        fixture = {'quota': [{'kind': 'gpu', 'value': 10, 'cap': 10, 'status': 'exhausted'}]}
        chips = run_node('R.healthChips(fixture, %d)' % NOW_MS, fixture=fixture)
        self.assertEqual(chips[0]['key'], 'quota:gpu')
        self.assertEqual(chips[0]['state'], 'bad')
        self.assertEqual(chips[0]['detail'], '10 / 10')
        self.assertEqual(run_node('R.healthChips(fixture, %d)' % NOW_MS, fixture={'quota': []}), [])

    def test_scheduler_liveness_and_event_age_variants(self):
        chips = run_node('R.healthChips(fixture, %d)' % NOW_MS, fixture={'scheduler': {'liveness': 'stale', 'last_event_age_s': 30}})
        self.assertEqual(chips[0]['state'], 'warn')
        chips = run_node('R.healthChips(fixture, %d)' % NOW_MS, fixture={'scheduler': {'last_event_age_s': 1200}})
        self.assertEqual(chips[0]['state'], 'warn')
        chips = run_node('R.healthChips(fixture, %d)' % NOW_MS, fixture={'scheduler': {'last_event_age_s': 30}})
        self.assertEqual(chips[0]['state'], 'ok')
        chips = run_node('R.healthChips(fixture, %d)' % NOW_MS, fixture={'scheduler': {'liveness': 'dead'}})
        self.assertEqual(chips[0]['state'], 'bad')

    def test_schema_snapshot_missing_fields_never_crash(self):
        fixture = {
            'schema': 'rizzstack.observability/snapshot/1',
            'fleet': {'attempts': [{'id': 'bee-x'}, None, 'str-row', 42]},
            'pipeline': {'jobs': [{'job_id': 'job-9', 'tasks': [None]}, {'job_id': 'job-10', 'tasks': [{'task_id': 't'}]}]},
            'health': {'quota': [None, {'kind': 'k'}], 'scheduler': None},
        }
        snapshot = self.schema_view(fixture=fixture)
        self.assertEqual(snapshot['fleet'][0]['model'], '')
        self.assertEqual(snapshot['fleet'][0]['elapsed'], '—')
        self.assertEqual(snapshot['pipeline'][0]['state'], 'no tasks')
        self.assertEqual(snapshot['pipeline'][1]['state'], 'unknown')
        for key, renderer in (('fleet', 'renderFleet'), ('pipeline', 'renderPipeline'),
                              ('healthChips', 'renderHealth')):
            html = run_node('R.%s(R.normalizeSnapshot(fixture, %d).%s)' % (renderer, NOW_MS, key), fixture=fixture)
            for bad in ('[object Object]', 'NaN', 'undefined'):
                self.assertNotIn(bad, html)

    def test_schema_snapshot_full_render_smoke(self):
        for key, renderer in (('fleet', 'renderFleet'), ('pipeline', 'renderPipeline'),
                              ('healthChips', 'renderHealth'), ('alerts', 'renderAlerts')):
            html = run_node('R.%s(R.normalizeSnapshot(fixture, %d).%s)' % (renderer, NOW_MS, key), fixture=SCHEMA_FIXTURE)
            self.assertTrue(html)
            for bad in ('[object Object]', 'NaN', 'undefined'):
                self.assertNotIn(bad, html)


class TokenAndRequestHandling(unittest.TestCase):
    def test_build_request_sends_token_only_as_header(self):
        result = run_node(
            '[R.buildRequest("https://x.invalid/snapshot.json", "tok"), R.buildRequest("https://x.invalid/snapshot.json", "")]',
            fixture=None)
        authorized, anonymous = result
        self.assertEqual(authorized['url'], 'https://x.invalid/snapshot.json')
        self.assertNotIn('tok', authorized['url'])
        self.assertEqual(authorized['init']['headers'], {'Authorization': 'Bearer tok'})
        self.assertEqual(authorized['init']['credentials'], 'omit')
        self.assertEqual(authorized['init']['cache'], 'no-store')
        self.assertEqual(anonymous['init']['headers'], {})

    def test_load_snapshot_uses_header_and_never_url_token(self):
        result = run_node(
            '(async () => { const calls = [];'
            ' const fake = (url, init) => { calls.push({ url, init });'
            '   return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(fixture) }); };'
            ' const result = await R.loadSnapshot({ url: "https://snap.invalid/snapshot.json", token: "tok", fetchImpl: fake });'
            ' return { url: calls[0].url, auth: calls[0].init.headers.Authorization,'
            '   schemaOk: result.snapshot.schemaOk, stale: result.snapshot.stale }; })()')
        self.assertEqual(result['auth'], 'Bearer tok')
        self.assertNotIn('tok', result['url'])
        self.assertTrue(result['schemaOk'])
        self.assertFalse(result['stale'])

    def test_load_snapshot_error_never_exposes_token(self):
        result = run_node(
            '(async () => { const fake = () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });'
            ' try { await R.loadSnapshot({ url: "https://snap.invalid/snapshot.json", token: "tok", fetchImpl: fake });'
            '   return { threw: false }; }'
            ' catch (error) { return { threw: true, message: String(error && error.message || error) }; } })()')
        self.assertTrue(result['threw'])
        self.assertIn('HTTP 401', result['message'])
        self.assertNotIn('tok', result['message'])

    def test_resolve_config_fragment_wins_and_ignores_fragment_token(self):
        fragment = '#orbit-config=' + json.dumps({'snapshot_url': 'https://cfg.invalid/snapshot.json', 'token': 'nope'})
        result = run_node('R.resolveConfig({ fragment: %s, storedUrl: "https://stored.invalid/snapshot.json" })' % json.dumps(fragment), fixture=None)
        self.assertEqual(result, {'snapshotUrl': 'https://cfg.invalid/snapshot.json', 'source': 'config'})
        self.assertNotIn('nope', json.dumps(result))
        self.assertNotIn('token', result)

    def test_resolve_config_precedence_and_default(self):
        result = run_node('R.resolveConfig({ fragment: "", storedUrl: "https://stored.invalid/snapshot.json" })', fixture=None)
        self.assertEqual(result['snapshotUrl'], 'https://stored.invalid/snapshot.json')
        self.assertEqual(result['source'], 'operator')
        result = run_node('R.resolveConfig({ fragment: "", storedUrl: "" })', fixture=None)
        self.assertEqual(result, {'snapshotUrl': './snapshot.json', 'source': 'default'})
        self.assertEqual(run_node('R.DEFAULT_SNAPSHOT_URL', fixture=None), './snapshot.json')

    def test_storage_helpers_are_optional_and_safe(self):
        result = run_node(
            '(() => { const map = new Map();'
            ' const stub = { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };'
            ' const throwing = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };'
            ' R.storageSet("k", "v", stub);'
            ' const got = R.storageGet("k", stub);'
            ' R.storageRemove("k", stub);'
            ' return { got, afterRemove: R.storageGet("k", stub),'
            '   setThrows: R.storageSet("k", "v", throwing), getThrows: R.storageGet("k", throwing),'
            '   available: R.storageAvailable(stub), unavailable: R.storageAvailable(throwing) }; })()',
            fixture=None)
        self.assertEqual(result['got'], 'v')
        self.assertIsNone(result['afterRemove'])
        self.assertFalse(result['setThrows'])
        self.assertIsNone(result['getThrows'])
        self.assertTrue(result['available'])
        self.assertFalse(result['unavailable'])

    def test_token_keys_are_named_storage_only(self):
        source = (BUNDLE / 'app.js').read_text()
        # The config fragment is only ever read (never written); the token
        # travels exclusively through the Authorization header and localStorage.
        self.assertEqual(source.count('CONFIG_FRAGMENT_PREFIX'), 4)  # definition, two reads, export
        self.assertEqual(source.count('location.hash'), 1)
        self.assertNotRegex(source, r'location\.hash\s*=')
        self.assertIn('TOKEN_STORAGE_KEY', source)
        self.assertIn('URL_STORAGE_KEY', source)


class RealSnapshotFetch(unittest.TestCase):
    def test_load_snapshot_against_local_http(self):
        captured = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                captured.append((self.path, self.headers.get('Authorization')))
                body = json.dumps(FIXTURE).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = 'http://127.0.0.1:%d/snapshot.json' % server.server_port
            schema_ok = run_node(
                'R.loadSnapshot({ url: %s, token: %s }).then(loaded => loaded.snapshot.schemaOk)'
                % (json.dumps(url), json.dumps(TOKEN)))
            self.assertTrue(schema_ok)
            self.assertEqual(captured, [('/snapshot.json', 'Bearer ' + TOKEN)])
        finally:
            server.shutdown()
            server.server_close()


class BootstrapSmoke(unittest.TestCase):
    """Drives the real bootstrap() against a minimal DOM stub: element wiring,
    settings flow, sorting, error handling and storage-degradation notes."""

    def test_bootstrap_wiring_and_error_states(self):
        out = run_bootstrap()
        self.assertEqual(out['freshness'], 'NO DATA')
        self.assertEqual(out['freshnessClass'], 'badge unknown')
        self.assertEqual(out['fleetEmpty'], 'No snapshot loaded yet.')
        self.assertIn('Snapshot unavailable', out['status'])
        self.assertIn('session-only', out['status'])
        self.assertTrue(out['tableHidden'])
        self.assertTrue(out['dialogClosed'])
        self.assertIn('Stored in this browser', out['tokenPlaceholderAfterSave'])
        self.assertEqual(out['ariaSortElapsed'], 'ascending')
        self.assertEqual(out['tokenPlaceholderAfterForget'], 'Not stored')
        self.assertIn('Snapshot unavailable', out['statusAfterRefresh'])


class AccessibilityAndTheme(unittest.TestCase):
    def test_labels_roles_and_keyboard_support(self):
        html = (BUNDLE / 'index.html').read_text()
        self.assertIn('aria-label="Refresh snapshot"', html)
        self.assertIn('aria-label="Open observatory settings"', html)
        self.assertIn('role="status"', html)
        self.assertIn('aria-live="polite"', html)
        self.assertIn('aria-labelledby="settings-title"', html)
        self.assertIn('<label for="setting-url">', html)
        self.assertIn('<label for="setting-token">', html)
        self.assertIn('aria-describedby="token-help"', html)
        self.assertIn('type="password"', html)
        self.assertIn('scope="col"', html)
        self.assertIn('<caption class="visually-hidden">', html)
        self.assertIn('class="skip-link"', html)
        for button in re.findall(r'<button\b([^>]*)>', html):
            self.assertIn('type=', button, 'every button declares an explicit type')
        self.assertEqual(html.count('<dialog'), 1)
        app = (BUNDLE / 'app.js').read_text()
        self.assertIn('aria-sort', app)

    def test_dark_theme_matches_orbit_palette(self):
        css = (BUNDLE / 'styles.css').read_text()
        self.assertIn('#0d0f14', css)
        self.assertIn('#11141b', css)
        self.assertIn('#232733', css)
        self.assertIn('#6d8cff', css)
        self.assertIn(':focus-visible', css)
        self.assertIn('.visually-hidden', css)
        self.assertIn('prefers-reduced-motion', css)


class RegistrationDocs(unittest.TestCase):
    def test_readme_documents_pane_registration(self):
        self.assertTrue(README.is_file())
        text = README.read_text()
        for expected in ('rizzstack.observability/snapshot/1', 'plugin_publish.py', 'plugin_install',
                         'plugin_enable', 'rizzstack-observatory', 'snapshot_url',
                         'rizzstack.observatory.token', 'localStorage', 'UNKNOWN', 'STALE',
                         'Authorization'):
            self.assertIn(expected, text)
        self.assertNotIn('http://', text)
        self.assertNotRegex(text, r'token["\s]*[:=]\s*["\'][A-Za-z0-9]')


if __name__ == '__main__':
    unittest.main(verbosity=2)
