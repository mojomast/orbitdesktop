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
ATTEMPT = '77777777-7777-4777-8777-777777777777'
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
                        {'definition_id': 'node-test', 'definition_digest': 'c' * 64, 'execution_profile_id': 'profile-ready', 'execution_profile': {'dependency_hash': 'b' * 64}},
                        {'definition_id': 'host-regression', 'definition_digest': 'd' * 64, 'execution_profile_id': None, 'execution_profile': None},
                    ]}
                    candidate = {'id': CANDIDATE, 'task_id': TASK, 'hash': HASH, 'generation': 4, 'project_generation': 2}
                    evidence = [
                        {'id': EVIDENCE_NODE, 'job_id': JOB_NODE, 'definition_id': 'node-test', 'definition_digest': 'c' * 64, 'execution_profile_id': 'profile-ready', 'execution_profile': {'dependency_hash': 'b' * 64}, 'candidate_id': CANDIDATE, 'candidate_hash_before': HASH, 'candidate_hash_after': HASH, 'project_generation': 2, 'acceptance_digest': ACCEPTANCE, 'verdict': 'pass', 'revoked': False, 'superseded': False, 'test_results': {'valid': True, 'tests': 293, 'passed': 293, 'required_files': ['tests/alpha.test.mjs', 'tests/beta.test.mjs'], 'covered_files': ['tests/alpha.test.mjs', 'tests/beta.test.mjs']}, 'provenance': {'recorded_by': {'kind': 'comet_service', 'verifier_id': 'node-test'}}},
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
                                route.fulfill(json={'ok': True, 'preview_id': '66666666-6666-4666-8666-666666666666', 'preview_digest': 'e' * 64, 'candidate_hash': HASH, 'candidate_generation': 4, 'source': {'manifest_hash': 'f' * 64}, 'review': {'required_check_state': {'complete': True, 'acceptance_digest': ACCEPTANCE, 'required_checks_digest': 'f' * 64}}, 'verification_support': {'ready': True, 'reason': None, 'message': 'Prepared profile supported for this exact preview', 'candidate_hash': HASH, 'candidate_generation': 4, 'acceptance_digest': ACCEPTANCE, 'required_checks': []}, 'patch_text': '--- a/math.js\n+++ b/math.js\n-export const sum=(a,b)=>a-b;\n+export const sum=(a,b)=>a+b;\n<script>must remain literal</script>'})
                            elif route.request.url.endswith('/native'):
                                if action == 'list': route.fulfill(json={'ok': True, 'grants': [{'id': GRANT, 'candidate_id': CANDIDATE, 'attempt_id': ATTEMPT, 'project_generation': 2, 'created_at': 1}]})
                                elif action == 'status': route.fulfill(json={'ok': True, 'grant': {'id': GRANT, 'attempt_id': ATTEMPT}, 'result': {'attempt_id': ATTEMPT, 'task_id': TASK, 'candidate_id': CANDIDATE, 'candidate_hash': HASH, 'candidate_generation': 4, 'project_generation': 2, 'availability': 'available', 'text': 'Literal worker explanation <img src=x onerror=alert(1)> claims 999/999 tests and 60/60 files'}})
                                else: route.fulfill(status=400, json={'ok': False, 'code': 'invalid_request'})

                        page.route('**/api/workbench/execution', api)
                        page.route('**/api/workbench/workflow', api)
                        page.route('**/api/workbench/native', api)
                        page.goto(origin + '/?renderer=docking')
                        page.evaluate("""async () => {
                          const {mountWorkbenchReviewView}=await import('/src/workbench-review-view.ts');
                          const container=document.createElement('main');container.style.cssText='width:630px;height:510px;overflow:hidden';
                          const monitor=document.createElement('section');monitor.className='monitor';monitor.style.cssText='display:flex;width:622px;height:504px;font-size:19px';
                          const content=document.createElement('div');content.className='monitor-content';
                          const pane=document.createElement('div');pane.className='pane';
                          const head=document.createElement('div');head.className='pane-head';head.style.height='40px';
                          const body=document.createElement('div');body.className='pane-body';pane.append(head,body);content.append(pane);monitor.append(content);container.append(monitor);document.body.replaceChildren(container);
                          window.reviewPanel=mountWorkbenchReviewView(body,{paneId:'review-pane-fixture',getToken:()=> 'fixture-owner-token',workspace_id:""" + repr(WORKSPACE) + """,project_id:""" + repr(PROJECT) + """});
                        }""")
                        expect(page.locator('.workbench-review-status')).to_contain_text('2/2 required checks pass')
                        expect(page.locator('.workbench-review-status')).to_contain_text('artifact verification supported')
                        expect(page.locator('.workbench-review-recorder-counts')).to_have_text('Service-recorded checks · 293/293 tests passed · 2/2 required files covered')
                        assert '999' not in page.locator('.workbench-review-recorder-counts').inner_text()
                        page.locator('.workbench-review-metadata summary').click()
                        expect(page.locator('.workbench-review-metadata')).to_contain_text('Prepared profile supported')
                        page.locator('.workbench-review-metadata summary').click()
                        expect(page.get_by_role('heading', name='Exact candidate diff')).to_be_visible()
                        expect(page.get_by_role('heading', name='Required checks and evidence')).to_be_visible()
                        expect(page.get_by_text('node-test', exact=True)).to_be_visible()
                        expect(page.get_by_text('host-regression', exact=True)).to_be_visible()
                        expect(page.locator('.workbench-review-diff-text')).to_contain_text('<script>must remain literal</script>')
                        assert page.locator('.workbench-review-diff-text script').count() == 0
                        expect(page.locator('.workbench-review-summary')).to_contain_text('Repair sum')
                        expect(page.locator('.workbench-review-verdict').filter(has_text='PASS').first).to_be_visible()
                        clip = page.locator('.pane-body').bounding_box()
                        for selector in ('.workbench-review-diff-text', '.workbench-review-verdict'):
                            box = page.locator(selector).first.bounding_box()
                            assert clip['y'] <= box['y'] < clip['y'] + clip['height'], (selector, clip, box)
                        first_diff_line = page.locator('.workbench-review-diff-text').evaluate("node => { const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT); let text; while(text=walker.nextNode()){const at=text.textContent.indexOf('--- a/math.js'); if(at>=0){const range=document.createRange();range.setStart(text,at);range.setEnd(text,at+12);return range.getBoundingClientRect().toJSON();}} return null; }")
                        assert first_diff_line and clip['y'] <= first_diff_line['y'] < clip['y'] + clip['height'], (clip, first_diff_line)
                        page.get_by_text('Expand literal Hermes explanation').click()
                        expect(page.locator('.workbench-review-explanation-text')).to_contain_text('Literal worker explanation')
                        expect(page.locator('.workbench-review-explanation-text')).to_contain_text('999/999 tests and 60/60 files')
                        expect(page.locator('.workbench-review-explanation-text')).to_contain_text('<img src=x onerror=alert(1)>')
                        assert page.locator('.workbench-review-explanation-text img').count() == 0
                        left = page.locator('.workbench-review-diff').bounding_box(); right = page.locator('.workbench-review-checks').bounding_box()
                        assert left['x'] + left['width'] <= right['x'] + 3, (left, right)
                        assert any(url.endswith('/workflow') and call['action'] == 'patch_preview' for url, call in seen)
                        assert not any(call['action'] in ('patch_export', 'patch_finalize_retry', 'patch_check_cancel', 'patch_acknowledge_unknown') for _, call in seen)
                        page.evaluate('window.reviewPanel.dispose()')
                        page.evaluate("""async () => {
                          window.workflowRequests=[];window.exportStartedResolve=null;window.reviewEventDetail=null;window.revokedMode=false;
                          window.addEventListener('orbit-open-workbench-review',event=>window.reviewEventDetail=event.detail);
                          window.exportStarted=new Promise(resolve=>window.exportStartedResolve=resolve);
                          const respond=value=>Promise.resolve(new Response(JSON.stringify({ok:true,...value}),{status:200,headers:{'Content-Type':'application/json'}}));
                          window.fetch=(url,init={})=>{
                            const body=JSON.parse(init.body||'{}'),action=body.action;window.workflowRequests.push(action);
                            if(window.revokedMode&&['integration_list','retention_plan'].includes(action))return Promise.resolve(new Response(JSON.stringify({ok:false,code:'permission_denied'}),{status:403,headers:{'Content-Type':'application/json'}}));
                            if(url.endsWith('/execution'))return respond({reviews:[{id:REVIEW,candidate_id:CANDIDATE,task_id:TASK,decision:'approved'}]});
                            if(action==='integration_list')return respond({integrations:[]});
                            if(action==='retention_plan')return respond({counts:{},integrations:[],deletions:[],reason:'No deletion'});
                            if(action==='patch_list')return respond(window.revokedMode?{patches:[{artifact_id:'99999999-9999-4999-8999-999999999999',task_id:TASK,candidate_id:CANDIDATE,candidate_hash:HASH,candidate_generation:4,review_id:REVIEW,status:'verification_pending',artifact_hash:HASH,bytes:1,created_at:1,verification_status:'verified',recovery:{recovery_digest:HASH,recoverable:true,process_owned:false}}],total_count:1,truncated:false,next_after_id:null}:body.op_id||window.exportResolve?{patches:[{artifact_id:'99999999-9999-4999-8999-999999999999',task_id:TASK,candidate_id:CANDIDATE,candidate_hash:HASH,candidate_generation:4,review_id:REVIEW,status:'verifying',artifact_hash:HASH,bytes:1,created_at:1,verification_status:'pending',recovery:{recovery_digest:HASH,recoverable:false,process_owned:true}}],total_count:1,truncated:false,next_after_id:null}:{patches:[],total_count:0,truncated:false,next_after_id:null});
                             if(action==='patch_preview')return respond({preview_id:'66666666-6666-4666-8666-666666666666',preview_digest:'e'.repeat(64),expires_at:Date.now()+60000,candidate_hash:HASH,candidate_generation:4,patch_text:'--- a/math.js\\n+++ b/math.js\\n-old\\n+new',format:'git-unified-diff',source:{manifest_hash:HASH},candidate:{hash:HASH},review:{required_check_state:{acceptance_digest:'a'.repeat(64)}},verification_support:{ready:!window.unsupportedPreview,reason:window.unsupportedPreview?'dependency_artifact_missing':null,message:window.unsupportedPreview?'Dependency artifact missing':'Prepared profile supported',candidate_hash:HASH,candidate_generation:4,acceptance_digest:'a'.repeat(64),required_checks:[]},changes:[],exclusions:[],unsupported:[],roundtrip:{verified:true},bytes:30,artifact_hash:HASH});
                            if(action==='patch_export'){window.exportStartedResolve();return new Promise(resolve=>window.exportResolve=()=>resolve(new Response(JSON.stringify({ok:true,patch:{artifact_id:'99999999-9999-4999-8999-999999999999',status:'available',artifact_hash:HASH,bytes:1,roundtrip:{verified:true},verification:{status:'verified'},changes:[]}}),{status:200,headers:{'Content-Type':'application/json'}})));}
                            if(action==='patch_check_cancel')return respond({cancellation:{requested:true},patch:{status:'verifying'},recovery:{process_owned:true}});
                            return respond({patch:{status:'available'}});
                          };
                          const {mountWorkbenchWorkflow}=await import('/src/workbench-workflow.ts');
                          const container=document.querySelector('main');window.workflowPanel=mountWorkbenchWorkflow({container,token:()=> 'fixture-owner-token',workspace_id:WORKSPACE,project_id:PROJECT});
                        }""".replace('REVIEW',repr(REVIEW)).replace('CANDIDATE',repr(CANDIDATE)).replace('TASK',repr(TASK)).replace('HASH',repr(HASH)).replace('WORKSPACE',repr(WORKSPACE)).replace('PROJECT',repr(PROJECT)))
                        page.locator('button', has_text='Open trusted Review view').click()
                        assert page.evaluate('window.reviewEventDetail') == {'workspace_id': WORKSPACE, 'project_id': PROJECT}
                        page.locator('button', has_text='Preview reviewed patch').click()
                        expect(page.locator('button', has_text='Create private verified patch')).to_be_enabled()
                        page.evaluate('window.unsupportedPreview=true')
                        page.locator('button', has_text='Preview reviewed patch').click()
                        expect(page.locator('button', has_text='Create private verified patch')).to_be_disabled()
                        expect(page.locator('main')).to_contain_text('Dependency artifact missing')
                        page.evaluate('window.unsupportedPreview=false')
                        page.locator('button', has_text='Preview reviewed patch').click()
                        expect(page.locator('button', has_text='Create private verified patch')).to_be_enabled()
                        page.locator('button', has_text='Create private verified patch').click()
                        page.evaluate('window.exportStarted')
                        expect(page.locator('button', has_text='Request patch-check cancellation')).to_be_enabled(timeout=5000)
                        page.locator('button', has_text='Request patch-check cancellation').click()
                        page.wait_for_function("window.workflowRequests.includes('patch_check_cancel')")
                        assert page.evaluate("window.workflowRequests.indexOf('patch_check_cancel') > window.workflowRequests.indexOf('patch_export')")
                        page.evaluate('window.exportResolve()')
                        page.evaluate('window.workflowPanel.dispose()')
                        page.evaluate("""async () => {
                          window.workflowRequests=[];window.revokedMode=true;
                          const {mountWorkbenchWorkflow}=await import('/src/workbench-workflow.ts');
                          window.workflowPanel=mountWorkbenchWorkflow({container:document.querySelector('main'),token:()=> 'fixture-owner-token',workspace_id:WORKSPACE,project_id:PROJECT});
                        }""".replace('WORKSPACE',repr(WORKSPACE)).replace('PROJECT',repr(PROJECT)))
                        expect(page.locator('.workbench-patch-inventory')).to_contain_text('Historical recovery view')
                        expect(page.locator('.workbench-patch-inventory option')).to_have_count(1)
                        expect(page.locator('button', has_text='Finalize recorded patch checks')).to_be_enabled()
                        expect(page.locator('button', has_text='Preview private integration')).to_be_disabled()
                        assert 'execution_state' not in page.evaluate('window.workflowRequests')
                        page.locator('button', has_text='Finalize recorded patch checks').click()
                        page.wait_for_function("window.workflowRequests.includes('patch_finalize_retry')")
                        page.evaluate('window.workflowPanel.dispose()')
                        page.evaluate("""async () => {
                          window.ready=false;window.executionActions=[];
                          const respond=value=>Promise.resolve(new Response(JSON.stringify({ok:true,...value}),{status:200,headers:{'Content-Type':'application/json'}}));
                          window.fetch=(url,init)=>{
                            const body=JSON.parse(init.body);window.executionActions.push(body.action);
                            if(body.action==='execution_state')return respond({tasks:[{id:TASK,title:'Repair sum',status:'candidate_ready',acceptance_version:2,acceptance_digest:ACCEPTANCE,candidate_id:CANDIDATE}],candidates:[{id:CANDIDATE,task_id:TASK,hash:HASH,generation:4,files:[],exclusions:[],status:'approved'}],jobs:[],evidence:[],reviews:[],definitions:[{id:'node-test',executable:'node',args:[],limits:{},policy:''}],active_count:0,revoked:false,review_identity:{},target_changed:{},unknown_jobs:{},policy:'',execution:''});
                            if(body.action==='candidate_get')return respond({candidate:{id:CANDIDATE,hash:HASH,generation:4},readiness:{ready:window.ready,reason:window.ready?null:'dependency_artifact_missing',message:window.ready?'Prepared profile valid':'Dependency artifact missing',candidate_hash:HASH,candidate_generation:4,acceptance_digest:ACCEPTANCE,required_checks:[{definition_id:'node-test',execution_profile_id:'profile-ready',ready:window.ready,reason:window.ready?null:'dependency_artifact_missing',message:window.ready?'Ready':'Dependency artifact missing'}]}});
                            return respond({});
                          };
                          const {mountWorkbenchExecution}=await import('/src/workbench-execution.ts');
                          window.executionPanel=mountWorkbenchExecution({container:document.querySelector('main'),token:'fixture-owner-token',workspace_id:WORKSPACE,project_id:PROJECT});
                        }""".replace('TASK',repr(TASK)).replace('CANDIDATE',repr(CANDIDATE)).replace('HASH',repr(HASH)).replace('ACCEPTANCE',repr(ACCEPTANCE)).replace('WORKSPACE',repr(WORKSPACE)).replace('PROJECT',repr(PROJECT)))
                        expect(page.locator('.workbench-execution-candidate')).to_contain_text('Dependency artifact missing')
                        expect(page.get_by_role('button', name='Preview exact check specification')).to_be_disabled()
                        expect(page.get_by_role('button', name='Record owner approved review')).to_be_disabled()
                        page.evaluate('window.ready=true')
                        page.get_by_role('button', name='Refresh execution workbench').click()
                        expect(page.locator('.workbench-execution-candidate')).to_contain_text('Prepared profile valid')
                        expect(page.get_by_role('button', name='Preview exact check specification')).to_be_enabled()
                        expect(page.get_by_role('button', name='Record owner approved review')).to_be_enabled()
                        assert 'check_preview' not in page.evaluate('window.executionActions')
                        page.evaluate('window.executionPanel.dispose()')
                        page.evaluate("""async () => {
                          window.ready=false;window.authorityActions=[];
                          sessionStorage.setItem('orbit-hermes-chat:agent-pane',JSON.stringify({session:'fixture',profile_id:'default',messages:[]}));
                          const respond=value=>Promise.resolve(new Response(JSON.stringify({ok:true,...value}),{status:200,headers:{'Content-Type':'application/json'}}));
                          window.fetch=(url,init)=>{
                            const body=JSON.parse(init.body);window.authorityActions.push(body.action);
                            if(url.endsWith('/api/workbench'))return respond({surfaces:[{kind:'agent',pane_id:'agent-pane',name:'Agent'}]});
                            if(body.action==='execution_state')return respond({tasks:[{id:TASK,acceptance_digest:ACCEPTANCE,acceptance:{statement:'Repair sum',required_checks:[{definition_id:'node-test'}]}}],candidates:[{id:CANDIDATE,task_id:TASK,hash:HASH,generation:4,files:[]}],jobs:[],evidence:[]});
                            if(body.action==='candidate_get')return respond({candidate:{id:CANDIDATE,hash:HASH,generation:4},target_changed:false,readiness:{ready:window.ready,reason:window.ready?null:'execution_profile_stale',message:window.ready?'Profile ready':'Prepared profile stale',candidate_hash:HASH,candidate_generation:4,acceptance_digest:ACCEPTANCE,required_checks:[{definition_id:'node-test',execution_profile_id:'profile-ready',ready:window.ready,reason:window.ready?null:'execution_profile_stale',message:window.ready?'Ready':'Prepared profile stale'}]}});
                            if(body.action==='list'&&url.endsWith('/context'))return respond({attempts:[{id:'attempt-ready',task_id:TASK}],contexts:[]});
                            if(body.action==='list'&&url.endsWith('/native'))return respond({grants:[]});
                            if(body.action==='preview'&&url.endsWith('/native'))return respond({preview_id:'preview-ready',preview_digest:'f'.repeat(64),preview:{recipient:{native_runtime:{model:'fixture',commit:'fixture',destination:'fixture'}},required_checks:[{definition_id:'node-test'}],budget:{calls:20,checks:3,duration_ms:180000}}});
                            return respond({});
                          };
                          const {mountWorkbenchTaskAuthority}=await import('/src/workbench-task-authority.ts');
                          window.authorityPanel=mountWorkbenchTaskAuthority({container:document.querySelector('main'),token:()=> 'fixture-owner-token',workspace_id:WORKSPACE,project_id:PROJECT});
                        }""".replace('TASK',repr(TASK)).replace('CANDIDATE',repr(CANDIDATE)).replace('HASH',repr(HASH)).replace('ACCEPTANCE',repr(ACCEPTANCE)).replace('WORKSPACE',repr(WORKSPACE)).replace('PROJECT',repr(PROJECT)))
                        expect(page.get_by_label('Native agent recipient')).to_have_count(1)
                        page.get_by_role('button', name='Preview candidate read/edit and approved check authority').click()
                        expect(page.locator('.workbench-worker-handoff')).to_contain_text('Prepared profile stale')
                        assert 'preview' not in page.evaluate('window.authorityActions')
                        page.evaluate('window.ready=true')
                        page.get_by_role('button', name='Preview candidate read/edit and approved check authority').click()
                        expect(page.get_by_role('button', name='Approve exactly the previewed bounded task authority')).to_be_enabled()
                        page.evaluate('window.authorityPanel.dispose()')
                        browser.close()
                finally:
                    server.terminate()
                    try: server.wait(timeout=5)
                    except subprocess.TimeoutExpired: server.kill(); server.wait()


if __name__ == '__main__': main()
