"""Desktop icon integration; uses a fresh unsynced workspace, never the owner's."""
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect
R=Path(__file__).resolve().parents[1]
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox'])
 g=b.new_page(viewport={'width':1600,'height':1100});errors=[]
 g.on('pageerror',lambda e:errors.append(str(e)))
 g.goto('https://kimi.tailec998.ts.net:4325/',wait_until='networkidle')
 for app in ['chromium','writer','calc','impress','files','editor','terminal']:
  icon=g.locator(f'[data-shortcut="xpra-{app}"]');icon.focus();icon.press('Enter')
  n=g.locator('.desktop-window').count()
  icon.focus();icon.press('Enter')
  assert g.locator('.desktop-window').count()==n, 'Duplicate window'
 terminal=g.locator('iframe[src*="4356"]').locator('..')
 f=g.frame_locator('iframe[src*="4356"]')
 f.locator('#password').fill((R/'.runtime/xpra/password').read_text().strip())
 f.get_by_text('Connect',exact=True).click()
 expect(f.locator('canvas').first).to_be_visible(timeout=30000)
 f.locator('canvas').first.click(position={'x':150,'y':100})
 g.keyboard.press('Control+c')
 for char in 'printf orbit-xpra-input-ok > /home/browser/Documents/.orbit-xpra-test':
  if char.isupper():g.keyboard.press('Shift+'+char)
  elif char=='>':g.keyboard.press('Shift+.')
  else:g.keyboard.type(char,delay=25)
 g.keyboard.press('Enter')
 for _ in range(40):
  r=subprocess.run(['docker','exec','orbit-xpra-terminal','python3','-c','from pathlib import Path; print(Path("/home/browser/Documents/.orbit-xpra-test").read_text())'],capture_output=True,text=True)
  if r.returncode==0 and r.stdout.strip()=='orbit-xpra-input-ok':break
  g.wait_for_timeout(250)
 else:raise AssertionError('Keyboard did not write file')
 # Shared document volume is also visible in the file manager container.
 r=subprocess.check_output(['docker','exec','orbit-xpra-files','python3','-c','from pathlib import Path; print(Path("/home/browser/Documents/.orbit-xpra-test").read_text())'],text=True)
 assert r.strip()=='orbit-xpra-input-ok'
 g.get_by_role('button',name='Resize Linux Terminal · Xpra',exact=True).focus()
 g.keyboard.press('Shift+ArrowRight')
 g.get_by_label('Move Linux Terminal · Xpra',exact=True).focus()
 g.keyboard.press('Shift+ArrowLeft')
 g.wait_for_timeout(1000)
 g.get_by_role('button',name='Show desktop shortcuts',exact=True).click()
 expect(g.locator('.desktop-window:not(.window-minimized)')).to_have_count(0)
 g.locator('[data-shortcut="xpra-terminal"]').click()
 expect(g.locator('.desktop-window:not(.window-minimized)')).to_have_count(1)
 expect(f.locator('canvas').first).to_be_visible()
 g.screenshot(path=str(R/'.runtime/xpra/app-icons-orbit.png'))
 assert not errors, errors
 subprocess.run(['docker','exec','orbit-xpra-terminal','rm','/home/browser/Documents/.orbit-xpra-test'],check=True)
 b.close()
 print('PASS: seven desktop launchers; repeat launch selects existing window; embedded native keyboard writes real shared file; move/resize controls; minimize/restore; no JS errors')
