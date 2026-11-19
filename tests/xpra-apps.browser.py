from pathlib import Path
from playwright.sync_api import sync_playwright, expect
R=Path(__file__).resolve().parents[1]
APPS=['chromium','writer','calc','impress','files','editor','terminal']
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox'])
 failures=[]
 for i,app in enumerate(APPS):
  g=b.new_page(viewport={'width':1100,'height':800})
  errors=[];g.on('pageerror',lambda e:errors.append(str(e)))
  try:
   g.goto(f'https://kimi.tailec998.ts.net:{4350+i}/?floating_menu=false&sharing=true&orbit_app=1')
   g.locator('#password').fill((R/'.runtime/xpra/password').read_text().strip())
   g.get_by_text('Connect',exact=True).click()
   expect(g.locator('canvas').first).to_be_visible(timeout=30000)
   g.wait_for_timeout(2000)
   if app=='impress' and g.evaluate("Object.values(client.id_to_window).some(w=>w.title==='Presentation Wizard')"):
    g.locator('canvas').first.click(position={'x':100,'y':100})
    g.keyboard.press('Alt+c')
    g.wait_for_timeout(2000)
   info=g.evaluate("Object.values(client.id_to_window).map(w=>({title:w.title,w:w.w,h:w.h,fit:!!w.orbitFitted}))")
   print(app,info,'errors',errors,flush=True)
   assert not errors
   assert any(w['fit'] for w in info), 'Primary application not fitted'
   g.set_viewport_size({'width':900,'height':650})
   for _ in range(40):
    if g.evaluate("Object.values(client.id_to_window).some(w=>w.orbitFitted && w.w===900 && w.h===650)"): break
    g.wait_for_timeout(250)
   else: raise AssertionError('Resize not delivered')
   g.screenshot(path=str(R/f'.runtime/xpra/{app}-app.png'))
  except Exception as e:
   failures.append(app);print('FAIL',app,str(e)[:700],flush=True)
  finally:g.close()
 b.close()
 assert not failures,failures
 print('PASS: all seven native app canvases; no JS errors; primary app resize follows viewport')
