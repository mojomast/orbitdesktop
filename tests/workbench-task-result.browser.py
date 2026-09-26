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
                        second_grant_id = '22222222-2222-4222-8222-222222222223'
                        attempt_id = '33333333-3333-4333-8333-333333333333'
                        pane_id = '44444444-4444-4444-8444-444444444444'
                        task_id = '55555555-5555-4555-8555-555555555555'
                        candidate_id = '66666666-6666-4666-8666-666666666666'
                        evidence_id = '77777777-7777-4777-8777-777777777777'
                        job_id = '88888888-8888-4888-8888-888888888888'
                        acceptance_digest = 'd' * 64
                        result = {
                            'id': result_id, 'availability': 'available', 'unavailable_reason': None,
                            'text': '<img src=x onerror=alert(1)> evidence:' + evidence_id,
                            'hermes_completed': True, 'task_id': task_id, 'attempt_id': attempt_id,
                            'candidate_id': candidate_id, 'candidate_generation': 1, 'candidate_hash': 'a' * 64,
                            'received_at': 1000, 'retained_until': 9999999999999,
                            'project_generation': 1,
                            'recipient': {'pane_id': pane_id, 'profile_id': 'default', 'session_id': 'fixture'},
                            'provenance': {'version': 1, 'initiated_by': {'kind': 'native_agent', 'attempt_id': attempt_id, 'grant_id': grant_id, 'run_id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}, 'authorized_by': {'kind': 'owner_grant', 'grant_id': grant_id, 'authority_generation': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}, 'recorded_by': {'kind': 'comet_service', 'component': 'workbench-native-result', 'build_id': 'c' * 64}},
                            'model_suggested_references': [{'evidence_id': evidence_id}],
                            'resolved_references': [{'evidence_id': evidence_id, 'job_id': job_id, 'verdict': 'pass'}],
                        }
                        check_provenance = {'version': 1, 'initiated_by': result['provenance']['initiated_by'], 'authorized_by': result['provenance']['authorized_by'], 'recorded_by': {'kind': 'comet_service', 'component': 'workbench-check-recorder', 'build_id': 'c' * 64, 'verifier_id': 'node-test', 'verifier_hash': 'e' * 64}}
                        def api(route):
                            body = route.request.post_data_json
                            calls.append(body)
                            if body['action'] == 'list':
                                route.fulfill(json={'ok': True, 'grants': [{'id': grant_id, 'status': 'completed', 'candidate_id': candidate_id}, {'id': second_grant_id, 'status': 'completed', 'candidate_id': candidate_id}]})
                            elif body['action'] == 'status':
                                visible_result = result if mode['result'] == 'available' else ({**result, 'availability': 'explanation_unavailable', 'unavailable_reason': 'missing', 'text': None} if mode['result'] == 'missing' else ({**result, 'availability': 'pending', 'text': None} if mode['result'] == 'persistence' else None))
                                grant_status = 'result_pending' if mode['result'] == 'persistence' else 'running' if visible_result is None else 'completed'
                                if visible_result and body['grant_id'] == second_grant_id: visible_result = {**visible_result, 'text': 'Result from the newly selected attempt.'}
                                route.fulfill(json={'ok': True, 'grant': {'id': body['grant_id'], 'status': grant_status, 'acceptance_digest': acceptance_digest, 'pending_digest': 'b' * 64 if grant_status == 'result_pending' else None}, 'result': visible_result, 'toolcalls': [], 'health': {'healthy': True}})
                            elif body['action'] == 'result_deliver':
                                route.fulfill(json={'ok': True, 'card': {'id': '99999999-9999-4999-8999-999999999999'}})
                            elif body['action'] == 'result_retry':
                                mode['result'] = 'available'
                                route.fulfill(json={'ok': True, 'result': result, 'replayed': False})
                            else:
                                route.fulfill(status=400, json={'ok': False, 'code': 'invalid_request'})
                        page.route('**/api/workbench/native', api)
                        def execution_api(route):
                            body = route.request.post_data_json
                            if body['action'] == 'execution_state':
                                route.fulfill(json={'ok': True, 'tasks': [{'id': task_id, 'acceptance_version': 2, 'acceptance_digest': acceptance_digest, 'acceptance': {'required_checks': [{'definition_id': 'node-test', 'definition_digest': 'e' * 64, 'execution_profile_id': None, 'execution_profile': None}]}}], 'jobs': [{'id': job_id, 'candidate_id': candidate_id, 'candidate_hash': 'a' * 64, 'project_generation': 1, 'acceptance_version': 2, 'acceptance_digest': acceptance_digest, 'definition_id': 'node-test', 'definition_digest': 'e' * 64, 'execution_profile_id': None, 'execution_profile': None, 'created_at': 2000, 'status': 'completed'}], 'evidence': [], 'reviews': [{'id': '99999999-9999-4999-8999-999999999998', 'candidate_id': candidate_id, 'candidate_hash': 'a' * 64, 'review_identity': 'review-exact', 'decision': 'approved'}]})
                            elif body['action'] == 'candidate_get':
                                route.fulfill(json={'ok': True, 'candidate': {'id': candidate_id, 'hash': 'a' * 64, 'generation': 1, 'project_generation': 1}, 'review_identity': 'review-exact', 'review_evidence_ids': [evidence_id], 'acceptance_complete': True, 'target_changed': False})
                            elif body['action'] == 'job_get':
                                route.fulfill(json={'ok': True, 'job': {'id': job_id, 'status': 'completed', 'provenance': check_provenance}, 'evidence': [{'id': evidence_id, 'job_id': job_id, 'candidate_id': candidate_id, 'candidate_hash_before': 'a' * 64, 'candidate_hash_after': 'a' * 64, 'project_generation': 1, 'acceptance_digest': acceptance_digest, 'verdict': 'pass', 'revoked': False, 'superseded': False, 'provenance': check_provenance}]})
                            else:
                                route.fulfill(status=400, json={'ok': False, 'code': 'invalid_request'})
                        page.route('**/api/workbench/execution', execution_api)
                        page.goto(origin)
                        page.evaluate("""async () => {
                          const {mountWorkbenchTaskResult} = await import('/src/workbench-task-result.ts');
                          const container = document.createElement('main'); document.body.replaceChildren(container);
                           window.ownerToken='fixture-token';
                           window.resultPanel = mountWorkbenchTaskResult({container, token:()=>window.ownerToken, workspace_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', project_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'});
                        }""")
                        expect(page.get_by_text('Agent explanation')).to_be_visible()
                        expect(page.locator('.workbench-result-text')).to_contain_text('<img src=x onerror=alert(1)>')
                        assert page.locator('.workbench-result-text img').count() == 0
                        expect(page.get_by_text('Recorded checks')).to_be_visible()
                        expect(page.get_by_text('Complete for this exact candidate and acceptance revision')).to_be_visible()
                        expect(page.get_by_text('latest complete pass', exact=True)).to_be_visible()
                        expect(page.get_by_text('Comet check recorder · node-test').first).to_be_visible()
                        expect(page.get_by_text('Human review')).to_be_visible()
                        expect(page.get_by_text('Supervised native worker', exact=True)).to_be_visible()
                        expect(page.get_by_text('Comet service recorder (workbench-native-result)')).to_be_visible()
                        expect(page.get_by_text('Show provenance identifiers')).to_be_visible()
                        deliver_button = page.get_by_role('button', name='Create a host-authored result card; this does not send content to a model')
                        expect(deliver_button).to_be_enabled()
                        expect(page.get_by_role('button', name=f'Open evidence {evidence_id}')).to_be_disabled()
                        deliver_button.click()
                        expect(page.get_by_text('Host-authored result card recorded for the originating conversation. No model request was sent.')).to_be_visible()
                        delivered = next(call for call in calls if call['action'] == 'result_deliver')
                        assert delivered['result_id'] == result_id
                        assert (delivered['pane_id'], delivered['profile_id'], delivered['session_id']) == (pane_id, 'default', 'fixture')
                        page.wait_for_timeout(20)
                        page.get_by_role('button', name='Create a host-authored result card; this does not send content to a model').click()
                        page.wait_for_timeout(20)
                        deliveries = [call for call in calls if call['action'] == 'result_deliver']
                        assert len(deliveries) == 2 and deliveries[0]['op_id'] == deliveries[1]['op_id'], deliveries
                        assert not any(call['action'] in ('send', 'submit', 'chat') for call in calls)
                        page.evaluate(f"""() => {{
                          document.querySelector('[aria-label="Read durable status and result without retrying the native run"]').click();
                          const select=document.querySelector('[aria-label="Result native attempt"]');select.value={json.dumps(second_grant_id)};select.dispatchEvent(new Event('change',{{bubbles:true}}));
                        }}""")
                        page.wait_for_timeout(100)
                        expect(page.locator('.workbench-result-text')).to_contain_text('Result from the newly selected attempt.', timeout=7000)
                        page.get_by_label('Result native attempt').select_option(grant_id)
                        expect(page.locator('.workbench-result-text')).to_contain_text('<img src=x onerror=alert(1)>')
                        mode['result'] = 'missing'
                        page.get_by_role('button', name='Read durable status and result without retrying the native run').click()
                        expect(page.get_by_text('Unavailable (missing)', exact=True)).to_be_visible()
                        expect(page.locator('.workbench-result-text')).to_contain_text('No explanation text was recorded.')
                        expect(page.get_by_role('button', name='Create a host-authored result card; this does not send content to a model')).to_be_disabled()
                        mode['result'] = 'none'
                        page.get_by_role('button', name='Read durable status and result without retrying the native run').click()
                        expect(page.get_by_text('No durable result is available yet. Refresh status to read; execution is never retried by refresh.')).to_be_visible()
                        mode['result'] = 'persistence'
                        page.get_by_role('button', name='Read durable status and result without retrying the native run').click()
                        expect(page.get_by_text('Persistence pending', exact=True)).to_be_visible()
                        retry = page.get_by_role('button', name='Retry database-only finalization for this exact pending receipt')
                        expect(retry).to_be_enabled()
                        retry.click()
                        expect(page.locator('.workbench-result-text')).to_contain_text('<img src=x onerror=alert(1)>')
                        retried = next(call for call in calls if call['action'] == 'result_retry')
                        assert retried['result_id'] == result_id and retried['expected_digest'] == 'b' * 64
                        assert not any(call['action'] == 'start' for call in calls)
                        page.evaluate("window.ownerToken='rotated-fixture-token'")
                        expect(page.locator('.workbench-result-text')).to_have_count(0,timeout=3000)
                        expect(page.get_by_text('Owner authorization changed. Refresh to read authorized results.')).to_be_visible()
                        page.evaluate('window.resultPanel.dispose()')
                        expect(page.locator('.workbench-task-result')).to_have_count(0)
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
