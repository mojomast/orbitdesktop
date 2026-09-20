from pathlib import Path
from playwright.sync_api import sync_playwright, expect
R=Path(__file__).resolve().parents[1]
env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox'])
 c=b.new_context(permissions=['clipboard-read','clipboard-write'],viewport={'width':1600,'height':1100})
 g=c.new_page();g.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='networkidle')
 g.get_by_role('button',name='Connect local host',exact=True).click()
 g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN'])
 g.get_by_role('button',name='Unlock local host',exact=True).click()
 g.get_by_role('button',name='Open Connection passwords',exact=True).evaluate('(e)=>e.click()')
 for service,path in [('Chromium','.runtime/shared-browser/password.txt'),('Xpra','.runtime/xpra/password')]:
  secret=(R/path).read_text().strip()
  g.get_by_role('button',name=f'Copy {service} password',exact=True).click()
  g.wait_for_function("navigator.clipboard.readText().then(s=>s.length>0)")
  expect(g.get_by_role('button',name=f'Copy {service} password',exact=True)).to_have_text('Copied')
  assert g.evaluate('navigator.clipboard.readText()')==secret, 'Clipboard mismatch'
  assert secret not in g.locator('body').inner_text(), 'Secret rendered'
  assert secret not in g.content(), 'Secret in DOM'
  g.evaluate("navigator.clipboard.writeText('')")
 for token,service,status in [('', 'xpra',401),(env['ORBIT_TOKEN'],'invalid',400)]:
  actual=g.evaluate('''async args=>{const r=await fetch('/api/agent',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+args.token},body:JSON.stringify({action:'connection_password',service:args.service,session_id:'orbit-'+crypto.randomUUID()})});return r.status}''',{'token':token,'service':service})
  assert actual==status, f'Rejection status {actual}'
 b.close()
 print('PASS: real Chromium and Xpra clipboard values match; neither appears in DOM; unauthenticated and invalid service requests rejected.')
