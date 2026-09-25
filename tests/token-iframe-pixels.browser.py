"""Pixel regression: a real sandboxed widget embedded beneath dark host CSS."""
from pathlib import Path
from io import BytesIO
from PIL import Image
from playwright.sync_api import sync_playwright, expect
root = Path(__file__).resolve().parents[1]
env = dict(x.split('=', 1) for x in (root / '.env.deploy').read_text().splitlines() if '=' in x)
origin = env['ORBIT_PUBLIC_ORIGIN'].rstrip('/')
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':800,'height':600})
    page.route(origin + '/__pixel_test__', lambda route: route.fulfill(content_type='text/html', body='<!doctype html><html></html>'))
    page.goto(origin + '/__pixel_test__')
    # No owner workspace loaded or modified. Host dark color scheme matches Orbit.
    page.set_content('<style>html{color-scheme:dark}body{margin:0;background:rgb(17,43,67)}iframe{width:320px;height:350px;border:0;background:transparent}</style><iframe sandbox="allow-scripts" src="'+origin+'/apps/hermes-token-stats/"></iframe>')
    frame = page.frame_locator('iframe')
    expect(frame.locator('#total')).not_to_have_text('—')
    def pixel():
        return Image.open(BytesIO(page.screenshot())).convert('RGB').getpixel((2,2))
    before = pixel()
    import re
    index = page.request.get(origin).text()
    css_path = re.search(r'href="([^"]+\.css)"', index).group(1)
    css = page.request.get(origin + css_path).text()
    assert 'color-scheme:normal!important' in css
    page.locator('body').evaluate('(e)=>e.dataset.monitorId="480f30c9-9d43-4be3-950e-63832e4f50de"')
    page.add_style_tag(content=css)
    page.add_style_tag(content='body{background:rgb(17,43,67)!important}')
    after = pixel()
    print({'inherited_dark_pixel': before, 'explicit_normal_pixel': after, 'wallpaper_expected': (17,43,67)})
    assert after == (17,43,67), 'Sandboxed iframe did not show host background'
    browser.close()
