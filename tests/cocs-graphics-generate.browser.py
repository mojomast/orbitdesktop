"""Real local-only Hermes smoke run. Never publishes; confirms then cancels PR UI."""
from pathlib import Path
import time,json
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[1];URL='https://kimi.tailec998.ts.net:10447'
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/home/mojo/.hermes-instances/fresh/cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader'])
 page=b.new_page(viewport={'width':1600,'height':1000});page.goto(URL);page.wait_for_function('window.graphicsLab?.ready',timeout=90000)
 page.locator('#preset').select_option('Shield frost')
 opts=page.locator('#trigger option').evaluate_all('(els)=>els.map(e=>({v:e.value,t:e.textContent}))')
 selected=next((x for x in opts if 'shield' in x['v'].lower()),opts[0]);page.locator('#trigger').select_option(selected['v'])
 page.locator('#prompt').fill('LOCAL-ONLY integration smoke test. Implement this look for the selected powerup lifecycle with the smallest safe changes to existing game modules. Do not publish, push or commit. Explain any unverified game behavior. This test is not permission to bypass tool approval or modify other checkouts.')
 page.locator('#generate').click();deadline=time.time()+720
 while time.time()<deadline:
  text=page.locator('#status').inner_text();print(text[:600],flush=True)
  if text.startswith(('ready','blocked','Hermes busy')):break
  page.wait_for_timeout(4000)
 (R/'.runtime/cocs-graphics-lab/generation-result.txt').write_text(text)
 if not text.startswith('ready'):
  print('REAL_GENERATION_BLOCKER',text,flush=True);b.close();raise SystemExit(2)
 page.locator('#preview').click();frame=page.frame_locator('#sourcePreview');frame.locator('#status').filter(has_text='Characters /').wait_for(timeout=90000)
 page.locator('#closePreview').click();page.locator('#approved').check();page.locator('#title').fill('Local graphics integration test — DO NOT PUBLISH')
 page.locator('#pr').click();page.locator('#confirm').wait_for(state='visible');page.locator('#dismiss').click()
 page.screenshot(path=str(R/'.runtime/cocs-graphics-lab/draft-review.png'))
 print('PASS real Hermes edit, validated source preview, digest-gated PR confirmation CANCELLED. In-game trigger behavior not verified; no GitHub write.',flush=True)
 b.close()
