"""Real SDK/Vite two-origin fixture; private synthetic snapshots only."""
import json, os, subprocess, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
server=subprocess.Popen(['node','scripts/mcp-apps-fixture.mjs'],cwd=ROOT,stdout=subprocess.PIPE,text=True)
try:
    config=json.loads(server.stdout.readline())
    snapshot=json.load(urllib.request.urlopen(config['origin']+'/fixture-snapshot'))
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
        page=browser.new_page()
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.on('console',lambda message:print('console',message.text) if message.type=='error' else None)
        mcp_requests=[]
        page.on('request',lambda request:mcp_requests.append(request.post_data_json) if request.url.endswith('/api/mcp-apps') else None)
        page.goto(config['origin']+'/?locked=1')
        page.get_by_label('MCP App snapshot JSON').fill(json.dumps(snapshot))
        expect(page.locator('p[role="status"]')).to_contain_text('Connect host')
        page.get_by_role('button',name='Unlock fixture host').click()
        expect(page.locator('p[role="status"]')).to_contain_text('Ready to import')
        expect(page.get_by_label('MCP App snapshot JSON')).to_have_value(json.dumps(snapshot))
        expect(page.locator('.mcp-apps-view iframe')).to_have_count(0)
        page.get_by_role('button',name='Import snapshot',exact=True).click()
        app=page.frame_locator('.mcp-apps-view iframe').frame_locator('iframe')
        try:
            expect(app.locator('#result')).to_contain_text('Exact saved result',timeout=20000)
        except AssertionError:
            print({'body':page.locator('body').inner_text(),'errors':errors,'frames':[(f.url,f.locator('body').inner_text()) for f in page.frames]})
            raise
        app.locator('#local').click()
        expect(app.locator('#local')).to_have_text('Local interaction works')
        expect(page.get_by_label('Latest app log')).to_contain_text('Reference result rendered')
        app.locator('#deny').click()
        expect(app.locator('#denied')).to_have_text('Denied 7')
        assert page.locator('.mcp-apps-view iframe').get_attribute('src').startswith(config['sandboxOrigin'])
        assert 'fixture-token' not in app.locator('html').inner_text()
        page.reload()
        expect(page.locator('p[role="status"]')).to_contain_text('Connect host')
        expect(page.get_by_role('button',name='Open Reference snapshot',exact=True)).to_have_count(0)
        page.get_by_role('button',name='Unlock fixture host').click()
        expect(page.get_by_role('button',name='Open Reference snapshot',exact=True)).to_have_count(1)
        expect(page.locator('.mcp-apps-view iframe')).to_have_count(0)
        page.get_by_role('button',name='Open Reference snapshot',exact=True).click()
        expect(app.locator('#result')).to_contain_text('Exact saved result')
        app.locator('#resize').click()
        expect(page.locator('.mcp-apps-view iframe')).to_have_attribute('style','height: 550px;')
        # Wrong nonce from the bound outer window must never resize the host.
        outer=page.frames[1]
        outer.evaluate("parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:1599},orbitNonce:'wrong'},'*')")
        # A sibling/host window with the correct nonce is still the wrong source.
        page.evaluate("""()=>{const frame=document.querySelector('.mcp-apps-view iframe');const nonce=new URLSearchParams(new URL(frame.src).hash.slice(1)).get('nonce');window.postMessage({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:1599},orbitNonce:nonce},location.origin);window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,origin:'https://wrong.example',data:{jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:1599},orbitNonce:nonce}}));}""")
        assert page.locator('.mcp-apps-view iframe').evaluate('(el)=>el.style.height')=='550px'
        page.get_by_role('button',name='Cancel app',exact=True).click()
        expect(app.locator('#result')).to_have_text('Cancelled')

        # Delay real server bytes across credential and workspace changes.
        draft='typed import remains across connection changes'
        page.get_by_label('MCP App snapshot JSON').fill(draft)
        pending=[]
        held_action={'value':'get'}
        def hold_api(route):
            if (route.request.post_data_json or {}).get('action')==held_action['value']:
                response=route.fetch()
                pending.append((route,response))
            else:
                route.continue_()
        page.route('**/api/mcp-apps',hold_api)
        page.get_by_role('button',name='Open Reference snapshot',exact=True).click()
        for _ in range(200):
            if pending:break
            page.wait_for_timeout(10)
        assert pending,'Expected held real get response'
        held_action['value']='none'
        page.get_by_role('button',name='Rotate fixture token').click() # no connect event; polling detects this
        old_route,old_response=pending.pop()
        old_route.fulfill(response=old_response)
        expect(page.locator('p[role="status"]')).to_contain_text('Ready to import')
        expect(page.locator('.mcp-apps-view iframe')).to_have_count(0)
        expect(page.get_by_label('MCP App snapshot JSON')).to_have_value(draft)
        page.get_by_role('button',name='Open Reference snapshot',exact=True).click()
        expect(app.locator('#result')).to_contain_text('Exact saved result')

        held_action['value']='list'
        page.get_by_role('button',name='Refresh saved snapshots',exact=True).click()
        for _ in range(200):
            if pending:break
            page.wait_for_timeout(10)
        assert pending,'Expected held real list response'
        workspace=page.evaluate("localStorage.getItem('orbit.workspace.id')")
        page.evaluate("localStorage.setItem('orbit.workspace.id','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');window.dispatchEvent(new StorageEvent('storage',{key:'orbit.workspace.id'}));")
        held_action['value']='none'
        old_route,old_response=pending.pop()
        old_route.fulfill(response=old_response)
        expect(page.locator('p[role="status"]')).to_contain_text('Workspace binding changed')
        expect(page.locator('.mcp-apps-view iframe')).to_have_count(0)
        expect(page.get_by_role('button',name='Open Reference snapshot',exact=True)).to_have_count(0)
        expect(page.get_by_label('MCP App snapshot JSON')).to_have_value(draft)
        page.evaluate("scope=>{localStorage.setItem('orbit.workspace.id',scope);window.dispatchEvent(new StorageEvent('storage',{key:'orbit.workspace.id'}));}",workspace)
        expect(page.get_by_role('button',name='Open Reference snapshot',exact=True)).to_have_count(1)
        expect(page.locator('.mcp-apps-view iframe')).to_have_count(0)
        page.get_by_role('button',name='Open Reference snapshot',exact=True).click()
        expect(app.locator('#result')).to_contain_text('Exact saved result')
        page.locator('#host').dispatch_event('detach')
        expect(page.locator('.mcp-apps-view iframe')).to_have_count(0)
        after_dispose=len(mcp_requests)
        page.get_by_role('button',name='Unlock fixture host').click()
        page.evaluate("window.dispatchEvent(new StorageEvent('storage',{key:'orbit.workspace.id'}));")
        page.wait_for_timeout(650) # exceed the binding-check interval after disposal
        assert len(mcp_requests)==after_dispose,'Disposed host reconnected'
        assert not errors, errors
        browser.close()
    print('MCP Apps: real SDK protocol, denials/binding, locked reload/unlock library, stale token/workspace races, cancel and detach passed')
finally:
    server.terminate()
    server.wait(timeout=15)
