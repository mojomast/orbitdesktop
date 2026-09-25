from playwright.sync_api import sync_playwright, expect
from PIL import Image
import io,json
MID='480f30c9-9d43-4be3-950e-63832e4f50de'
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox'])
 page=b.new_page(viewport={'width':1400,'height':1100})
 page.goto('https://kimi.tailec998.ts.net:4325/',wait_until='networkidle')
 state=page.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1"))')
 m=state['monitors'][0];m['id']=MID;m['frame']={'x':60,'y':80,'width':650,'height':800,'z':2};m['layout']={'type':'pane','pane':{'id':'85090444-a890-4b0c-aa3e-887966f64404','kind':'browser','url':'https://kimi.tailec998.ts.net:4365/'}}
 state['monitors']=[m];state['selected']=MID;state['view']='windows';state['plugins']=[]
 page.add_init_script('if(!sessionStorage.pulseSeed){localStorage.setItem("orbit.workspace.v1", '+json.dumps(json.dumps(state))+');sessionStorage.pulseSeed="1";}')
 page.reload(wait_until='networkidle')
 w=page.locator('[data-monitor-id="'+MID+'"]');expect(w).to_be_visible()
 f=page.frame_locator('[data-monitor-id="'+MID+'"] iframe')
 f.locator('#settings-toggle').click();f.locator('#theme').select_option('glass');f.locator('#settings-toggle').click()
 f.locator('#border-toggle').click();expect(f.locator('#border-toggle')).to_have_text('Show border')
 assert f.locator('#panel').evaluate('(e)=>getComputedStyle(e).borderTopColor')=='rgba(0, 0, 0, 0)'
 for sel in ['', ' .monitor-bar',' .monitor-content',' .pane-body',' .browser-surface',' iframe']:
  el=page.locator('[data-monitor-id="'+MID+'"]'+sel).first
  assert el.evaluate('(e)=>getComputedStyle(e).backgroundColor')=='rgba(0, 0, 0, 0)',sel
 assert w.evaluate('(e)=>getComputedStyle(e).boxShadow')=='none'
 # Actual composed pixel must equal the colored desktop behind the cross-origin iframe.
 page.add_style_tag(content='.workspace{background:rgb(17,43,67)!important}')
 r=w.locator('iframe').bounding_box();x=int(r['x']+5);y=int(r['y']+180)
 image=Image.open(io.BytesIO(page.screenshot())).convert('RGB')
 actual=image.getpixel((x,y))
 w.evaluate('(e)=>e.style.visibility="hidden"')
 beneath=Image.open(io.BytesIO(page.screenshot())).convert('RGB').getpixel((x,y))
 print('Composited / underlying pixel:',actual,beneath)
 assert actual==beneath,(actual,beneath)
 w.locator('iframe').evaluate('(e)=>e.style.visibility=""')
 page.reload(wait_until='networkidle');expect(f.locator('#border-toggle')).to_have_text('Show border');expect(f.locator('body')).to_have_attribute('data-theme','glass')
 f.locator('#border-toggle').click();expect(f.locator('#border-toggle')).to_have_text('Hide border')
 assert f.locator('#panel').evaluate('(e)=>getComputedStyle(e).borderTopColor')!='rgba(0, 0, 0, 0)'
 expect(w.locator('.monitor-bar')).to_be_visible();expect(w.locator('.window-resize')).to_be_visible()
 print('PASS actual iframe pixel transparency, transparent host layers, border toggle both ways, preferences after reload, drag and resize handles retained')
 b.close()
