"""Real build/CSS hot-swap test; preserves owner's wallpaper and original source."""
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from orbit_menu import menu, open_menu, close_menu
ROOT=Path(__file__).resolve().parents[1]
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);page=b.new_page(viewport={'width':1800,'height':1100})
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('https://kimi.tailec998.ts.net:4325/',wait_until='networkidle')
 page.evaluate('window.keepAliveProof = 123')
 menu(page,'Switch to spatial view')
 page.get_by_role('button',name='Settings for Display 01',exact=True).click(force=True)
 before=page.locator('.monitor').first.bounding_box()
 page.get_by_role('spinbutton',name='Diagonal',exact=True).fill('120')
 page.get_by_role('slider',name='Text size',exact=True).fill('6')
 page.wait_for_timeout(500)
 after=page.locator('.monitor').first.bounding_box()
 assert after['width']>before['width']*2,(before,after)
 state=page.evaluate("JSON.parse(localStorage.getItem('orbit.workspace.v1'))")
 assert state['monitors'][0]['diagonal']==120 and state['monitors'][0]['fontSize']==6
 print('120-inch spatial window visibly grows without camera auto-shrink; 6px text: passed',flush=True)
 # Real Vite build, using a visually inert rule. Observe the new stylesheet in the existing page.
 css=ROOT/'src/style.css';original=css.read_text()
 try:
  css.write_text(original+'\n:root { --orbit-live-proof: verified; }\n')
  subprocess.run(['npm','run','build'],cwd=ROOT,check=True,capture_output=True)
  for _ in range(50):
   if page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--orbit-live-proof').trim()")=='verified':break
   page.wait_for_timeout(200)
  else:raise AssertionError('Stylesheet did not update live')
  assert page.evaluate('window.keepAliveProof')==123
  assert 'clown-wallpaper.svg' in page.locator('.workspace').evaluate('(e)=>getComputedStyle(e).backgroundImage')
  print('Real stylesheet rebuild applied without page reload; clown wallpaper preserved: passed',flush=True)
 finally:
  css.write_text(original);subprocess.run(['npm','run','build'],cwd=ROOT,check=True,capture_output=True)
 assert not errors,errors
 b.close()
