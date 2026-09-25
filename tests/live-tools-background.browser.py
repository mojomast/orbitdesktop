from pathlib import Path
from io import BytesIO
import re
from PIL import Image
from playwright.sync_api import sync_playwright, expect
root=Path(__file__).resolve().parents[1]
env=dict(x.split('=',1) for x in (root/'.env.deploy').read_text().splitlines() if '=' in x)
origin=env['ORBIT_PUBLIC_ORIGIN'].rstrip('/')
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,args=['--no-sandbox'])
    page=b.new_page(viewport={'width':800,'height':600})
    page.route(origin+'/__background_test__',lambda r:r.fulfill(content_type='text/html',body='<!doctype html><html></html>'))
    page.goto(origin+'/__background_test__')
    index=page.request.get(origin).text()
    css=page.request.get(origin+re.search(r'href="([^"]+\.css)"',index).group(1)).text()
    assert 'a5418259-f332-4d2f-be76-313a87b66023' in css
    page.set_content('''<style>html{color-scheme:dark}body{margin:0;background:rgb(17,43,67)}.host{width:350px;height:400px}.monitor-content,.pane,.pane-body,.browser-surface{width:100%;height:100%;background:white}iframe{width:100%;height:100%;border:0}</style><div class="host" data-monitor-id="a5418259-f332-4d2f-be76-313a87b66023"><div class="monitor-content"><div class="pane"><div class="pane-body"><div class="browser-surface"><iframe sandbox="allow-scripts" src="'''+origin+'''/apps/hermes-live-tools-e7dcfb294c1fa5eabae242f1/index.html"></iframe></div></div></div></div></div>''')
    page.add_style_tag(content=css)
    expect(page.frame_locator('iframe').locator('#pause')).to_have_text('Pause')
    im=Image.open(BytesIO(page.screenshot())).convert('RGB')
    for point in [(2,2),(340,350),(10,390)]:
        assert im.getpixel(point)==(17,43,67),(point,im.getpixel(point))
    print('PASS: live stylesheet and published sandbox iframe show backdrop through all host layers at three sampled pixels; Pause control rendered.')
    b.close()
