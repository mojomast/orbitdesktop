"""Exercise actual picker, persistence and CSS interactions in isolated server/storage."""
import os,secrets,subprocess,tempfile,time,urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
R=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='orbit-personalities-') as runtime:
 token=secrets.token_urlsafe(36)
 server=subprocess.Popen(['node','--experimental-strip-types','server/index.mjs'],cwd=R,env={**os.environ,'PORT':'4398','ORBIT_TOKEN':token,'ORBIT_RUNTIME_DIR':runtime},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 try:
  for _ in range(60):
   try: urllib.request.urlopen('http://127.0.0.1:4398/',timeout=1);break
   except OSError: time.sleep(.1)
  else: raise RuntimeError('Readiness failed')
  with sync_playwright() as p:
   browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
   page=browser.new_page(viewport={'width':1440,'height':1000});errors=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto('http://127.0.0.1:4398/',wait_until='networkidle');page.keyboard.press('Escape')
   page.get_by_role('button',name='Connect local host',exact=True).click()
   page.get_by_role('textbox',name='Host session token').fill(token)
   page.get_by_role('button',name='Unlock local host',exact=True).click();page.wait_for_timeout(1000)
   before=page.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1")).monitors')
   for name,style in [('Windows XP','xp'),('Classic 95','classic'),('Paper Studio','paper'),('Cyberpunk','cyberpunk'),('Aurora Glass','aurora'),('Phosphor','phosphor'),('Blueprint','blueprint'),('Pop Art','pop'),('Ocean','ocean'),('Forest','forest'),('Plum','plum'),('Ember','ember'),('Midnight','midnight')]:
    page.get_by_role('button',name='Choose workspace theme',exact=True).click()
    page.get_by_role('button',name='Apply '+name+' theme',exact=True).click()
    expect(page.locator('html')).to_have_attribute('data-orbit-style',style)
    expect(page.get_by_role('status').filter(has_text=name+' applied locally')).to_be_visible()
    page.get_by_role('button',name='Close workspace themes').click();page.wait_for_timeout(1200)
    assert f'/wallpapers/{style}.svg' in page.locator('.workspace').evaluate('e=>getComputedStyle(e).backgroundImage')
    assert page.request.get(f'http://127.0.0.1:4398/wallpapers/{style}.svg').ok
    start=page.locator('.start-button');start.click();expect(page.locator('.start-panel')).to_be_visible();page.keyboard.press('Escape');expect(start).to_be_focused()
    tab=page.locator('.display-tabs button').first
    tab.hover();page.wait_for_timeout(350)
    if style=='ocean':
     print('OCEAN diagnostic',tab.evaluate('e=>({hover:e.matches(":hover"),focus:e.matches(":focus-visible"),style:document.documentElement.dataset.orbitStyle,bg:getComputedStyle(e).background,rect:e.getBoundingClientRect().toJSON()})'))
     tab.focus();expect(tab).to_have_css('background-position','0px 100%')
    if style=='forest': expect(tab).to_have_css('border-top-left-radius','22px')
    if style=='phosphor': assert '[1]' in tab.evaluate('e=>getComputedStyle(e,"::before").content') or 'counter(buffer)' in tab.evaluate('e=>getComputedStyle(e,"::before").content')
    page.mouse.move(1400,5)
    assert page.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1")).monitors')==before
    if style=='aurora':
     assert 'blur' in page.locator('.scene-navigation').evaluate('e=>getComputedStyle(e).backdropFilter')
     b=page.locator('.start-button');b.hover();page.wait_for_timeout(250)
     expect(b).to_have_css('translate','0px -3px')
     page.emulate_media(reduced_motion='reduce');expect(b).to_have_css('translate','none');page.emulate_media(reduced_motion='no-preference')
    if style=='phosphor':
     assert '/wallpapers/phosphor.svg' in page.locator('.workspace').evaluate('e=>getComputedStyle(e).backgroundImage')
     page.locator('.start-button').hover();expect(page.locator('.start-button')).to_have_css('color','rgb(6, 19, 12)')
    if style=='blueprint': expect(page.locator('.monitor').first).to_have_css('border-top-style','double')
    if style=='pop':
     b=page.locator('.start-button');b.hover();page.mouse.down();page.wait_for_timeout(180);expect(b).to_have_css('translate','3px 3px');page.mouse.move(1400,5);page.mouse.up()
    page.mouse.move(1400,5)
    for width in [320,480,800]:
     chat=page.locator('.chat-body').first;chat.evaluate('(e,w)=>{e.style.width=w+"px";e.style.maxWidth=w+"px"}',width)
     assert chat.evaluate('e=>e.scrollWidth<=e.clientWidth+1'),(style,width)
    chat.evaluate('e=>{e.style.width="";e.style.maxWidth=""}')
    page.screenshot(path=str(R/'.runtime'/('personality-'+style+'.png')))
    page.reload(wait_until='networkidle');expect(page.locator('html')).to_have_attribute('data-orbit-style',style)
    page.get_by_role('button',name='Connect local host',exact=True).click()
    page.get_by_role('textbox',name='Host session token').fill(token)
    page.get_by_role('button',name='Unlock local host',exact=True).click();page.wait_for_timeout(1000)
    page.set_viewport_size({'width':390,'height':844})
    page.get_by_role('button',name='Choose workspace theme',exact=True).click()
    assert page.locator('.theme-picker').evaluate('e=>e.scrollWidth<=e.clientWidth+1')
    page.get_by_role('button',name='Close workspace themes').click();page.set_viewport_size({'width':1440,'height':1000})
    print('PASS',name,'picker, persistence, pane preservation, responsive chat and dialog')
   assert not errors,errors
   browser.close();print('PASS dock hover, reduced motion, phosphor hover, blueprint borders, pop press depth, no JS exceptions')
 finally: server.terminate();server.wait(timeout=10)
