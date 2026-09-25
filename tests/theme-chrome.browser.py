import os,secrets,subprocess,tempfile,time,urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from orbit_menu import menu, open_menu, close_menu
R=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='orbit-theme-test-') as runtime:
 token=secrets.token_urlsafe(36)
 env={**os.environ,'PORT':'4397','ORBIT_TOKEN':token,'ORBIT_RUNTIME_DIR':runtime}
 server=subprocess.Popen(['node','--experimental-strip-types','server/index.mjs'],cwd=R,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 try:
  for _ in range(60):
   try:
    urllib.request.urlopen('http://127.0.0.1:4397/',timeout=1);break
   except OSError: time.sleep(.1)
  else: raise RuntimeError('Test server failed readiness')
  with sync_playwright() as p:
   browser=p.chromium.launch(headless=True,args=['--no-sandbox']);page=browser.new_page(viewport={'width':1440,'height':1000});errors=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto('http://127.0.0.1:4397/',wait_until='networkidle');page.keyboard.press('Escape')
   page.get_by_role('button',name='Connect local host',exact=True).click()
   page.get_by_role('textbox',name='Host session token').fill(token)
   page.get_by_role('button',name='Unlock local host',exact=True).click();page.wait_for_timeout(1200)
   before=page.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1"))')
   for name,theme in [('Windows XP','xp'),('Classic 95','classic'),('Paper Studio','paper'),('Cyberpunk','cyberpunk')]:
    menu(page,'Choose workspace theme')
    page.get_by_role('button',name='Apply '+name+' theme',exact=True).click()
    expect(page.locator('html')).to_have_attribute('data-orbit-theme',theme)
    expect(page.get_by_role('status').filter(has_text=name+' applied locally')).to_be_visible()
    page.get_by_role('button',name='Close workspace themes').click();page.wait_for_timeout(1200)
    after=page.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1"))');assert before['monitors']==after['monitors']
    if theme=='xp':
     expect(page.locator('.window-close').first).to_have_css('color','rgb(255, 255, 255)')
     assert '220, 89, 59' in page.locator('.window-close').first.evaluate('(e)=>getComputedStyle(e).backgroundImage')
     expect(page.locator('.scene-navigation')).to_have_css('left','0px')
     expect(page.locator('.scene-navigation')).to_have_css('border-radius','0px')
     page.get_by_role('button',name='Open Start',exact=True).click()
     expect(page.locator('.start-panel')).to_be_visible()
     expect(page.locator('.start-heading strong')).to_have_css('color','rgb(255, 255, 255)')
     assert page.locator('.start-results').evaluate('(e)=>getComputedStyle(e,"::-webkit-scrollbar").width')=='17px'
     expect(page.locator('.start-results')).to_have_css('overflow-y','auto')
     assert page.locator('.start-results').evaluate('(e)=>e.scrollHeight>e.clientHeight')
     page.locator('.start-item').last.scroll_into_view_if_needed()
     assert page.locator('.start-item').last.evaluate('(e)=>{const r=e.getBoundingClientRect(),p=e.closest(".start-panel").getBoundingClientRect();return r.bottom<=p.bottom && r.top>=p.top}')
     expect(page.get_by_role('searchbox',name='Search Start')).to_be_in_viewport()
     expect(page.locator('.window-close').first).to_have_css('background-color','rgb(220, 89, 59)')
     page.get_by_role('searchbox',name='Search Start').fill('terminal')
     assert page.locator('.start-item').count()>0
     page.keyboard.press('Escape')
     expect(page.get_by_role('button',name='Open Start',exact=True)).to_be_focused()
     page.set_viewport_size({'width':390,'height':844})
     page.get_by_role('button',name='Open Start',exact=True).click()
     assert page.locator('.start-panel').evaluate('(e)=>e.getBoundingClientRect().right<=innerWidth')
     page.keyboard.press('Escape');page.set_viewport_size({'width':1440,'height':1000})
     chat=page.locator('.chat-body').first
     expect(chat.locator('.agent-meta')).to_have_css('position','static')
     expect(chat.locator('.agent-avatar')).to_have_css('display','grid')
     expect(chat.locator('.chat-messages')).to_have_css('background-color','rgb(255, 255, 255)')
     expect(chat.locator('textarea')).to_have_css('background-color','rgb(255, 255, 255)')
     chat.locator('textarea').fill('Unsent Messenger styling test')
     # Fixture messages only; never submit to an agent.
     chat.locator('.chat-messages').evaluate('e => {e.innerHTML = `<div class="chat-message user"><small>YOU</small><p>Hello Hermes!</p></div><div class="chat-message"><small>HERMES</small><p>Hello! This is the Messenger theme test.</p></div>`}')
     expect(chat.locator('.chat-message.user')).to_have_css('border-left-width','0px')
     assert chat.locator('.chat-message small').first.evaluate('(e)=>getComputedStyle(e,"::after").content')=='" says:"'
     for width in [320,480,800]:
      chat.evaluate('(e,w)=>{e.style.width=w+"px";e.style.maxWidth=w+"px"}',width)
      assert chat.evaluate('e=>e.scrollWidth<=e.clientWidth+1'),width
      expect(chat.locator('textarea')).to_have_value('Unsent Messenger styling test')
     chat.evaluate('e=>{e.style.width="";e.style.maxWidth=""}')
     page.screenshot(path=str(R/'.runtime/msn-chat-test.png'))
     print('PASS XP Messenger header, white transcript/composer, flat messages, sender labels and 320/480/800px overflow; XP controls/taskbar/Start')
    if theme=='classic':
     expect(page.locator('.scene-navigation')).to_have_css('background-color','rgb(192, 192, 192)')
     expect(page.locator('.scene-navigation')).to_have_css('left','0px')
     chat=page.locator('.chat-body').first
     expect(chat.locator('textarea')).to_have_css('background-color','rgb(255, 255, 255)')
     assert 'Orbit Fixedsys' in chat.locator('textarea').evaluate('e=>getComputedStyle(e).fontFamily')
     assert page.evaluate('async()=>{await document.fonts.load("16px \\\"Orbit Fixedsys\\\"");return document.fonts.check("16px \\\"Orbit Fixedsys\\\"")}')
     assert 'orbit-95.svg' in page.locator('.workspace').evaluate('e=>getComputedStyle(e).backgroundImage')
     for width in [320,480,800]:
      chat.evaluate('(e,w)=>{e.style.width=w+"px";e.style.maxWidth=w+"px"}',width)
      assert chat.evaluate('e=>e.scrollWidth<=e.clientWidth+1'),width
     chat.evaluate('e=>{e.style.width="";e.style.maxWidth=""}')
     print('PASS Classic 95 gray taskbar, white Notepad composer, loaded Fixedsys font, unique wallpaper, 320/480/800px overflow')
    page.screenshot(path=str(R/'.runtime'/('theme-'+theme+'.png')))
    print('PASS rendered, checkpointed, synchronized:',name)
   menu(page,'Choose workspace theme');page.get_by_text('Customize individual UI elements',exact=True).click()
   page.get_by_role('spinbutton',name='titlebar Height (px)',exact=True).fill('48')
   page.get_by_role('button',name='Save custom styling',exact=True).click();page.wait_for_timeout(1500)
   expect(page.locator('.monitor-bar').first).to_have_css('min-height','48px')
   page.get_by_role('button',name='Close workspace themes').click();page.reload(wait_until='networkidle')
   expect(page.locator('html')).to_have_attribute('data-orbit-theme','cyberpunk')
   expect(page.locator('.monitor-bar').first).to_have_css('min-height','48px')
   page.set_viewport_size({'width':390,'height':844});menu(page,'Choose workspace theme')
   assert page.locator('dialog').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
   assert not errors,errors
   browser.close();print('PASS custom override, reload persistence, mobile overflow and no JS errors')
 finally:
  server.terminate();server.wait(timeout=10)
