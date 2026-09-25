import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/home/mojo/.hermes-instances/fresh/cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',headless=True,args=['--no-sandbox'])
 page=b.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.goto(Path(sys.argv[1]).resolve().as_uri());page.wait_for_function('window.probeResult',timeout=45000)
 assert not errors,errors
 print(json.dumps(page.evaluate('({smoke:probeResult,plan:latticeSDK.director("D1",1,20),state:latticeSDK.create().nodes.map(n=>({id:n.id,x:n.x,z:n.z})),match:(()=>{const m=latticeSDK.match();m.step(1/60);return {time:m.time,kind:m.objectiveState.kind};})()})')))
 b.close()
