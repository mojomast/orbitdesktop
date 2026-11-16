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
(async () => {
  await wait(30);
  const out = {};
  out.freshness = elements.freshness.textContent;
  out.freshnessClass = elements.freshness.className;
  out.fleetEmpty = elements['fleet-empty'].textContent;
  out.status = elements.status.textContent;
  out.tableHidden = elements['fleet-table'].hidden;
  elements['setting-url'].value = 'https://configured.invalid/snapshot.json';
  elements['setting-token'].value = 'tok-123';
  elements['settings-form']._listeners.submit[0]({ preventDefault() {} });
  await wait(30);
  out.dialogClosed = elements['settings-dialog']._open === false;
  out.tokenPlaceholderAfterSave = elements['setting-token'].placeholder;
  sortButtons[4]._listeners.click[0]();
  out.ariaSortElapsed = ths[4].getAttribute('aria-sort');
  elements['forget-token']._listeners.click[0]();
  out.tokenPlaceholderAfterForget = elements['setting-token'].placeholder;
  elements.refresh._listeners.click[0]();
  await wait(30);
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
        names = sorted(item.name for item in BUNDLE.iterdir())
        self.assertEqual(names, ['app.js', 'index.html', 'styles.css'])
        total = 0
        for name in names:
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
