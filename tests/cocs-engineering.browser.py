import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
O='https://kimi.tailec998.ts.net:4325'
entry=sys.argv[1]
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/home/mojo/.hermes-instances/fresh/cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader'])
 page=b.new_page(viewport={'width':1500,'height':1100});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(O,wait_until='domcontentloaded');page.set_content(f'<iframe style="width:1450px;height:1050px" sandbox="allow-scripts allow-forms allow-modals allow-downloads" src="{O+entry}"></iframe>')
 s=page.frame_locator('iframe');s.locator('[data-tool=engineering]').click();f=s.frame_locator('iframe[data-tool=engineering]')
 expect(f.locator('#sourceBadge')).to_contain_text('18c6c415',timeout=90000)
 f.locator('#targetBranch').fill('main');expect(f.locator('#mismatch')).to_contain_text('MISMATCH')
 f.locator('[data-tab=world]').click();f.locator('#route').click();r=json.loads(f.locator('#routeResult').inner_text());assert 'reachable' in r;print('Route',r['reachable'],len(r['segments']))
 f.locator('[data-tab=vehicles]').click()
 for kind in ['titan','scout','transport']:
  f.locator('#vehicle').select_option(kind);f.locator('#loadVehicle').click();r=json.loads(f.locator('#vehicleResult').inner_text());assert r['meshes']>0;assert r['renderCounters']['calls']>0;print('Vehicle',kind,r['meshes'],r['refs'])
 f.locator('#turret').fill('60');f.locator('#wheels').fill('90')
 f.locator('[data-tab=match]').click();f.locator('#stepMatch').click();r=json.loads(f.locator('#matchResult').inner_text());assert r['time']>0;assert len(r['actors'])>1
 f.locator('[data-tab=bots]').click();assert f.locator('#bot option').count()>0;f.locator('#stepBots').click();assert 'bot' in json.loads(f.locator('#botResult').inner_text())
 f.locator('[data-tab=performance]').click();f.locator('#benchmark').click();r=json.loads(f.locator('#performanceResult').inner_text());assert r['measurement']['steps']==120;f.locator('#saveBaseline').click();f.locator('#benchmark').click();assert json.loads(f.locator('#performanceResult').inner_text())['baseline']
 f.locator('[data-tab=regressions]').click();f.locator('#runSuite').click();r=json.loads(f.locator('#suiteResult').inner_text());assert len(r['results'])==5;assert r['results'][0]['status']=='pass';assert all(x['status']=='pass' for x in r['results'][2:]);print('Scenarios',[(x['name'],x['status']) for x in r['results']])
 with page.expect_download() as d:f.locator('#exportEvidence').click()
 assert json.loads(Path(d.value.path()).read_text())==r
 f.locator('[data-tab=release]').click();f.locator('#releaseTitle').fill('Diagnostic review');f.locator('#releaseBrief').click();r=json.loads(f.locator('#releaseResult').inner_text());assert 'Target branch mismatch' in r['blockers'];assert 'NOT APPROVED' in r['status']
 f.locator('#releaseTitle').fill('changed');assert f.locator('#releaseExport').is_disabled()
 s.locator('[data-tool=compare]').click();s.locator('nav [data-tool=engineering]').click();expect(f.locator('#releaseTitle')).to_have_value('changed')
 f.locator('[data-tab=world]').click();f.locator('#auditGraph').click();g=json.loads(f.locator('#graphResult').inner_text());assert g['nodes']>0;assert len(g['components'])>0;print('Graph audit',g['nodes'],g['directedLinks'],len(g['components']))
 f.locator('[data-tab=regressions]').click();f.locator('#runSuite').click();ev=json.loads(f.locator('#suiteResult').inner_text())
 f.locator('#baselineFile').set_input_files({'name':'baseline.json','mimeType':'application/json','buffer':json.dumps(ev).encode()});expect(f.locator('#comparisonResult')).to_contain_text('Baseline loaded');f.locator('#compareEvidence').click();comparison=json.loads(f.locator('#comparisonResult').inner_text());assert comparison['sameCommit'];assert not any(x['regression'] for x in comparison['changes'])
 f.locator('#baselineFile').set_input_files({'name':'bad.json','mimeType':'application/json','buffer':b'{}'});expect(f.locator('#comparisonResult')).to_contain_text('Import rejected');f.locator('#compareEvidence').click();expect(f.locator('#comparisonResult')).to_contain_text('Import a baseline')
 f.locator('[data-tab=world]').click();f.locator('#fromNode').select_option('1');f.locator('[data-tab=regressions]').click();assert f.locator('#exportEvidence').is_disabled()
 print('PASS graph audit, real evidence roundtrip/comparison, invalid import rejection, stale route evidence invalidation')
 page.screenshot(path='.runtime/cocs-engineering.png')
 assert not errors,errors
 print('PASS published sandbox: provenance mismatch, real routes, 3 rendered models, match/bot stepping, timing comparison, deterministic regression, evidence download, release invalidation and retained tabs; no JS errors')
 b.close()
