import os
from playwright.sync_api import sync_playwright, expect
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
 context=b.new_context(viewport={'width':1440,'height':1000},permissions=['clipboard-read','clipboard-write'])
 g=context.new_page(); errors=[];sent=[]
 g.on('pageerror',lambda e:errors.append(str(e)))
 g.on('request',lambda r:sent.append(r.url) if r.method=='POST' and '/api/agent' in r.url else None)
 g.goto(os.environ.get('ORBIT_TEST_URL','https://kimi.tailec998.ts.net:4325/'),wait_until='networkidle')
 dialog=g.get_by_role('dialog');expect(dialog).to_be_visible()
 original=g.evaluate('localStorage.getItem("orbit.workspace.v1")')
 def click(name):g.get_by_role('button',name=name,exact=True).click()
 expect(g.get_by_role('heading',name='Welcome to Orbit')).to_be_visible()
 assert g.evaluate('document.activeElement.id')=='orbit-tour-title'
 for i in range(4):click('Next tour step')
 expect(g.get_by_role('heading',name='Ask Hermes to make it yours')).to_be_visible()
 click('Copy example prompt');expect(g.get_by_role('status').filter(has_text='Copied.')).to_be_visible()
 assert g.evaluate('navigator.clipboard.readText()')==g.get_by_label('Example prompt',exact=True).input_value()
 click('Previous tour step');expect(g.get_by_role('heading',name='Keep layouts for different tasks')).to_be_visible()
 click('Next tour step');click('Next tour step')
 expect(g.get_by_role('heading',name='Build apps inside your workspace')).to_be_visible()
 # Responsive controls stay reachable; textarea copy fallback works.
 g.evaluate('() => { navigator.clipboard.writeText=()=>Promise.reject(new Error("denied")); }')
 click('Copy example prompt');expect(g.get_by_text('Copy unavailable.',exact=False)).to_be_visible()
 for width,height in [(390,700),(320,568),(1440,1000)]:
  g.set_viewport_size({'width':width,'height':height})
  assert dialog.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
  click('Next tour step');expect(g.get_by_role('heading',name='Explore with a safety net')).to_be_visible()
  click('Previous tour step')
 click('Next tour step');click('Finish tour');expect(dialog).to_have_count(0)
 assert g.evaluate('localStorage.getItem("orbit.onboarding.v1")')=='done'
 assert g.evaluate('localStorage.getItem("orbit.workspace.v1")')==original
 g.reload(wait_until='networkidle');expect(dialog).to_have_count(0)
 click('Open Start');click('Getting started');expect(dialog).to_be_visible()
 g.keyboard.press('Escape');expect(dialog).to_have_count(0)
 click('Open Start');click('Getting started');click('Skip tour')
 g.reload(wait_until='networkidle');expect(dialog).to_have_count(0)
 assert not errors,errors
 assert not sent,sent
 # Clearing the onboarding marker offers it again, even for existing workspaces.
 g.evaluate('localStorage.removeItem("orbit.onboarding.v1")');g.reload(wait_until='networkidle');expect(dialog).to_be_visible()
 g.screenshot(path='.runtime/onboarding-browser-test.png')
 b.close()
 print('PASS: live first-run tour, all seven steps, back/finish/skip/Escape, replay from Start, reload persistence, clipboard and denied fallback, 320/390/1440px widths, unchanged workspace, no agent submissions or JS errors.')
