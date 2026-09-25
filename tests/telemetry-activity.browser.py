from playwright.sync_api import sync_playwright, expect
import json
MID='480f30c9-9d43-4be3-950e-63832e4f50de'
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox'])
 page=b.new_page(viewport={'width':1400,'height':1100})
 page.goto('https://kimi.tailec998.ts.net:4325/',wait_until='networkidle')
 state=page.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1"))')
 m=state['monitors'][0]; m['id']=MID;m['name']='Pulse drag test';m['frame']={'x':60,'y':80,'width':650,'height':800,'z':2};m['layout']={'type':'pane','pane':{'id':'85090444-a890-4b0c-aa3e-887966f64404','kind':'browser','url':'https://kimi.tailec998.ts.net:4365/'}}
 state['monitors']=[m];state['selected']=MID;state['view']='windows';state['plugins']=[]
 page.add_init_script('if(!sessionStorage.pulseSeed){localStorage.setItem("orbit.workspace.v1", '+json.dumps(json.dumps(state))+');sessionStorage.pulseSeed="1";}')
 page.reload(wait_until='networkidle')
 w=page.locator('[data-monitor-id="'+MID+'"]');expect(w).to_be_visible()
 bar=w.locator('.monitor-bar');expect(bar).to_be_visible();before=w.bounding_box();r=bar.bounding_box()
 page.mouse.move(r['x']+180,r['y']+12);page.mouse.down();page.mouse.move(r['x']+290,r['y']+92,steps=8);page.mouse.up()
 after=w.bounding_box();assert after['x']>before['x']+50,(before,after)
 resize=w.locator('.window-resize');expect(resize).to_be_visible();r=resize.bounding_box()
 page.mouse.move(r['x']+r['width']/2,r['y']+r['height']/2);page.mouse.down();page.mouse.move(r['x']+r['width']/2+100,r['y']+r['height']/2+60,steps=8);page.mouse.up()
 end=w.bounding_box();assert end['width']>after['width']+50,(after,end)
 page.wait_for_timeout(800);page.reload(wait_until='networkidle');final=w.bounding_box();assert abs(final['width']-end['width'])<2,(final,end)
 print('PASS native drag, resize and reload persistence',final)
 page.goto('https://kimi.tailec998.ts.net:4365/')
 expect(page.locator('#oc-active')).not_to_have_text('—')
 expect(page.locator('#oc-tps')).not_to_have_text('—')
 expect(page.locator('#active-routes')).to_contain_text('deepseek')
 expect(page.locator('#active-routes')).to_contain_text('https://api.deepseek.com')
 payload=page.evaluate('async()=>await (await fetch("/api/metrics")).json()')
 assert payload['opencode_activity']['in_flight'] is None
 page.route('**/api/metrics',lambda route:route.abort());page.evaluate('refresh()');expect(page.locator('#oc-active')).to_have_text('—');expect(page.locator('#active-routes .model')).to_have_count(0)
 print('PASS real OpenCode activity, token rate, provider/model/endpoint rendering and disconnect withholding')
 b.close()
