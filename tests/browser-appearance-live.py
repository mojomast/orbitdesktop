"""Exercise appearance delivery against a page opened before the build."""
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
THEME=ROOT/'src/workspace-theme.css'
original=THEME.read_text()
with tempfile.TemporaryDirectory() as temp, sync_playwright() as p:
    css=Path(temp)/'theme.css'
    browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
    page=browser.new_page()
    page.goto('https://kimi.tailec998.ts.net:4325/',wait_until='networkidle')
    page.evaluate('window.appearanceDocumentProof = 729')
    before=page.locator('.workspace').evaluate('(e)=>getComputedStyle(e).backgroundImage')
    command=['python3',str(ROOT/'scripts/workspace_appearance.py'),'--css-file',str(css)]
    try:
        css.write_text(original+'\n.workspace { --appearance-proof: delivered; }\n')
        result=subprocess.run(command,cwd=ROOT,capture_output=True,text=True,check=True)
        print(result.stdout.strip(),flush=True)
        for _ in range(75):
            if page.locator('.workspace').evaluate("(e)=>getComputedStyle(e).getPropertyValue('--appearance-proof').trim()")=='delivered':break
            page.wait_for_timeout(200)
        else:raise AssertionError('Live appearance command did not reach open page')
        assert page.evaluate('window.appearanceDocumentProof')==729
        assert page.locator('.workspace').evaluate('(e)=>getComputedStyle(e).backgroundImage')==before
        print('PASS: new appearance command updated a pre-existing document; no refresh, wallpaper preserved.',flush=True)
    finally:
        css.write_text(original)
        subprocess.run(command,cwd=ROOT,capture_output=True,text=True,check=True)
        browser.close()
