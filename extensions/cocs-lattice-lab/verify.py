"""Run actual imported Lattice smoke checks in a network-denied browser."""
import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/home/mojo/.hermes-instances/fresh/cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',headless=True,args=['--no-sandbox'])
 page=b.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.route('http**/*',lambda r:r.abort())
 page.goto(Path(sys.argv[1]).resolve().as_uri());page.wait_for_function('window.probeResult',timeout=60000)
 result=page.evaluate('window.probeResult');assert result.get('ok') and not errors,(result,errors)
 for mode in ['cocs','cocs-coop']:
  value=page.evaluate('(mode)=>{const m=latticeSDK.match(mode);for(let i=0;i<60;i++)m.step(1/60);return {time:m.time,kind:m.objectiveState.kind,actors:m.actors.length};}',mode)
  assert value['time']>0 and value['kind']=='cocs',value
 result['engine']='Actual PvP and Operations Match: 60 ticks each, seed 12345; not an exhaustive gameplay test'
 print(json.dumps(result));b.close()
