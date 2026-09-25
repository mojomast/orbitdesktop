"""Run against a local Vite server, never the owner's live workspace."""
import json
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.goto('http://127.0.0.1:4187/src/workspace-theme.css')
    page.set_content('''<link rel="stylesheet" href="/src/style.css"><link rel="stylesheet" href="/src/workspace-theme.css"><div class="workspace" style="position:relative;width:1200px;height:800px"><div id="host" style="width:1200px;height:800px"></div></div>''')
    result = page.evaluate('''async () => {
      const { DesktopScene } = await import('/src/scene.ts');
      const { monitor } = await import('/src/model.ts');
      const m = monitor(1, 'browser');
      m.id = '67143ce5-4b26-40e6-9077-b082cb498584';
      const outer = document.createElement('article');
      outer.className = 'monitor'; outer.dataset.monitorId = m.id;
      outer.innerHTML = '<div class="monitor-bar"><button class="guy-toggle">Restore</button></div><div class="monitor-content">Guy</div>';
      const scene = new DesktopScene(document.querySelector('#host'));
      const elements = new Map([[m.id, outer]]);
      const update = () => scene.update([m], elements, m.id, 14);
      const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      update(); await frame();
      const obj = scene.objects.get(m.id);
      if (!obj.mesh.visible || !obj.edges.visible) throw Error('Initially visible backing missing');
      const original = obj.css.element.getBoundingClientRect();
      outer.classList.add('guy-minimized'); update(); await frame();
      if (obj.mesh.visible || obj.edges.visible) throw Error('Ghost WebGL backing remains');
      if (getComputedStyle(obj.css.element).pointerEvents !== 'none') throw Error('Anchor still blocks clicks');
      if (getComputedStyle(outer).pointerEvents !== 'none') throw Error('Monitor still blocks clicks');
      if (getComputedStyle(outer.querySelector('.monitor-content')).display !== 'none') throw Error('Content not hidden');
      const b = outer.querySelector('button').getBoundingClientRect();
      if (document.elementFromPoint(b.x+b.width/2,b.y+b.height/2) !== outer.querySelector('button')) throw Error('Restore button not clickable');
      const hit = document.elementFromPoint(original.x+original.width*.7,original.y+original.height*.7);
      if (obj.css.element.contains(hit)) throw Error('Original window region still intercepts clicks');
      const minimized = {width: outer.offsetWidth, height: outer.offsetHeight};
      outer.classList.remove('guy-minimized'); update(); await frame();
      if (!obj.mesh.visible || !obj.edges.visible) throw Error('Backing not restored');
      if (getComputedStyle(outer.querySelector('.monitor-content')).display === 'none') throw Error('Content not restored');
      scene.dispose();
      return {backingHidden: true, clickThrough: true, restoreClickable: true, restored: true, minimized};
    }''')
    print(json.dumps(result))
    browser.close()
