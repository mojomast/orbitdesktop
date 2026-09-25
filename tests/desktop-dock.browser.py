"""Browser acceptance in a separate Orbit test workspace, never owner tabs."""
from pathlib import Path
import json,subprocess,uuid
from playwright.sync_api import sync_playwright,expect
R=Path(__file__).resolve().parents[1]
env=dict(x.split('=',1) for x in (R/'.env.deploy').read_text().splitlines() if '=' in x)
def remote(code):return subprocess.check_output(['docker','exec','orbit-shared-desktop','python3','-c',code],text=True)
code=remote("from pathlib import Path; print(Path('/home/browser/Desktop/Orbit Dock Pairing.txt').read_text().splitlines()[2])").strip()
name='dock-browser-'+uuid.uuid4().hex+'.txt'
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,args=['--no-sandbox'])
    g=b.new_page(viewport={'width':1500,'height':1100});errors=[]
    g.on('pageerror',lambda e:errors.append(str(e)))
    g.goto(env['ORBIT_PUBLIC_ORIGIN'],wait_until='networkidle')
    g.get_by_role('button',name='Connect local host',exact=True).click()
    g.get_by_role('textbox',name='Host session token').fill(env['ORBIT_TOKEN'])
    g.get_by_role('button',name='Unlock local host',exact=True).click()
    g.wait_for_function('localStorage.getItem("orbit.workspace.id")')
    wid=g.evaluate('localStorage.getItem("orbit.workspace.id")')
    subprocess.run(['python3',str(R/'scripts/workspace_control.py'),'--workspace',wid,'apply',json.dumps([{'action':'set_view','view':'windows'},{'action':'add_window','name':'Desktop Dock acceptance','kind':'browser','url':'https://kimi.tailec998.ts.net:4347/','frame':{'x':10,'y':10,'width':1000,'height':950,'z':100}}])],check=True,capture_output=True)
    f=g.frame_locator('iframe[src="https://kimi.tailec998.ts.net:4347/"]')
    f.locator('#code').fill(code);f.get_by_role('button',name='Pair desktop',exact=True).click()
    expect(f.locator('#dock')).to_be_visible(timeout=20000)
    f.locator('#upload').set_input_files({'name':name,'mimeType':'text/plain','buffer':b'Browser to desktop acceptance'})
    expect(f.locator('#status')).to_contain_text('Saved to desktop',timeout=20000)
    assert remote("from pathlib import Path; print(Path('/home/browser/Orbit Inbox/"+name+"').read_text())").strip()=='Browser to desktop acceptance'
    remote("from pathlib import Path; Path('/home/browser/Orbit Inbox/"+name+"').write_text('Actual desktop return path')")
    f.locator('#files .row').filter(has_text=name).get_by_role('button').click()
    expect(f.locator('#preview')).to_have_text('Actual desktop return path')
    f.get_by_role('button',name='Inbox folder',exact=True).click()
    expect(f.locator('#status')).to_contain_text('launch requested',timeout=15000)
    f.get_by_role('button',name='Refresh',exact=True).click()
    row=f.locator('#windows .row').filter(has_text='Orbit Inbox').first
    expect(row).to_be_visible(timeout=15000)
    row.get_by_role('button',name='Focus',exact=True).click()
    expect(f.locator('#status')).to_contain_text('Window focused',timeout=15000)
    g.screenshot(path=str(R/'.runtime/desktop-dock-acceptance.png'))
    assert not errors,errors
    # Standalone view supports actual binary download (embedded Orbit intentionally does not).
    direct=b.new_page();direct.goto('https://kimi.tailec998.ts.net:4347/')
    direct.locator('#code').fill(code);direct.get_by_role('button',name='Pair desktop').click();expect(direct.locator('#dock')).to_be_visible()
    with direct.expect_download() as download:
        direct.locator('#files .row').filter(has_text=name).get_by_role('button').click()
    assert Path(download.value.path()).read_bytes()==b'Actual desktop return path'
    b.close()
remote("from pathlib import Path; Path('/home/browser/Orbit Inbox/"+name+"').unlink()")
print('PASS: actual Orbit iframe pairing, browser upload, desktop read-back, reverse text transfer, launch and verified focus, standalone download, no JavaScript errors.')
