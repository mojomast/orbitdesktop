from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,args=['--no-sandbox'])
    page=b.new_page(viewport={'width':1200,'height':900})
    page.set_content('<div class="windows-mode"><div data-monitor-id="480f30c9-9d43-4be3-950e-63832e4f50de" style="z-index:9999"></div><button id="front" style="position:fixed;right:20px;bottom:20px;width:300px;height:300px;z-index:1">Foreground</button></div>')
    page.add_style_tag(content=(root/'src/workspace-theme.css').read_text())
    box=page.locator('[data-monitor-id]').bounding_box()
    assert box['x']+box['width']==1180 and box['y']+box['height']==880,box
    assert page.evaluate("document.elementFromPoint(1100,800).id")=='front'
    page.locator('#front').click()
    page.locator('#front').evaluate('(e)=>e.remove()')
    assert page.evaluate("document.elementFromPoint(1100,800).dataset.monitorId")=='480f30c9-9d43-4be3-950e-63832e4f50de'
    b.close()
    print('PASS telemetry bottom-right anchoring and foreground occlusion/hit testing with production source CSS')
