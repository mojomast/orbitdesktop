import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[1]
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/home/mojo/.hermes-instances/fresh/cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',headless=True,args=['--no-sandbox'])
 page=b.new_page(viewport={'width':1450,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto((R/'extensions/cocs-lattice-lab/dist/preview.html').as_uri());page.wait_for_function('window.lab');assert page.locator('#graph circle').count()==7
 print('edges',page.locator('#graph line').count());assert page.locator('#graph line').count()==10
 page.click('#captureScenario');income=page.evaluate('latticeSDK.inspect(lab.state).income[0]');assert income==4,income
 page.click('#cutScenario');assert page.evaluate('latticeSDK.inspect(lab.state).income[0]')==0
 page.click('#repair');assert page.evaluate('latticeSDK.inspect(lab.state).income[0]')==4
 page.click('[data-tab=director]');page.select_option('#tier','D4');page.select_option('#wave','5');assert '5' in page.inner_text('#wavePlan');print('Director',page.inner_text('#directorMetrics'))
 page.click('[data-tab=wiring]');page.fill('#search','neglectPassiveFlux');assert page.locator('#module option').count()>0;assert 'neglect' in page.inner_text('#source').lower()
 page.click('[data-tab=engine]');page.click('#step');assert '1.000 seconds' in page.inner_text('#engineStatus')
 page.click('[data-tab=topology]');page.select_option('#mode','cocs-coop');page.click('[data-tab=engine]');page.click('#engineReset');page.click('#step');assert '1.000 seconds' in page.inner_text('#engineStatus')
 with page.expect_download() as d:page.click('#export')
 download=d.value;path=R/'.runtime/lattice-test-export.json';download.save_as(path);assert json.loads(path.read_text())['scenario']['mode']=='cocs-coop'
 page.click('[data-tab=topology]');page.click('#captureScenario');page.screenshot(path=str(R/'.runtime/lattice-lab-test.png'))
 assert not errors,errors
 print('PASS: real source topology, supply cut/repair, D4 wave 5, source search, PvP/co-op stepping, JSON download; zero JS errors');b.close()
