"""Isolated Chromium consumer test for the result panel using a mocked owner API."""
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


def main():
    with open('/tmp/opencode/comet-next-heavy-check.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with tempfile.TemporaryDirectory(prefix='comet-luna-result-ui-', dir='/tmp/opencode') as temporary:
            home = Path(temporary) / 'home'
            home.mkdir()
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                port = probe.getsockname()[1]
            origin = f'http://127.0.0.1:{port}'
            env = {**os.environ, 'HOME': str(home), 'VITE_DISABLE_HMR': '1'}
            log_path = Path(temporary) / 'vite.log'
            with log_path.open('w+') as log:
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
                    with sync_playwright() as playwright:
                        browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
                        page = browser.new_page()
                        calls = []
                        mode = {'result': 'available'}
                        result_id = '11111111-1111-4111-8111-111111111111'
                        grant_id = '22222222-2222-4222-8222-222222222222'
                        attempt_id = '33333333-3333-4333-8333-333333333333'
                        pane_id = '44444444-4444-4444-8444-444444444444'
                        task_id = '55555555-5555-4555-8555-555555555555'
                        candidate_id = '66666666-6666-4666-8666-666666666666'
                        evidence_id = '77777777-7777-4777-8777-777777777777'
                        job_id = '88888888-8888-4888-8888-888888888888'
                        result = {
                            'id': result_id, 'availability': 'available', 'unavailable_reason': None,
                            'text': '<img src=x onerror=alert(1)> evidence:' + evidence_id,
                            'hermes_completed': True, 'task_id': task_id, 'attempt_id': attempt_id,
                            'candidate_id': candidate_id, 'candidate_generation': 1, 'candidate_hash': 'a' * 64,
                            'received_at': 1000, 'retained_until': 9999999999999,
                            'recipient': {'pane_id': pane_id, 'profile_id': 'default', 'session_id': 'fixture'},
                            'model_suggested_references': [{'evidence_id': evidence_id}],
                            'resolved_references': [{'evidence_id': evidence_id, 'job_id': job_id, 'verdict': 'pass'}],
                        }
                        def api(route):
                            body = route.request.post_data_json
                            calls.append(body)
                            if body['action'] == 'list':
                                route.fulfill(json={'ok': True, 'grants': [{'id': grant_id, 'status': 'completed', 'candidate_id': candidate_id}]})
                            elif body['action'] == 'status':
                                visible_result = result if mode['result'] == 'available' else ({**result, 'availability': 'explanation_unavailable', 'unavailable_reason': 'missing', 'text': None} if mode['result'] == 'missing' else None)
                                route.fulfill(json={'ok': True, 'grant': {'id': grant_id, 'status': 'running' if visible_result is None else 'completed'}, 'result': visible_result, 'toolcalls': [], 'health': {'healthy': True}})
                            elif body['action'] == 'result_deliver':
                                route.fulfill(json={'ok': True, 'card': {'id': '99999999-9999-4999-8999-999999999999'}})
                            else:
                                route.fulfill(status=400, json={'ok': False, 'code': 'invalid_request'})
                        page.route('**/api/workbench/native', api)
                        page.goto(origin)
                        page.evaluate("""async () => {
                          const {mountWorkbenchTaskResult} = await import('/src/workbench-task-result.ts');
                          const container = document.createElement('main'); document.body.replaceChildren(container);
                          window.resultPanel = mountWorkbenchTaskResult({container, token:'fixture-token', workspace_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', project_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'});
                        }""")
                        expect(page.get_by_text('Agent explanation')).to_be_visible()
                        expect(page.locator('.workbench-result-text')).to_contain_text('<img src=x onerror=alert(1)>')
                        assert page.locator('.workbench-result-text img').count() == 0
                        expect(page.get_by_text('Recorded checks')).to_be_visible()
                        expect(page.get_by_text('Human review')).to_be_visible()
                        deliver_button = page.get_by_role('button', name='Create a host-authored result card; this does not send content to a model')
                        expect(deliver_button).to_be_enabled()
                        expect(page.get_by_role('button', name=f'Open evidence {evidence_id}')).to_be_disabled()
                        deliver_button.click()
                        expect(page.get_by_text('Host-authored result card recorded for the originating conversation. No model request was sent.')).to_be_visible()
                        delivered = next(call for call in calls if call['action'] == 'result_deliver')
                        assert delivered['result_id'] == result_id
                        assert (delivered['pane_id'], delivered['profile_id'], delivered['session_id']) == (pane_id, 'default', 'fixture')
                        assert not any(call['action'] in ('send', 'submit', 'chat') for call in calls)
                        mode['result'] = 'missing'
                        page.get_by_role('button', name='Read durable status and result without retrying the native run').click()
                        expect(page.get_by_text('Unavailable (missing)', exact=True)).to_be_visible()
                        expect(page.locator('.workbench-result-text')).to_contain_text('No explanation text was recorded.')
                        expect(page.get_by_role('button', name='Create a host-authored result card; this does not send content to a model')).to_be_disabled()
                        mode['result'] = 'pending'
                        page.get_by_role('button', name='Read durable status and result without retrying the native run').click()
                        expect(page.get_by_text('No durable result is available yet. Refresh status to read; execution is never retried by refresh.')).to_be_visible()
                        assert not any(call['action'] == 'start' for call in calls)
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
