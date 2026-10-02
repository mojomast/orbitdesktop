"""Exercise the published simulator through Orbit's actual app handler/sandbox.

Disposable runtime and synthetic data only. No model invocation or owner APIs.
"""
from pathlib import Path
import hashlib
import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'examples/plugins/asteria-mission-control'
EVIDENCE = Path(os.environ.get('ASTERIA_BROWSER_EVIDENCE', '/tmp/opencode/asteria-simulator-acceptance'))
EVIDENCE.mkdir(parents=True, exist_ok=True)

with tempfile.TemporaryDirectory(prefix='orbit-asteria-browser-', dir='/tmp/opencode') as tmp:
    root = Path(tmp)
    runtime = root/'runtime'
    manifest = json.loads(subprocess.check_output(['python3', str(ROOT/'scripts/plugin_publish.py'),
        str(SOURCE), '--id', 'asteria-mission-control', '--version', '1.0.0',
        '--title', 'Asteria Mission Control', '--runtime', str(runtime)], text=True))
    with socket.socket() as probe:
        probe.bind(('127.0.0.1',0));port = probe.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    script = root/'server.mjs'
    script.write_text('''import http from 'node:http';
import {createWorkspaceService} from %s;
const port=%d,entry=%s;
const service=createWorkspaceService({root:%s,port,token:'synthetic-fixture',devOrigins:[],reply:(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}});
const server=http.createServer((req,res)=>{
 if(req.url.startsWith('/apps/'))return service.serveApp(req,res,new URL(req.url,'http://localhost').pathname);
 if(req.url!=='/'){res.writeHead(404);return res.end();}
 res.writeHead(200,{'Content-Type':'text/html'});
 res.end('<!doctype html><html><head><title>Isolated Asteria acceptance</title><style>html,body{margin:0;width:100%%;height:100%%}iframe{border:0;width:100%%;height:100%%;display:block}</style></head><body><iframe title="Mission simulator" sandbox="allow-scripts allow-forms allow-modals allow-downloads" src="'+entry+'"></iframe></body></html>');
});server.listen(port,'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>{service.close();process.exit(0);}));
''' % (json.dumps((ROOT/'server/workspace.mjs').as_uri()), port, json.dumps(manifest['entry']), json.dumps(str(runtime))))
    with (EVIDENCE/'server.log').open('w') as log:
        server = subprocess.Popen(['node','--experimental-strip-types',str(script)],cwd=ROOT,stdout=log,stderr=log)
        try:
            deadline = time.monotonic()+20
            while time.monotonic()<deadline:
                try:
                    urllib.request.urlopen(origin,timeout=1).close();break
                except OSError:
                    if server.poll() is not None:raise RuntimeError((EVIDENCE/'server.log').read_text())
                    time.sleep(.1)
            else:raise RuntimeError('Fixture did not start')
            with sync_playwright() as pw:
                browser = pw.chromium.launch(headless=True)
                context = browser.new_context(viewport={'width':1440,'height':1000},accept_downloads=True)
                errors, external, requests = [], [], []
                def guard(route):
                    url=route.request.url
                    requests.append({'method':route.request.method,'url':url})
                    if not url.startswith(origin+'/'):
                        external.append(url);route.abort()
                    else:route.continue_()
                context.route('**/*',guard)
                page = context.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
                page.goto(origin)
                app=page.frame_locator('iframe')
                cost=app.get_by_test_id('budget-cost')
                reliability=app.get_by_test_id('reliability-value')
                expect(cost).to_contain_text('1,953,000',timeout=20000)
                expect(reliability).to_contain_text('87.19')
                app.get_by_role('button',name='Add both reliability upgrades',exact=True).click()
                expect(cost).to_contain_text('2,137,000')
                expect(reliability).to_contain_text('91.12')
                expect(app.get_by_test_id('decision-headline')).not_to_have_text('Feasible')
                app.get_by_role('button',name='Apply 15% budget cut',exact=True).click()
                expect(app.get_by_label('Equipment budget (USD)',exact=True)).to_have_value('1700000')
                expect(app.locator('body')).to_contain_text('437,000')
                with page.expect_download() as pending:
                    app.get_by_role('button',name='Export decision brief',exact=True).click()
                brief=Path(pending.value.path()).read_text()
                assert '2,137,000' in brief and '437,000' in brief,brief
                assert '4.7' in brief and 'unknown' in brief.lower(),brief
                assert origin+manifest['entry'].rsplit('/',1)[0]+'/data/DOC-03.txt' in brief
                with page.expect_download() as pending:
                    app.get_by_role('button',name='Export scenario JSON',exact=True).click()
                exported=json.loads(Path(pending.value.path()).read_text())
                assert exported['result']['costUsd']==2137000
                assert exported['result']['budgetMarginUsd']==-437000
                assert exported['result']['scenario']['budgetUsd']==1700000
                assert exported['scenarioIdentity']==exported['result']['scenarioId']
                assert exported['result']['status']=='blocked'
                (EVIDENCE/'exported-scenario.json').write_text(json.dumps(exported,indent=2)+'\n')
                # Source discrepancy handling and arbitrary numeric inputs must drive
                # actual recomputation, rather than only switch among fixed cards.
                app.get_by_label('Reconcile suspected duplicate',exact=True).uncheck()
                expect(cost).to_contain_text('2,189,000')
                app.get_by_label('Equipment budget (USD)',exact=True).fill('2189123')
                app.get_by_label('Equipment budget (USD)',exact=True).press('Tab')
                expect(app.locator('body')).to_contain_text('123')
                # Invalid edits clear old conclusions and prohibit stale exports.
                app.get_by_label('Equipment budget (USD)',exact=True).fill('')
                expect(app.get_by_role('button',name='Export scenario JSON',exact=True)).to_be_disabled()
                expect(cost).to_have_count(0)
                expect(app.get_by_test_id('decision-headline')).to_contain_text('Complete the scenario')
                app.get_by_role('button',name='Reset scenario',exact=True).click()
                expect(cost).to_contain_text('1,953,000')
                expect(reliability).to_contain_text('87.19')
                app.locator('[data-strategy="parallel-sprint"] button').click()
                expect(app.get_by_label('Crew arrival month',exact=True)).to_have_value('11')
                expect(app.get_by_label('Upgrade fuel cell',exact=True)).to_be_checked()
                expect(cost).to_contain_text('2,073,000')
                expect(reliability).to_contain_text('89.44')
                app.get_by_role('button',name='Reset scenario',exact=True).click()
                # The same crew date has different relay feasibility at m12/m14.
                app.get_by_label('Crew arrival month',exact=True).fill('14')
                app.get_by_label('Relay available month',exact=True).fill('12')
                expect(app.locator('[data-check="relay"]')).to_have_class('check pass')
                before=app.get_by_test_id('scenario-result').inner_text()
                app.get_by_label('Relay available month',exact=True).fill('14')
                expect(app.locator('[data-check="relay"]')).to_have_class('check fail')
                after=app.get_by_test_id('scenario-result').inner_text()
                assert before!=after,'Relay control must change the actual scenario result'
                # Phase deferral must not incorrectly finance mandatory equipment.
                app.get_by_label('Include laboratory in current phase',exact=True).uncheck()
                expect(cost).to_contain_text('1,953,000')
                expect(app.locator('#metrics')).to_contain_text('219,000')
                app.get_by_role('button',name='Add both reliability upgrades',exact=True).click()
                app.get_by_role('button',name='Apply 15% budget cut',exact=True).click()
                app.locator('[data-check="power-precedence"] summary').click()
                source=app.locator('[data-check="power-precedence"] a').filter(has_text='DOC-03')
                source.focus();source.press('Enter')
                expect(app.get_by_role('dialog')).to_be_visible()
                expect(app.locator('#evidence-text')).to_contain_text('THIS SUPERSEDES the 4.0 kW')
                with page.expect_download() as pending:
                    app.locator('#evidence-download').click()
                source_bytes=Path(pending.value.path()).read_bytes()
                assert hashlib.sha256(source_bytes).hexdigest()=='0b99ca94d172e09712e9ddf433d532489a029473511ed87bccc37cab4ebaff2d'
                app.locator('#evidence-close').press('Escape')
                expect(app.get_by_role('dialog')).not_to_be_visible()
                expect(cost).to_contain_text('2,137,000')
                expect(app.get_by_label('Equipment budget (USD)',exact=True)).to_have_value('1700000')
                assert len(context.pages)==1,'Evidence must not need sandbox-disallowed popups'
                page.frames[1].evaluate('window.scrollTo(0,0)')
                page.screenshot(path=str(EVIDENCE/'desktop.png'),full_page=True)
                page.set_viewport_size({'width':390,'height':844})
                frame=page.frames[1]
                assert frame.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Narrow viewport overflows'
                page.screenshot(path=str(EVIDENCE/'mobile.png'),full_page=True)
                app.get_by_test_id('decision-headline').scroll_into_view_if_needed()
                page.screenshot(path=str(EVIDENCE/'mobile-result.png'),full_page=True)
                assert not errors,errors
                assert not external,external
                assert all(r['method']=='GET' for r in requests),requests
                result={'ok':True,'real_app_handler':True,'opaque_sandbox':True,'file_picker_used':False,
                    'checks':['base arithmetic','upgrade cost/reliability coupling','budget shock','brief export',
                              'scenario export','duplicate sensitivity','arbitrary budget','invalid input fences',
                              'preset selection','lab deferral retains cost','reset','relay sensitivity',
                              'keyboard evidence viewer','source download integrity','390px layout'],
                    'page_errors':errors,'external_requests':external,'manifest':manifest}
                (EVIDENCE/'result.json').write_text(json.dumps(result,indent=2)+'\n')
                print(json.dumps(result));browser.close()
        finally:
            server.terminate()
            try:server.wait(timeout=10)
            except subprocess.TimeoutExpired:server.kill();server.wait()
