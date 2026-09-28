"""Deterministic binding-invalidation race using real Workbench UI modules.

Run with the repository's Playwright Python environment. --source-ref ca7dd89
loads only that revision's pane-workbench.ts into the disposable fixture to
demonstrate the pre-fix failure; it never changes the working tree.
"""

import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = """
import { mountPaneWorkbench } from '/src/pane-workbench.ts';
import { createLiveTimeline } from '/src/agent-live-timeline.ts';
import { defaultPanePrefs } from '/src/pane-prefs.ts';
const body = document.querySelector('main');
const timeline = createLiveTimeline({storageKey: 'race-timeline'});
let binding = {profileId: 'default', sessionId: 'old-session', bindingRevision: 0};
let prefs = {...defaultPanePrefs(), mode: 'workbench', projectId: 'project-race',
  taskId: 'task-race', attemptId: 'attempt-race'};
const errors = [], badges = [], lanes = [];
let selections = 0, clicks = 0;
body.addEventListener('change', () => selections++);
body.addEventListener('click', () => clicks++);
const workbench = mountPaneWorkbench({
  paneId: 'pane-race', body, workspaceId: 'workspace-race',
  getToken: () => 'isolated-test-token', binding: () => binding,
  messages: () => [], prefs,
  onPrefs: patch => { prefs = {...prefs, ...patch}; },
  onBadge: badge => badges.push(badge), onLane: lane => lanes.push(lane),
  onError: error => errors.push(error), timeline,
});
window.race = {
  invalidate() {
    // Match acceptState: install the authoritative binding before invalidating.
    binding = {profileId: 'default', sessionId: 'accepted-session', bindingRevision: 1};
    workbench.invalidateBinding();
  },
  inspect: () => ({prefs, errors, selections, clicks, badges: badges.length, lanes: lanes.length}),
  dispose() { workbench.dispose(); timeline.dispose(); },
};
workbench.setVisible(true);
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-ref', help='Historical pane-workbench.ts for negative control')
    args = parser.parse_args()
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    with tempfile.TemporaryDirectory(prefix='orbit-workbench-load-race-', dir='/tmp/opencode') as temp:
        fixture = Path(temp)
        shutil.copytree(ROOT / 'src', fixture / 'src')
        (fixture / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        (fixture / 'package.json').write_text('{"type":"module"}')
        if args.source_ref:
            source = subprocess.check_output(
                ['git', 'show', f'{args.source_ref}:src/pane-workbench.ts'], cwd=ROOT)
            (fixture / 'src/pane-workbench.ts').write_bytes(source)
        (fixture / 'index.html').write_text(
            '<!doctype html><html><body><main></main><script type="module" src="/fixture.js"></script></body></html>')
        (fixture / 'fixture.js').write_text(FIXTURE)
        # No production entrypoint, owner backend, proxy, or live workspace.
        (fixture / 'vite.config.js').write_text(
            'export default {cacheDir:".vite-cache",server:{hmr:false},optimizeDeps:{noDiscovery:true}};')
        with (fixture / 'vite.log').open('w+') as log:
            server = subprocess.Popen(
                [str(ROOT / 'node_modules/.bin/vite'), '--host', '127.0.0.1',
                 '--port', str(port), '--strictPort'], cwd=fixture,
                env={**os.environ, 'TMPDIR': temp}, stdout=log, stderr=subprocess.STDOUT)
            try:
                for _ in range(100):
                    if server.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(log.read())
                    try:
                        with urllib.request.urlopen(base, timeout=.5):
                            break
                    except OSError:
                        time.sleep(.1)
                else:
                    raise RuntimeError('Isolated Vite fixture did not become ready')
                run_browser(base)
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)
    print('PASS binding invalidation during panel import restores attempt activity at cursor zero; read-only, no reselection')


def run_browser(base):
    project = {'id': 'project-race', 'name': 'Race project', 'active': True}
    task = {'id': 'task-race', 'title': 'Race task', 'status': 'ready'}
    attempt = {'id': 'attempt-race', 'task_id': task['id'], 'status': 'ready'}
    execution = {'tasks': [task], 'candidates': [], 'definitions': [], 'jobs': [],
                 'evidence': [], 'reviews': [], 'submissions': []}
    replies = {
        ('/api/workbench', 'list'): {'projects': [project], 'bindings': []},
        ('/api/workbench/execution', 'execution_state'): execution,
        ('/api/workbench/context', 'list'): {'attempts': [attempt], 'contexts': []},
        ('/api/workbench/native', 'list'): {'grants': []},
        ('/api/workbench/native', 'cards_list'): {'cards': []},
        ('/api/workbench/workflow', 'integration_list'): {'integrations': []},
        ('/api/workbench/workflow', 'retention_plan'): {'plan': {}},
        ('/api/workbench/workflow', 'patch_list'): {'patches': []},
        ('/api/workbench/workflow', 'recipe_list'): {'recipes': [], 'bindings': []},
        ('/api/workbench/workflow', 'proposal_list'): {'proposals': [], 'next_after_id': None, 'total_count': 0},
    }
    event = {'version': 1, 'id': 'retained-patch', 'sequence': 1, 'at': 1,
             'authority': 'observed', 'category': 'files', 'kind': 'Private patch',
             'summary': 'Private patch retained before reload', 'status': 'completed'}
    live_page = {'version': 1, 'events': [event], 'after_sequence': 1,
                 'reset_required': False, 'has_more': False, 'project_generation': 1,
                 'snapshot': {'scope': 'attempt', 'attempt_id': attempt['id']},
                 'lane': {'agent_busy': False, 'job_busy': False, 'unknown': False}}
    requests, violations, page_errors, held_imports = [], [], [], []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
        context = browser.new_context(service_workers='block')
        page = context.new_page()
        page.on('pageerror', lambda error: page_errors.append(str(error)))

        def intercept(route):
            request = route.request
            url = urlsplit(request.url)
            if not request.url.startswith(base + '/'):
                violations.append(('external request', request.url))
                route.abort()
            elif url.path == '/src/workbench-execution.ts':
                # Hold the actual module response, not a stubbed mount. Both old
                # and replacement loads must await this same dynamic import.
                held_imports.append(route)
            elif url.path.startswith('/api/'):
                payload = request.post_data_json or {}
                key = (url.path, payload.get('action'))
                requests.append((key, payload))
                if request.method != 'POST' or request.headers.get('authorization') != 'Bearer isolated-test-token':
                    violations.append(('invalid owner request', key))
                if key == ('/api/workbench/live', 'stream'):
                    retained_page = {**live_page,
                                     'events': [event] if payload.get('after_sequence', 0) == 0 else []}
                    route.fulfill(status=200, content_type='text/event-stream',
                                  body='event: page\ndata: ' + json.dumps(retained_page) + '\n\n')
                elif key == ('/api/workbench/live', 'page'):
                    # A fulfilled SSE response ends after its retained page;
                    # allow the client's ordinary read-only disconnect fallback.
                    route.fulfill(status=200, json={
                        'ok': True, **live_page,
                        'events': [event] if payload.get('after_sequence', 0) == 0 else [],
                    })
                elif key in replies:
                    route.fulfill(status=200, json={'ok': True, **replies[key]})
                else:
                    # Strict read allowlist: any execution, model, or unexpected
                    # endpoint fails the test and never reaches a real backend.
                    violations.append(('unexpected API action', key))
                    route.fulfill(status=400, json={'ok': False, 'code': 'unexpected_test_action'})
            else:
                route.continue_()

        context.route('**/*', intercept)
        try:
            page.goto(base, wait_until='domcontentloaded')
            project_select = page.get_by_label('Workbench project', exact=True)
            attempt_select = page.get_by_label('Workbench attempt', exact=True)
            expect(project_select).to_have_value(project['id'])
            expect(attempt_select).to_have_value(attempt['id'])
            # Wait for the import request itself, not elapsed wall-clock time.
            deadline = time.monotonic() + 10
            while not held_imports and time.monotonic() < deadline:
                page.wait_for_timeout(10)
            assert len(held_imports) == 1, 'Execution module must be held after selectors populate'
            timeline = page.locator('.pane-workbench-live-slot .agent-live-timeline')
            expect(timeline).to_be_visible()
            expect(timeline.locator('.alt-connection')).to_have_text('')
            assert not any(key[0] == '/api/workbench/live' for key, _ in requests)
            assert not violations and not page_errors, (violations, page_errors)

            page.evaluate('window.race.invalidate()')
            # Unblock the real module for both suspended loads. There is no UI
            # Refresh, scope change, second setVisible(), or manual load retry.
            for route in held_imports:
                route.continue_()
            expect(timeline).to_contain_text('Private patch retained before reload', timeout=5000)
            streams = [body for key, body in requests if key == ('/api/workbench/live', 'stream')]
            assert streams and streams[0] == {
                'workspace_id': 'workspace-race', 'project_id': project['id'],
                'attempt_id': attempt['id'], 'action': 'stream', 'after_sequence': 0, 'limit': 200,
            }, streams
            cards = [body for key, body in requests if key == ('/api/workbench/native', 'cards_list')]
            assert cards[0]['session_id'] == 'old-session', cards
            assert any(body['session_id'] == 'accepted-session' for body in cards), cards
            for action in ('recipe_list', 'proposal_list'):
                reads = [body for key, body in requests if key == ('/api/workbench/workflow', action)]
                assert reads and all(body == {
                    'workspace_id': 'workspace-race', 'project_id': project['id'], 'action': action,
                } for body in reads), (action, reads)
            expect(project_select).to_have_value(project['id'])
            expect(attempt_select).to_have_value(attempt['id'])
            state = page.evaluate('window.race.inspect()')
            assert state['clicks'] == state['selections'] == 0, state
            assert state['prefs']['attemptId'] == attempt['id'], state
            assert not state['errors'] and not page_errors and not violations, (state, page_errors, violations)
            page.evaluate('window.race.dispose()')
        finally:
            context.close()
            browser.close()


if __name__ == '__main__':
    main()
