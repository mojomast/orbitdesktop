"""Real duplicate manager/editor/iframe journey in a disposable runtime."""
import uuid
from playwright.sync_api import sync_playwright, expect
from theme_fixture import theme_fixture, connect


def main():
    with theme_fixture('orbit-plugin-instances-browser-') as fixture, sync_playwright() as p:
        origin, token = fixture['origin'], fixture['token']
        browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        connect(page, origin, token)
        workspace = page.evaluate("localStorage.getItem('orbit.workspace.id')")

        def api(body, route='/api/workspace'):
            if route == '/api/workspace' and 'operation_id' in body:
                body = {'intent': 'Isolated widget instance acceptance', **body}
            r = context.request.post(origin + route, data={'workspace_id': workspace, **body}, headers={'Authorization': 'Bearer ' + token, 'Origin': origin})
            assert r.ok, r.text()
            return r.json()

        def snapshot():
            return api({'action': 'read'})

        def studio(body):
            return api(body, '/api/extension-studio')

        draft = studio({'action': 'draft', 'operation_id': str(uuid.uuid4()), 'spec': {'id': 'instance-timer', 'title': 'Instance timer', 'version': '1.0.0', 'minutes': 25, 'accent': '#b5f268'}})['draft']
        studio({'action': 'check', 'draft_id': draft['id']})
        proposal = studio({'action': 'preview', 'draft_id': draft['id'], 'operation_id': str(uuid.uuid4())})['proposal']
        studio({'action': 'install', 'proposal_id': proposal['id'], 'artifact_digest': proposal['artifact_digest'], 'preview_digest': proposal['preview_digest'], 'operation_id': str(uuid.uuid4()), 'confirm': True})
        api({'action': 'plugins_apply', 'base_revision': snapshot()['revision'], 'operation_id': str(uuid.uuid4()), 'operations': [{'action': 'plugin_update', 'plugin_id': 'instance-timer', 'manifest': {**draft['manifest'], 'configSchema': {'fields': [{'key': 'minutes', 'type': 'number', 'min': 1, 'max': 180, 'default': 25}]}}}]})
        revision = snapshot()['revision']
        rejected = context.request.post(origin + '/api/workspace', data={'workspace_id': workspace, 'action': 'plugins_apply', 'intent': 'Invalid schema endpoint probe', 'base_revision': revision, 'operation_id': str(uuid.uuid4()), 'operations': [{'action': 'plugin_patch_config', 'plugin_id': 'instance-timer', 'patch': {'minutes': 0}}]}, headers={'Authorization': 'Bearer ' + token, 'Origin': origin})
        assert not rejected.ok, 'endpoint accepted out-of-schema configuration'
        assert snapshot()['revision'] == revision
        page.wait_for_function("entry => [...document.querySelectorAll('iframe')].some(f=>f.getAttribute('src')?.includes(entry))", arg=draft['manifest']['entry'], timeout=20000)
        expect(page.frame_locator('iframe[src*="' + draft['manifest']['entry'] + '"]').locator('#clock')).to_have_text('25:00')
        original = next(frame for frame in page.frames if draft['manifest']['entry'] in frame.url)
        expect(original.locator('#clock')).to_have_text('25:00')
        original.evaluate("window.__instanceContinuity = 'original-document'")
        original.get_by_role('button', name='Start', exact=True).click()
        original.get_by_role('button', name='Pause', exact=True).click()
        expect(original.locator('#status')).to_have_text('Paused')
        before = snapshot()['state']

        page.locator('body').click(position={'x': 5, 'y': 5})
        page.keyboard.press('Control+Alt+p')
        manager = page.get_by_role('dialog', name='Workspace plugins', exact=True)
        primary = manager.locator('.plugin-card[data-plugin-id="instance-timer"]:not([data-instance-id])')
        primary.get_by_role('button', name='Duplicate plugin instance-timer', exact=True).click()
        expect(manager.locator('.plugin-card[data-plugin-id="instance-timer"]')).to_have_count(2)
        copy = snapshot()['state']['plugins'][1]
        card = manager.locator('.plugin-card[data-instance-id="' + copy['instance_id'] + '"]')
        expect(card).to_contain_text('Instance ' + copy['instance_id'])
        label = 'instance-timer instance ' + copy['instance_id']
        assert original.evaluate('window.__instanceContinuity') == 'original-document'
        expect(original.locator('#status')).to_have_text('Paused')
        after = snapshot()['state']
        assert after['monitors'][:len(before['monitors'])] == before['monitors']
        assert copy['window']['id'] != before['plugins'][0]['window']['id']

        card.get_by_role('button', name='Configure plugin ' + label, exact=True).click()
        config = page.get_by_role('dialog', name='Configure ' + copy['window']['name'], exact=True)
        # The default is effective at runtime but still absent from stored config.
        row = config.locator('.plugin-editor-row[data-key="minutes"]')
        row.locator('input[type="number"]').fill('7')
        config.get_by_role('button', name='Save configuration', exact=True).click()
        expect(config).to_have_count(0)
        assert snapshot()['state']['plugins'][0]['config'] == before['plugins'][0]['config']
        page.wait_for_function("entry => [...document.querySelectorAll('iframe')].some(f=>f.getAttribute('src')?.includes(entry)&&f.getAttribute('src').includes('%3A7%7D'))", arg=draft['manifest']['entry'], timeout=20000)
        expect(page.frame_locator('iframe[src*="%3A7%7D"]').locator('#clock')).to_have_text('07:00')
        copied_frame = next(frame for frame in page.frames if draft['manifest']['entry'] in frame.url and '%3A7%7D' in frame.url)
        expect(copied_frame.locator('#clock')).to_have_text('07:00')
        assert original.evaluate('window.__instanceContinuity') == 'original-document'

        card.get_by_role('button', name='Customize plugin window ' + label, exact=True).click()
        settings = page.get_by_role('dialog').filter(has_text='Window settings · ' + copy['window']['name'])
        settings.get_by_label('Window name', exact=True).fill('Independent timer')
        settings.get_by_role('button', name='Save window settings', exact=True).click()
        expect(settings).to_have_count(0)
        expect(card).to_contain_text('Independent timer')
        card.get_by_role('button', name='Disable plugin ' + label, exact=True).click()
        expect(card.get_by_role('button', name='Enable plugin ' + label, exact=True)).to_be_visible()
        assert snapshot()['state']['plugins'][0]['enabled'] is True
        card.get_by_role('button', name='Enable plugin ' + label, exact=True).click()
        expect(card.get_by_role('button', name='Disable plugin ' + label, exact=True)).to_be_visible()
        assert original.evaluate('window.__instanceContinuity') == 'original-document'
        assert not errors, errors
        browser.close()
        print('PASS: duplicate UI, fresh identities, original iframe continuity, independent config/window/enable')


if __name__ == '__main__':
    main()
