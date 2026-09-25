"""Real viewer and shared input regression; uses a fresh test browser, not owner tabs."""
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect
R = Path(__file__).resolve().parents[1]
env = dict(x.split('=', 1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
entry = '/apps/shared-desktop-a5d53e5943977e06620d8c0a/index.html'
def remote(*args):
    return subprocess.check_output(['docker','exec','-e','DISPLAY=:99','orbit-shared-desktop',*args], text=True)
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=['--no-sandbox'])
    g = b.new_page(viewport={'width':1500,'height':1100})
    g.goto(env['ORBIT_PUBLIC_ORIGIN'], wait_until='networkidle')
    g.get_by_role('button',name='Connect local host',exact=True).click()
    g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN'])
    g.get_by_role('button',name='Unlock local host',exact=True).click()
    g.wait_for_timeout(1500)
    wid_test = g.evaluate('localStorage.getItem("orbit.workspace.id")')
    import json
    subprocess.run(['python3',str(R/'scripts/workspace_control.py'),'--workspace',wid_test,'apply',json.dumps([{'action':'set_view','view':'windows'},{'action':'add_window','name':'Shared desktop test','kind':'browser','url':'https://kimi.tailec998.ts.net:4346/vnc.html?autoconnect=1&resize=scale&reconnect=1','frame':{'x':10,'y':10,'width':1440,'height':980,'z':100}}])],check=True,capture_output=True)
    f = g.frame_locator('iframe[src*="4346/vnc.html"]')
    f.locator('#noVNC_password_input').fill((R/'.runtime/shared-browser/password.txt').read_text().strip())
    f.locator('#noVNC_credentials_button').click()
    canvas = f.locator('#noVNC_container canvas')
    expect(canvas).to_be_visible(timeout=20000)
    # Actual X application receives keyboard events over the browser's VNC connection.
    subprocess.run(['docker','exec','-d','-e','DISPLAY=:99','orbit-shared-desktop','mousepad','/home/browser/shared-acceptance.txt'],check=True)
    wid = remote('xdotool','search','--sync','--onlyvisible','--class','Mousepad').splitlines()[-1]
    remote('xdotool','windowactivate','--sync',wid)
    canvas.focus()
    g.keyboard.press('Control+a')
    g.keyboard.type('Human viewer input + ',delay=40)
    remote('xdotool','type','--clearmodifiers','Hermes agent input')
    remote('xdotool','key','--clearmodifiers','ctrl+s')
    import time
    for _ in range(30):
        result = subprocess.run(['docker','exec','orbit-shared-desktop','cat','/home/browser/shared-acceptance.txt'],capture_output=True,text=True)
        if 'Hermes agent input' in result.stdout:break
        time.sleep(.1)
    assert result.stdout.strip() == 'Human viewer input + Hermes agent input', repr(result.stdout)
    g.screenshot(path=str(R/'.runtime/shared-desktop-test.png'))
    g.close()
    assert 'Hermes agent input' in remote('cat','/home/browser/shared-acceptance.txt')
    assert remote('xdotool','search','--onlyvisible','--class','Mousepad').strip()
    b.close()
    print('PASS: actual Orbit external-browser pane, real X desktop canvas, human VNC + agent X input in same saved file, viewer close preserves application.')
