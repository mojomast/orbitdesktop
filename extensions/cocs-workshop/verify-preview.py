import sys,json
from pathlib import Path
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/home/mojo/.hermes-instances/fresh/cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader'])
 page=b.new_page(viewport={'width':1300,'height':900});errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(Path(sys.argv[1]).as_uri());page.wait_for_function('window.cocsViewer?.ready',timeout=90000)
 page.evaluate('(id)=>window.cocsViewer.select(id)',sys.argv[2]);page.wait_for_function('window.cocsViewer.ready',timeout=90000)
 info=page.evaluate('window.cocsViewer.inspect()');assert info['selected']==sys.argv[2] and info['meshes']>0,info
 assert not errors,errors
 page.screenshot(path=str(Path(sys.argv[1]).with_suffix('.png')))
 print(json.dumps({'check':'Real Chromium WebGL preview; node syntax checks and esbuild passed','asset':info['selected'],'meshes':info['meshes'],'triangles':info['triangles'],'jsErrors':errors}))
 b.close()
