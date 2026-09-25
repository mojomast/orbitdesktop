from playwright.sync_api import sync_playwright, expect
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from orbit_menu import menu, open_menu, close_menu

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1600, 'height': 1000})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('https://kimi.tailec998.ts.net:4325/', wait_until='networkidle')
    page.evaluate('''() => {const s=JSON.parse(localStorage.getItem('orbit.workspace.v1')); s.view='windows'; s.sidebarHidden=false; s.monitors.forEach((m,i)=>{m.frame={x:10+i*380,y:10,width:370,height:500,z:i+1}; m.layout={type:'pane',pane:{id:'test-pane-'+i,kind:'browser',url:'orbit://welcome'}};}); s.selected=s.monitors[0].id; localStorage.setItem('orbit.workspace.v1',JSON.stringify(s));}''')
    page.reload(wait_until='networkidle')
    state = page.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1"))')
    m = state['monitors'][0]
    win = page.locator(f'[data-monitor-id="{m["id"]}"]')
    toggle = win.get_by_role('button', name=f'Toggle transparency for {m["name"]}', exact=True)
    toggle.click()
    expect(win).to_have_css('opacity', '0.8')
    expect(toggle).to_have_attribute('aria-pressed', 'true')
    slider = page.get_by_role('slider', name='Window opacity', exact=True)
    slider.fill('65')
    expect(win).to_have_css('opacity', '0.65')
    other = page.locator(f'[data-monitor-id="{state["monitors"][1]["id"]}"]')
    expect(other).to_have_css('opacity', '1')
    page.reload(wait_until='networkidle')
    expect(win).to_have_css('opacity', '0.65')
    menu(page,'Switch to spatial view')
    expect(win).to_have_css('opacity', '0.65')
    toggle.click(force=True)
    expect(win).to_have_css('opacity', '1')
    assert not errors, errors
    print('PASS: per-window toggle, slider, isolation, reload persistence, spatial view, opaque reset; no JavaScript errors')
    browser.close()
