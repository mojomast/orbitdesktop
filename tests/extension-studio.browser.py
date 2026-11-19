"""Actual finite Studio/publisher/server/iframe journey in disposable storage."""
import argparse
import json
import uuid
from playwright.sync_api import sync_playwright, expect
from theme_fixture import theme_fixture, unlock


def main(renderer):
    with theme_fixture('orbit-studio-browser-') as fixture, sync_playwright() as p:
        origin, token = fixture['origin'], fixture['token']
        browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        page = context.new_page(); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(origin + '/?renderer=' + renderer, wait_until='networkidle')
        page.keyboard.press('Escape'); unlock(page, token)
        workspace = page.evaluate("localStorage.getItem('orbit.workspace.id')")
        def api(route, body, key=token):
            response = context.request.post(origin + route, data={'workspace_id': workspace, **body}, headers={'Authorization': 'Bearer ' + key, 'Origin': origin})
            return response.status, response.json()
        def snapshot():
            status, data = api('/api/workspace', {'action': 'read'}); assert status == 200, data
            return data
        def mutate(body, route='/api/workspace'):
            return api(route, {'operation_id': str(uuid.uuid4()), 'intent': 'Synthetic Studio acceptance', 'base_revision': snapshot()['revision'], **body})
        def open_studio():
            page.keyboard.press('Control+Alt+p')
            page.get_by_role('button', name='Open Extension Studio', exact=True).click()
            return page.get_by_role('dialog', name='Extension Studio', exact=True)
        dialog = open_studio()
        before = snapshot()
        assert api('/api/extension-studio', {'action': 'list'}, 'invalid-token')[0] == 403
        assert api('/api/extension-studio', {'action': 'draft', 'operation_id': str(uuid.uuid4()), 'source': 'fetch("/api/workspace")'})[0] == 400
        dialog.get_by_role('button', name='Generate focus timer draft').click()
        expect(dialog.locator('.studio-status')).to_contain_text('Draft generated locally', timeout=30000)
        status, listed = api('/api/extension-studio', {'action': 'list'}); assert status == 200
        first = listed['drafts'][0]
        assert snapshot()['revision'] == before['revision']
        def check_preview(minutes='25:00'):
            dialog.get_by_role('button', name='Check exact Studio draft').click()
            expect(dialog.locator('.studio-status')).to_contain_text('Preview document loaded', timeout=20000)
            timer = dialog.frame_locator('iframe.studio-preview')
            expect(timer.locator('#clock')).to_have_text(minutes)
            timer.get_by_role('button', name='Start', exact=True).click()
            expect(timer.locator('#status')).to_have_text('Focusing')
            timer.get_by_role('button', name='Pause', exact=True).click()
            expect(timer.locator('#status')).to_have_text('Paused')
            timer.get_by_role('button', name='Reset', exact=True).click()
            expect(timer.locator('#clock')).to_have_text(minutes)
            return timer
        check_preview()
        expect(dialog.get_by_role('button', name='Retry exact Studio request')).to_be_hidden()
        dialog.locator('iframe.studio-preview').screenshot(path='/tmp/opencode/orbit-studio-preview-' + renderer + '.png')
        page.set_viewport_size({'width': 430, 'height': 900})
        assert dialog.evaluate('e=>e.scrollWidth<=e.clientWidth+1'), 'Studio dialog overflows narrow viewport'
        dialog.screenshot(path='/tmp/opencode/orbit-studio-narrow-' + renderer + '.png')
        page.set_viewport_size({'width': 1440, 'height': 1000})
        frame = next(f for f in page.frames if '/apps/' in f.url)
        denied = frame.evaluate("""async()=>{let parentDenied=false,storageDenied=false,networkDenied=false;try{void parent.document.body}catch{parentDenied=true}try{localStorage.setItem('probe','x')}catch{storageDenied=true}try{await fetch('/api/workspace')}catch{networkDenied=true}return {parentDenied,storageDenied,networkDenied}}""")
        assert all(denied.values()), denied
        def prepare():
            dialog.get_by_role('button', name='Prepare exact Studio install review').click()
            expect(dialog.locator('.studio-review')).to_be_visible(timeout=15000)
        def install():
            page.once('dialog', lambda d: d.accept())
            dialog.get_by_role('button', name='Install exact reviewed Studio artifact').click()
        prepare()
        # Stale workspace review cannot silently overwrite another edit.
        status, _ = mutate({'action': 'plugins_apply', 'operations': [{'action': 'plugin_disable_all'}]}); assert status == 200
        install(); expect(dialog.locator('.studio-status')).to_contain_text('stale_resource', timeout=15000)
        prepare()
        # Commit the real request, then lose its response. Retry must use the
        # retained exact payload/key, including after closing/reopening Studio.
        requests = []
        def lose_response(route):
            body = route.request.post_data_json
            if body.get('action') == 'install':
                requests.append(body)
                if len(requests) == 1:
                    response = route.fetch(); assert response.status == 200
                    if renderer == 'docking':
                        route.fulfill(status=503, json={'code': 'unavailable'})
                    else:
                        route.abort()
                    return
            route.continue_()
        page.route('**/api/extension-studio', lose_response)
        install(); expect(dialog.locator('.studio-status')).to_contain_text('Outcome unknown', timeout=20000)
        dialog.get_by_role('button', name='Close Extension Studio').click()
        dialog = open_studio()
        dialog.get_by_role('button', name='Retry exact Studio request').click()
        expect(dialog.locator('.studio-status')).to_contain_text('recovered receipt', timeout=20000)
        assert len(requests) == 2 and requests[0] == requests[1]
        page.unroute('**/api/extension-studio', lose_response)
        installed = snapshot()['state']['plugins'][0]
        assert installed['manifest']['entry'] == first['manifest']['entry']
        assert snapshot()['state']['monitors'][:len(before['state']['monitors'])] == before['state']['monitors']
        dialog.get_by_role('button', name='Close Extension Studio').click()
        live = page.frame_locator('iframe[src^="' + origin + first['manifest']['entry'] + '"]')
        expect(live.locator('#clock')).to_have_text('25:00', timeout=20000)
        # Later configuration survives a new release and a code-only rollback.
        assert mutate({'action': 'plugins_apply', 'operations': [{'action': 'plugin_patch_config', 'plugin_id': 'focus-timer', 'patch': {'minutes': 37}}]})[0] == 200
        dialog = open_studio()
        dialog.get_by_label('Release version', exact=True).fill('2.0.0')
        dialog.get_by_label('Accent color', exact=True).fill('#ffaa00')
        dialog.get_by_role('button', name='Generate focus timer draft').click()
        expect(dialog.locator('.studio-status')).to_contain_text('Draft generated locally', timeout=30000)
        check_preview('37:00'); prepare(); install()
        expect(dialog.locator('.studio-status')).to_contain_text('Installed exact artifact', timeout=20000)
        assert snapshot()['state']['plugins'][0]['manifest']['version'] == '2.0.0'
        assert mutate({'action': 'plugins_apply', 'operations': [{'action': 'plugin_patch_config', 'plugin_id': 'focus-timer', 'patch': {'minutes': 42}}]})[0] == 200
        dialog.get_by_role('button', name='Open Studio draft ' + first['id'], exact=True).click()
        check_preview('42:00'); prepare(); install()
        expect(dialog.locator('.studio-status')).to_contain_text('Installed exact artifact', timeout=20000)
        final = snapshot()['state']['plugins'][0]
        assert final['manifest']['entry'] == first['manifest']['entry'] and final['config']['minutes'] == 42
        assert final['window']['id'] == installed['window']['id']
        # Hold also detaches optional Studio previews. Release does not enable.
        assert mutate({'action': 'recovery_policy', 'held': True, 'confirm': True}, '/api/workspace/recovery')[0] == 200
        expect(dialog.locator('.studio-status')).to_contain_text('Recovery hold', timeout=10000)
        expect(dialog.locator('iframe')).to_have_count(0)
        assert mutate({'action': 'recovery_policy', 'held': False, 'confirm': True}, '/api/workspace/recovery')[0] == 200
        assert snapshot()['state']['plugins'][0]['enabled'] is False
        expect(dialog.get_by_role('button', name='Check exact Studio draft')).to_be_enabled(timeout=10000)
        page.once('dialog', lambda d: d.accept())
        dialog.get_by_role('button', name='Revoke Studio release').click()
        expect(dialog.locator('.studio-status')).to_contain_text('revoked', timeout=15000)
        assert api('/api/extension-studio', {'action': 'get', 'draft_id': first['id']})[0] == 410
        assert mutate({'action': 'plugins_apply', 'operations': [{'action': 'plugin_enable', 'plugin_id': 'focus-timer'}]})[0] >= 400
        page.screenshot(path='/tmp/opencode/orbit-studio-' + renderer + '.png')
        assert not errors, errors
        context.close(); browser.close()
        print('PASS Studio', renderer, 'exact publisher/preview, sandbox denial, stale refusal, recovered receipt, config-preserving rollback, hold and revocation')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--renderer', required=True, choices=['default', 'docking'])
    main(parser.parse_args().renderer)
