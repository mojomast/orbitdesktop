"""Nous integration tests in disposable authenticated workspace; never owner's state."""
import os,secrets,subprocess,tempfile,time,urllib.request,socket
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
R=Path(__file__).resolve().parents[1]
with socket.socket() as s:
 s.bind(('127.0.0.1',0));port=s.getsockname()[1]
url=f'http://127.0.0.1:{port}'
with tempfile.TemporaryDirectory(prefix='orbit-nous-') as runtime:
 token=secrets.token_urlsafe(36)
 server=subprocess.Popen(['node','--experimental-strip-types','server/index.mjs'],cwd=R,env={**os.environ,'PORT':str(port),'ORBIT_TOKEN':token,'ORBIT_RUNTIME_DIR':runtime},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 try:
  for _ in range(80):
   try: urllib.request.urlopen(url,timeout=1);break
   except OSError: time.sleep(.1)
  else: raise RuntimeError('Readiness failed')
  with sync_playwright() as p:
   browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
   page=browser.new_page(viewport={'width':1440,'height':1000});errors=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(url,wait_until='networkidle');page.keyboard.press('Escape')
   def unlock():
    page.get_by_role('button',name='Connect local host',exact=True).click()
    page.get_by_role('textbox',name='Host session token').fill(token)
    page.get_by_role('button',name='Unlock local host',exact=True).click();page.wait_for_timeout(700)
   unlock()
   before=page.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1")).monitors')
   for name,style in [('Nous Atelier','nous'),('Windows XP','xp'),('Nous Atelier','nous')]:
    page.get_by_role('button',name='Choose workspace theme',exact=True).click()
    page.get_by_role('button',name='Apply '+name+' theme',exact=True).click()
    expect(page.locator('html')).to_have_attribute('data-orbit-style',style)
    expect(page.get_by_role('status').filter(has_text=name+' applied locally')).to_be_visible()
    page.get_by_role('button',name='Close workspace themes').click();page.wait_for_timeout(1000)
    assert page.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1")).monitors')==before
   for path in ['/wallpapers/nous.svg','/art/nous/nous-girl.svg','/art/nous/hermes-wing.svg','/fonts/BarlowCondensed-Light.ttf']+[f'/icons/nous/{r}.svg' for r in ['folder','chat','terminal','browser','document','grid','image','key','app']]:
    assert page.request.get(url+path).ok,path
   assert '/wallpapers/nous.svg' in page.locator('.workspace').evaluate('e=>getComputedStyle(e).backgroundImage')
   assert page.evaluate('document.fonts.check("300 20px \'Atelier Display\'")')
   assert '/art/nous/nous-girl.svg' in page.locator('.start-logo').evaluate('e=>getComputedStyle(e,"::before").backgroundImage')
   tab=page.locator('.display-tabs button').first
   assert 'counter(folio' in tab.evaluate('e=>getComputedStyle(e,"::before").content')
   tab.hover();page.wait_for_timeout(250)
   print('PASS indexed taskbar:',tab.evaluate('e=>({background:getComputedStyle(e).backgroundColor,shadow:getComputedStyle(e).boxShadow})'))
   page.get_by_role('button',name='Show desktop shortcuts',exact=True).click()
   icon=page.locator('.desktop-shortcut').first
   icon.hover();page.wait_for_timeout(600)
   assert icon.locator('.theme-icon').evaluate('e=>getComputedStyle(e,"::after").transform')!='none'
   page.emulate_media(reduced_motion='reduce')
   assert icon.locator('.theme-icon').evaluate('e=>getComputedStyle(e,"::after").transform')=='none'
   page.emulate_media(reduced_motion='no-preference')
   page.screenshot(path=str(R/'.runtime/nous-theme-wallpaper.png'))
   for b in page.locator('.display-tabs button').all(): b.click()
   chat=page.locator('.chat-messages').first
   # Clearly labeled presentation fixtures, never sent to an agent or persisted.
   chat.evaluate('''e=>{e.innerHTML='<div class="chat-message"><small>Hermes · visual test fixture</small><p>Open intelligence, carefully observed.</p><p>This sample checks field-journal typography, marginal rules, and readable links <a href="#">without sending a message</a>.</p><pre>const research = "open";</pre></div><div class="chat-message user"><small>You · visual test fixture</small><p>A workspace for the curious.</p></div>'}''')
   msg=chat.locator('.chat-message').first
   expect(msg).to_have_css('font-family','Georgia, serif')
   for width in [320,480,800]:
    body=page.locator('.chat-body').first
    body.evaluate('(e,w)=>{e.style.width=w+"px";e.style.maxWidth=w+"px"}',width)
    assert body.evaluate('e=>e.scrollWidth<=e.clientWidth+1'),width
   body.evaluate('e=>{e.style.width="";e.style.maxWidth=""}')
   page.screenshot(path=str(R/'.runtime/nous-theme-desktop.png'))
   page.set_viewport_size({'width':390,'height':844})
   page.get_by_role('button',name='Choose workspace theme',exact=True).click()
   assert page.locator('.theme-picker').evaluate('e=>e.scrollWidth<=e.clientWidth+1')
   page.screenshot(path=str(R/'.runtime/nous-theme-narrow.png'))
   page.get_by_role('button',name='Close workspace themes').click()
   page.reload(wait_until='networkidle');expect(page.locator('html')).to_have_attribute('data-orbit-style','nous')
   assert not errors,errors
   browser.close()
   print('PASS Nous picker, switch away/back, persistence, pane preservation, 13 assets, local display font, seal, taskbar counters, ring hover, reduced motion, journal chat, 320/480/800px chat, 390px picker, no JS exceptions')
 finally: server.terminate();server.wait(timeout=10)
