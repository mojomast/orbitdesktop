from playwright.sync_api import sync_playwright
from PIL import Image, ImageChops
import io
url='https://kimi.tailec998.ts.net:4325/the-last-light-animated-v1.svg'
with sync_playwright() as p:
 b=p.chromium.launch(headless=True)
 page=b.new_page(viewport={'width':1920,'height':1080},device_scale_factor=1)
 response=page.goto(url)
 assert response.status==200
 assert page.locator('.wave').count()==8
 assert page.locator('.meteor').count()==4
 a=page.locator('.scarf').evaluate('(e)=>getComputedStyle(e).d')
 page.wait_for_timeout(1100)
 assert a!=page.locator('.scarf').evaluate('(e)=>getComputedStyle(e).d')
 # Verify actual CSS background-image rendering, not just inline SVG animations.
 page.goto('https://kimi.tailec998.ts.net:4325/',wait_until='domcontentloaded')
 page.set_content('<style>body{margin:0;background:#020611 url('+url+') center/cover no-repeat;width:100vw;height:100vh}</style>')
 page.wait_for_timeout(800)
 first=Image.open(io.BytesIO(page.screenshot())).convert('RGB')
 page.wait_for_timeout(1400)
 second=Image.open(io.BytesIO(page.screenshot())).convert('RGB')
 for name,box in [('halo',(770,100,1360,710)),('water',(200,760,1700,930)),('scarf',(1063,873,1130,903))]:
  assert ImageChops.difference(first.crop(box),second.crop(box)).getbbox(),name
  print('PASS animated background pixels:',name)
 page.screenshot(path='/tmp/last-light-animated-preview.png')
 page.emulate_media(reduced_motion='reduce')
 page.goto(url+'?reduced-motion-test=1')
 assert page.locator('.scarf').evaluate('(e)=>getComputedStyle(e).animationName')=='none'
 page.wait_for_timeout(300)
 first=page.screenshot()
 page.wait_for_timeout(1200)
 assert first==page.screenshot(),'reduced motion must stop animations'
 print('PASS reduced-motion freezes wallpaper; HTTP 200; scarf morph and meteor/water layers verified')
 b.close()
