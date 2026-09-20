from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright,expect
R=Path(__file__).resolve().parents[1]
def pid():return subprocess.check_output(['docker','exec','orbit-xpra-editor','pgrep','-x','mousepad'],text=True).strip()
url='https://kimi.tailec998.ts.net:4355/?floating_menu=false&sharing=true&orbit_app=1'
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox'])
 original=pid();g=b.new_page()
 g.goto(url);g.locator('#password').fill('invalid-password');g.get_by_text('Connect',exact=True).click()
 expect(g.get_by_text('authentication failed',exact=False).first).to_be_visible(timeout=20000)
 assert g.locator('canvas').count()==0
 assert pid()==original
 for _ in range(2):
  g.goto(url);g.locator('#password').fill((R/'.runtime/xpra/password').read_text().strip());g.get_by_text('Connect',exact=True).click()
  expect(g.locator('canvas').first).to_be_visible(timeout=30000)
  assert pid()==original
 g.close();assert pid()==original
 b.close()
 print('PASS: wrong password denied; two authenticated connections do not duplicate editor; disconnect preserves process')
