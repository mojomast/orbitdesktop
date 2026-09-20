"""Real Xpra browser input, password rejection, reconnect and shared-viewer test."""
from pathlib import Path
import subprocess
import time
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
URL='http://127.0.0.1:4348/'
def remote(*args):
 return subprocess.check_output(['docker','exec','orbit-xpra-pilot',*args],text=True)
def connect(g):
 g.goto(URL)
 g.locator('#password').fill((ROOT/'.runtime/xpra/password').read_text())
 g.get_by_text('Connect',exact=True).click()
 expect(g.locator('canvas').first).to_be_visible(timeout=30000)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox'])
 bad=b.new_page()
 bad.goto(URL)
 bad.locator('#password').fill('intentionally-wrong-password')
 bad.get_by_text('Connect',exact=True).click()
 expect(bad.get_by_text('authentication failed',exact=False).first).to_be_visible(timeout=20000)
 assert bad.locator('canvas').count()==0
 bad.close()
 g=b.new_page(viewport={'width':1280,'height':900})
 connect(g)
 pid=remote('pgrep','-x','mousepad').strip()
 g.locator('canvas').first.click(position={'x':180,'y':180})
 g.keyboard.press('Control+a')
 # Remote GUI needs physical Shift state, not Playwright's text-only uppercase events.
 for char in 'Orbit Xpra browser input verified. No VNC.':
  if char.isupper(): g.keyboard.press('Shift+'+char)
  else: g.keyboard.type(char,delay=30)
 g.keyboard.press('Control+s')
 for _ in range(50):
  result=remote('python3','-c','from pathlib import Path; print(Path("/home/browser/Welcome.txt").read_text())')
  if result.strip()=='Orbit Xpra browser input verified. No VNC.':break
  time.sleep(.1)
 assert result.strip()=='Orbit Xpra browser input verified. No VNC.',repr(result)
 g.reload()
 g.locator('#password').fill((ROOT/'.runtime/xpra/password').read_text())
 g.get_by_text('Connect',exact=True).click()
 expect(g.locator('canvas').first).to_be_visible(timeout=30000)
 assert remote('pgrep','-x','mousepad').strip()==pid
 second=b.new_page()
 connect(second)
 expect(g.locator('canvas').first).to_be_visible()
 g.screenshot(path=str(ROOT/'.runtime/xpra/verified.png'))
 second.close(); g.close()
 assert remote('pgrep','-x','mousepad').strip()==pid
 b.close()
 print('PASS: wrong password rejected; authenticated Xpra canvas; browser keystrokes saved exact text; reload reconnect preserves editor PID; two viewers; closing viewers preserves application.')
