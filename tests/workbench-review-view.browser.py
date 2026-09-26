"""Isolated Chromium check for the scoped, literal-safe candidate review surface."""
import fcntl
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
TASK = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
CANDIDATE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
REVIEW = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
EVIDENCE_NODE = '11111111-1111-4111-8111-111111111111'
EVIDENCE_HOST = '22222222-2222-4222-8222-222222222222'
JOB_NODE = '33333333-3333-4333-8333-333333333333'
JOB_HOST = '44444444-4444-4444-8444-444444444444'
GRANT = '55555555-5555-4555-8555-555555555555'
HASH = 'a' * 64
ACCEPTANCE = 'b' * 64


def main():
    with open('/tmp/opencode/comet-next-heavy-check.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with tempfile.TemporaryDirectory(prefix='comet-luna-review-view-', dir='/tmp/opencode') as temporary:
            home = Path(temporary) / 'home'; home.mkdir()
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
            origin = f'http://127.0.0.1:{port}'
            env = {**os.environ, 'HOME': str(home)}
            with (Path(temporary) / 'vite.log').open('w+') as log:
                server = subprocess.Popen([shutil.which('node'), str(ROOT / 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', str(port), '--strictPort'], cwd=ROOT, env=env, stdout=log, stderr=log)
                try:
                    for _ in range(200):
                        if server.poll() is not None:
                            log.seek(0); raise RuntimeError('Vite exited: ' + log.read())
                        try: urllib.request.urlopen(origin, timeout=1).close(); break
                        except OSError: time.sleep(.05)
                    else: raise RuntimeError('Vite readiness timeout')

                    acceptance = {'required_checks_digest': 'f' * 64, 'required_checks': [
                        {'definition_id': 'node-test', 'definition_digest': 'c' * 64, 'execution_profile_id': None, 'execution_profile': None},
                        {'definition_id': 'host-regression', 'definition_digest': 'd' * 64, 'execution_profile_id': None, 'execution_profile': None},
                    ]}
                    candidate = {'id': CANDIDATE, 'task_id': TASK, 'hash': HASH, 'generation': 4, 'project_generation': 2}
                    evidence = [
                        {'id': EVIDENCE_NODE, 'job_id': JOB_NODE, 'definition_id': 'node-test', 'definition_digest': 'c' * 64, 'execution_profile_id': None, 'execution_profile': None, 'candidate_id': CANDIDATE, 'candidate_hash_before': HASH, 'candidate_hash_after': HASH, 'project_generation': 2, 'acceptance_digest': ACCEPTANCE, 'verdict': 'pass', 'revoked': False, 'superseded': False, 'provenance': {'recorded_by': {'kind': 'comet_service', 'verifier_id': 'node-test'}}},
                        {'id': EVIDENCE_HOST, 'job_id': JOB_HOST, 'definition_id': 'host-regression', 'definition_digest': 'd' * 64, 'execution_profile_id': None, 'execution_profile': None, 'candidate_id': CANDIDATE, 'candidate_hash_before': HASH, 'candidate_hash_after': HASH, 'project_generation': 2, 'acceptance_digest': ACCEPTANCE, 'verdict': 'pass', 'revoked': False, 'superseded': False, 'provenance': {'recorded_by': {'kind': 'comet_service', 'verifier_id': 'host-regression'}}},
                    ]
                    review = {'id': REVIEW, 'candidate_id': CANDIDATE, 'candidate_hash': HASH, 'review_identity': 'review-exact', 'decision': 'approved', 'evidence_ids': [EVIDENCE_NODE, EVIDENCE_HOST]}
                    state = {'ok': True, 'tasks': [{'id': TASK, 'title': 'Repair sum', 'acceptance_digest': ACCEPTANCE, 'acceptance': acceptance}], 'candidates': [candidate], 'reviews': [review], 'jobs': [{'id': JOB_NODE}, {'id': JOB_HOST}], 'evidence': evidence}
                    seen = []
                    with sync_playwright() as playwright:
                        browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
                        page = browser.new_page(viewport={'width': 1280, 'height': 900})

                        def api(route):
                            body = route.request.post_data_json; seen.append((route.request.url, body))
                            action = body.get('action')
                            if route.request.url.endswith('/execution'):
                                if action == 'execution_state': route.fulfill(json=state)
                                elif action == 'candidate_get': route.fulfill(json={'ok': True, 'candidate': candidate, 'review_identity': 'review-exact', 'review_evidence_ids': [EVIDENCE_NODE, EVIDENCE_HOST], 'acceptance_complete': True, 'target_changed': False})
                                elif action == 'job_get':
                                    job_id = body['job_id']; row = next(item for item in evidence if item['job_id'] == job_id)
                                    route.fulfill(json={'ok': True, 'job': {'id': job_id, 'status': 'completed'}, 'evidence': [row]})
                                else: route.fulfill(status=400, json={'ok': False, 'code': 'invalid_request'})
                            elif route.request.url.endswith('/workflow'):
                                route.fulfill(json={'ok': True, 'preview_id': '66666666-6666-4666-8666-666666666666', 'preview_digest': 'e' * 64, 'candidate_hash': HASH, 'candidate_generation': 4, 'source': {'manifest_hash': 'f' * 64}, 'review': {'required_check_state': {'complete': True, 'acceptance_digest': ACCEPTANCE, 'required_checks_digest': 'f' * 64}}, 'patch_text': '--- a/math.js\n+++ b/math.js\n-export const sum=(a,b)=>a-b;\n+export const sum=(a,b)=>a+b;\n<script>must remain literal</script>'})
                            elif route.request.url.endswith('/native'):
                                if action == 'list': route.fulfill(json={'ok': True, 'grants': [{'id': GRANT, 'candidate_id': CANDIDATE, 'task_id': TASK, 'created_at': 1}]})
                                elif action == 'status': route.fulfill(json={'ok': True, 'grant': {'id': GRANT}, 'result': {'availability': 'available', 'text': 'Literal worker explanation <img src=x onerror=alert(1)>'}})
                                else: route.fulfill(status=400, json={'ok': False, 'code': 'invalid_request'})

                        page.route('**/api/workbench/execution', api)
                        page.route('**/api/workbench/workflow', api)
                        page.route('**/api/workbench/native', api)
                        page.goto(origin)
                        page.evaluate("""async () => {
                          const {mountWorkbenchReviewView}=await import('/src/workbench-review-view.ts');
                          const container=document.createElement('main');document.body.replaceChildren(container);
                          window.reviewPanel=mountWorkbenchReviewView(container,{paneId:'review-pane-fixture',getToken:()=> 'fixture-owner-token',workspace_id:""" + repr(WORKSPACE) + """,project_id:""" + repr(PROJECT) + """});
                        }""")
                        expect(page.locator('.workbench-review-status')).to_contain_text('required checks complete')
                        expect(page.get_by_role('heading', name='Exact candidate diff')).to_be_visible()
                        expect(page.get_by_role('heading', name='Required checks and evidence')).to_be_visible()
                        expect(page.get_by_text('node-test', exact=True)).to_be_visible()
                        expect(page.get_by_text('host-regression', exact=True)).to_be_visible()
                        expect(page.locator('.workbench-review-diff-text')).to_contain_text('<script>must remain literal</script>')
                        assert page.locator('.workbench-review-diff-text script').count() == 0
                        page.get_by_text('Expand literal Hermes explanation').click()
                        expect(page.locator('.workbench-review-explanation-text')).to_contain_text('<img src=x onerror=alert(1)>')
                        assert page.locator('.workbench-review-explanation-text img').count() == 0
                        left = page.locator('.workbench-review-diff').bounding_box(); right = page.locator('.workbench-review-checks').bounding_box()
                        assert left['x'] + left['width'] <= right['x'] + 3, (left, right)
                        assert any(url.endswith('/workflow') and call['action'] == 'patch_preview' for url, call in seen)
                        assert not any(call['action'] in ('patch_export', 'patch_finalize_retry', 'patch_check_cancel', 'patch_acknowledge_unknown') for _, call in seen)
                        page.evaluate('window.reviewPanel.dispose()')
                        browser.close()
                finally:
                    server.terminate()
                    try: server.wait(timeout=5)
                    except subprocess.TimeoutExpired: server.kill(); server.wait()


if __name__ == '__main__': main()
