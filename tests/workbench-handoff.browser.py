"""Isolated Chromium consumer test for the explicit native task handoff preview."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
PROJECT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
PANE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
TASK = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
CANDIDATE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
PACKET = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
SOURCE = '11111111-1111-4111-8111-111111111112'
ATTEMPT = '22222222-2222-4222-8222-222222222224'


def main():
    with open('/tmp/opencode/comet-next-heavy-check.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with tempfile.TemporaryDirectory(prefix='comet-luna-handoff-ui-', dir='/tmp/opencode') as temporary:
            home = Path(temporary) / 'home'
            home.mkdir()
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                port = probe.getsockname()[1]
            origin = f'http://127.0.0.1:{port}'
            env = {**os.environ, 'HOME': str(home)}
            with (Path(temporary) / 'vite.log').open('w+') as log:
                server = subprocess.Popen([shutil.which('node'), str(ROOT / 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', str(port), '--strictPort'], cwd=ROOT, env=env, stdout=log, stderr=log)
                try:
                    for _ in range(200):
                        if server.poll() is not None:
                            log.seek(0)
                            raise RuntimeError('Vite exited: ' + log.read())
                        try:
                            urllib.request.urlopen(origin, timeout=1).close()
                            break
                        except OSError:
                            time.sleep(.05)
                    else:
                        raise RuntimeError('Vite readiness timeout')

                    task = {'id': TASK, 'title': 'Repair arithmetic sum', 'acceptance_version': 3, 'acceptance_digest': 'a' * 64, 'acceptance': {'statement': 'sum must add its two inputs', 'required_checks': [{'definition_id': 'node-test'}]}}
                    candidate = {'id': CANDIDATE, 'task_id': TASK, 'generation': 2, 'hash': 'b' * 64, 'files': [{'path': 'math.js'}, {'path': 'math.test.js'}]}
                    contexts = [
                        {'id': PACKET, 'source': {'kind': 'packet'}, 'snapshot': {'hash': 'c' * 64, 'bytes': 184, 'captured_at': 1000, 'truncated': False, 'exclusions': [], 'provenance': {'context_ids': [SOURCE]}, 'manifest': {'question_bytes': 42}}, 'retention_until': 9999999999999, 'expired': False},
                        {'id': SOURCE, 'source': {'kind': 'file', 'resource_id': 'real-source-file'}, 'snapshot': {'hash': 'd' * 64, 'bytes': 64, 'captured_at': 900, 'truncated': False, 'exclusions': []}, 'retention_until': 9999999999999, 'expired': False},
                    ]
                    packet_text = json.dumps({'version': 1, 'owner_request': {'question': 'Repair the sum regression without changing unrelated behavior.'}, 'untrusted_sources': [{'context_id': SOURCE, 'kind': 'file', 'hash': 'd' * 64, 'captured_at': 900, 'truncated': False, 'exclusions': []}]})
                    scope = {'pane_id': PANE, 'profile_id': 'local-profile', 'session_id': 'fixture-session', 'native_runtime': {'kind': 'local-pinned', 'commit': '1' * 40, 'model': 'fixture-model-v1', 'destination': 'loopback configured model endpoint', 'configuration_hash': 'e' * 64}}
                    calls = []
                    with sync_playwright() as playwright:
                        browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
                        page = browser.new_page()
                        page.add_init_script("sessionStorage.setItem('orbit-hermes-chat:" + PANE + "', JSON.stringify({session:'fixture-session',profile_id:'local-profile',messages:[{role:'user',text:'DO NOT IMPORT THIS WHOLE CONVERSATION'}]}));")

                        def workbench_api(route):
                            request = route.request.post_data_json
                            if request.get('action') == 'list':
                                route.fulfill(json={'ok': True, 'surfaces': [{'pane_id': PANE, 'kind': 'agent', 'name': 'Origin chat'}]})
                            else:
                                route.fulfill(status=400, json={'ok': False, 'code': 'invalid_request'})

                        def execution_api(route):
                            body = route.request.post_data_json
                            calls.append(('execution', body))
                            if body['action'] == 'execution_state':
                                route.fulfill(json={'ok': True, 'tasks': [task], 'candidates': [candidate]})
                            elif body['action'] == 'candidate_get':
                                route.fulfill(json={'ok': True, 'candidate': candidate, 'target_changed': False, 'current_source_hash': 'f' * 64, 'acceptance_complete': True})
                            elif body['action'] == 'attempt_create':
                                route.fulfill(json={'ok': True, 'attempt': {'id': ATTEMPT, 'task_id': TASK}})
                            else:
                                route.fulfill(status=400, json={'ok': False, 'code': 'invalid_request'})

                        def context_api(route):
                            body = route.request.post_data_json
                            calls.append(('context', body))
                            if body['action'] == 'list':
                                route.fulfill(json={'ok': True, 'contexts': contexts, 'attempts': []})
                            elif body['action'] == 'preview':
                                route.fulfill(json={'ok': True, 'context_id': PACKET, 'hash': 'c' * 64, 'text': packet_text, 'recipient': scope, 'trusted_host': True, 'sandbox': False})
                            else:
                                route.fulfill(status=400, json={'ok': False, 'code': 'invalid_request'})

                        def native_api(route):
                            body = route.request.post_data_json
                            calls.append(('native', body))
                            if body['action'] == 'list':
                                route.fulfill(json={'ok': True, 'grants': []})
                            elif body['action'] == 'preview':
                                route.fulfill(json={'ok': True, 'preview_id': '33333333-3333-4333-8333-333333333333', 'preview_digest': '9' * 64, 'preview': {'recipient': scope, 'candidate_id': CANDIDATE, 'candidate_hash': candidate['hash'], 'budget': body['budget'], 'required_checks': [{'definition_id': 'node-test', 'execution_profile_id': None}]}})
                            elif body['action'] == 'approve':
                                route.fulfill(json={'ok': True, 'grant': {'id': '44444444-4444-4444-8444-444444444444'}})
                            else:
                                route.fulfill(status=400, json={'ok': False, 'code': 'invalid_request'})

                        page.route('**/api/workbench', workbench_api)
                        page.route('**/api/workbench/execution', execution_api)
                        page.route('**/api/workbench/context', context_api)
                        page.route('**/api/workbench/native', native_api)
                        page.goto(origin)
                        page.evaluate("""async () => {
                          const {mountWorkbenchTaskAuthority} = await import('/src/workbench-task-authority.ts');
                          const container=document.createElement('main');document.body.replaceChildren(container);
                          window.authority=mountWorkbenchTaskAuthority({container,token:()=> 'fixture-owner-token',workspace_id:""" + json.dumps(WORKSPACE) + """,project_id:""" + json.dumps(PROJECT) + """});
                          window.focusedAgent='';window.addEventListener('orbit-focus-agent',event=>window.focusedAgent=event.detail);
                        }""")
                        expect(page.get_by_text('Start a supervised worker for this task. It receives the approved task packet, not the whole conversation.')).to_be_visible()
                        expect(page.get_by_text('Repair arithmetic sum')).to_be_visible()
                        expect(page.get_by_text('sum must add its two inputs')).to_be_visible()
                        expect(page.get_by_text('DO NOT IMPORT THIS WHOLE CONVERSATION')).to_have_count(0)
                        expect(page.get_by_text('Repair the sum regression without changing unrelated behavior.')).to_have_count(0)
                        expect(page.get_by_text('No model/profile is inferred from conversation history.')).to_be_visible()
                        page.get_by_role('button', name='Focus the selected original agent pane').click()
                        assert page.evaluate('window.focusedAgent') == PANE
                        page.get_by_role('button', name='Bind selected candidate to the selected agent conversation').click()
                        page.get_by_label('Native approved context packet').select_option(PACKET)
                        expect(page.get_by_text('file · ' + SOURCE)).to_be_visible()
                        page.get_by_role('button', name='Preview candidate read/edit and approved check authority').click()
                        expect(page.get_by_text('Repair the sum regression without changing unrelated behavior.')).to_be_visible()
                        expect(page.get_by_text('Pinned Hermes ' + '1' * 40 + ' · model fixture-model-v1 · destination: loopback configured model endpoint')).to_be_visible()
                        expect(page.get_by_text('No shell or whole-conversation access.')).to_be_visible()
                        expect(page.get_by_text('inspect task, read candidate, apply expected-hash candidate changes, read selected packet')).to_be_visible()
                        page.get_by_role('button', name='Approve exactly the previewed bounded task authority').click()
                        approvals = [body for endpoint, body in calls if endpoint == 'native' and body['action'] == 'approve']
                        assert len(approvals) == 1
                        preview_requests = [body for endpoint, body in calls if endpoint == 'native' and body['action'] == 'preview']
                        assert preview_requests[-1]['context_ids'] == [PACKET]
                        browser.close()
                finally:
                    server.terminate()
                    try:
                        server.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        server.kill()
                        server.wait()


if __name__ == '__main__':
    main()
