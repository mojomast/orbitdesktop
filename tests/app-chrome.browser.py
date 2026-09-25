"""Isolated pane UI regression test; does not load the owner's workspace."""
import json
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page()
    page.goto('http://127.0.0.1:4187/src/style.css')
    page.set_content('<link rel="stylesheet" href="/src/style.css"><link rel="stylesheet" href="/src/workspace-theme.css">')
    result = page.evaluate('''async () => {
      const {createPane} = await import('/src/panes.ts');
      const actions = {kind(){},split(){},close(){},url(){}};
      const results = [];
      for (const url of ['/apps/hermes-token-stats/', '/apps/guy-3d/', location.origin+'/apps/example/', 'https://example.com']) {
        const pane = createPane({id:crypto.randomUUID(),kind:'browser',url},19,actions);
        const root = pane.element;
        root.style.cssText='width:320px;height:470px;display:flex;flex-direction:column';
        document.body.append(root);
        const local = !url.includes('example.com');
        for (const selector of ['.pane-head','.browser-nav']) {
          const hidden = getComputedStyle(root.querySelector(selector)).display === 'none';
          if(hidden !== local) throw Error(url+' wrong controls: '+selector);
        }
        if(root.querySelector('.embed-note')) throw Error('Embedding warning remains');
        const frame = root.querySelector('iframe');
        const surface = root.querySelector('.browser-surface');
        if(Math.abs(frame.getBoundingClientRect().height-surface.getBoundingClientRect().height)>1) throw Error('Unused bottom gap');
        pane.setFont(13);
        if(Math.abs(frame.getBoundingClientRect().height-surface.getBoundingClientRect().height)>1) throw Error('Zoom leaves bottom gap');
        if(local && frame.sandbox.contains('allow-same-origin')) throw Error('Sandbox weakened');
        results.push({url,appControlsHidden:local,warningRemoved:true,fullHeight:true});
        pane.dispose(); root.remove();
      }
      return results;
    }''')
    print(json.dumps(result))
    browser.close()
