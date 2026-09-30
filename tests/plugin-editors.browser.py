"""Browser acceptance for the accessible plugin config/window editors.

Runs the real manager UI in a disposable isolated server. Verifies primitive
typing, inline validation, cancel, partial-patch preservation, the external
backend notice and the removal fallback to whole-object configuration. No
native prompt is accepted anywhere in the flow.
"""
import json
import uuid
from theme_fixture import theme_fixture, connect
from playwright.sync_api import sync_playwright, expect

PLUGIN_ID = 'notes'
MANIFEST = {'apiVersion': 1, 'id': PLUGIN_ID, 'version': '1.0.0', 'title': 'Notes', 'entry': '/apps/notes-editor/index.html'}


def is_plugins_apply(request):
    if request.method != 'POST' or not request.url.endswith('/api/workspace'):
        return False
    try:
        body = request.post_data_json or {}
    except Exception:
        return False
    return body.get('action') == 'plugins_apply'


def main():
    with theme_fixture('orbit-plugin-editors-browser-') as fixture, sync_playwright() as p:
        origin, token = fixture['origin'], fixture['token']
        browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        page = context.new_page()
        errors, native_dialogs = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('dialog', lambda dialog: (native_dialogs.append(dialog.message), dialog.dismiss()))
        connect(page, origin, token)

        def api(body, route='/api/workspace'):
            response = context.request.post(origin + route, data={'workspace_id': workspace, **body}, headers={'Authorization': 'Bearer ' + token, 'Origin': origin})
            return response.status, response.json()

        def snapshot():
            status, data = api({'action': 'read'})
            assert status == 200, data
            return data

        def plugin():
            state = snapshot()['state']
            instance = next(item for item in state['plugins'] if item['manifest']['id'] == PLUGIN_ID)
            window = next(item for item in state['monitors'] if item['id'] == instance['window']['id']) if instance['enabled'] else instance['window']
            return instance, window

        workspace = page.evaluate("localStorage.getItem('orbit.workspace.id')")
        revision = snapshot()['revision']
        status, data = api({'action': 'plugins_apply', 'base_revision': revision, 'operation_id': str(uuid.uuid4()), 'intent': 'Seed plugin editor acceptance',
                            'operations': [{'action': 'plugin_install', 'manifest': MANIFEST, 'config': {'title': 'Notes', 'count': 3, 'pinned': True}}]})
        assert status == 200, data

        page.keyboard.press('Control+Alt+p')
        manager = page.get_by_role('dialog', name='Workspace plugins', exact=True)
        expect(manager).to_be_visible()
        card = manager.locator('.plugin-card[data-plugin-id="' + PLUGIN_ID + '"]')
        expect(card).to_be_visible()

        def open_config():
            card.get_by_role('button', name='Configure plugin ' + PLUGIN_ID, exact=True).click()
            dialog = page.get_by_role('dialog', name='Configure Notes')
            expect(dialog).to_be_visible()
            return dialog

        def open_window():
            card.get_by_role('button', name='Customize plugin window ' + PLUGIN_ID, exact=True).click()
            dialog = page.get_by_role('dialog').filter(has_text='Window settings · Notes')
            expect(dialog).to_be_visible()
            return dialog

        def row(dialog, key):
            return dialog.locator('.plugin-editor-row[data-key="' + key + '"]')

        def save_config_capture(dialog):
            with page.expect_request(is_plugins_apply) as captured:
                dialog.get_by_role('button', name='Save configuration', exact=True).click()
            operation = captured.value.post_data_json['operations'][0]
            expect(dialog).to_have_count(0)
            return operation

        def save_window_capture(dialog):
            with page.expect_request(is_plugins_apply) as captured:
                dialog.get_by_role('button', name='Save window settings', exact=True).click()
            operation = captured.value.post_data_json['operations'][0]
            expect(dialog).to_have_count(0)
            return operation

        # Primitive typing is inferred from the existing config.
        dialog = open_config()
        assert row(dialog, 'title').locator('.plugin-field-input').get_attribute('type') == 'text'
        assert row(dialog, 'count').locator('.plugin-field-input').get_attribute('type') == 'number'
        assert row(dialog, 'pinned').locator('.plugin-field-check').get_attribute('type') == 'checkbox'
        expect(dialog.locator('.plugin-editor-note').first).to_contain_text('Do not store secrets')

        # A single edited number is sent as a partial patch; omitted fields stay.
        row(dialog, 'count').locator('.plugin-field-input').fill('7')
        operation = save_config_capture(dialog)
        assert operation == {'action': 'plugin_patch_config', 'plugin_id': PLUGIN_ID, 'patch': {'count': 7}}, operation
        page.wait_for_timeout(600)
        assert plugin()[0]['config'] == {'title': 'Notes', 'count': 7, 'pinned': True}

        # Invalid input blocks saving with an inline message and Cancel is inert.
        dialog = open_config()
        row(dialog, 'count').locator('.plugin-field-input').fill('')
        expect(row(dialog, 'count').locator('.plugin-field-error')).to_be_visible()
        expect(dialog.get_by_role('button', name='Save configuration', exact=True)).to_be_disabled()
        dialog.get_by_role('button', name='Cancel configuration', exact=True).click()
        expect(dialog).to_have_count(0)
        page.wait_for_timeout(400)
        assert plugin()[0]['config']['count'] == 7

        # Adding a bounded key patches only that key (partial preservation).
        dialog = open_config()
        dialog.get_by_role('button', name='Add configuration field', exact=True).click()
        added = dialog.locator('.plugin-editor-row').last
        added.locator('.plugin-field-key').fill('note')
        added.locator('.plugin-field-input').fill('hello')
        operation = save_config_capture(dialog)
        assert operation == {'action': 'plugin_patch_config', 'plugin_id': PLUGIN_ID, 'patch': {'note': 'hello'}}, operation
        page.wait_for_timeout(600)
        assert plugin()[0]['config'] == {'title': 'Notes', 'count': 7, 'pinned': True, 'note': 'hello'}

        # Advanced JSON validates before replacing the typed fields; invalid text is rejected.
        dialog = open_config()
        dialog.locator('summary', has_text='Advanced').click()
        json_box = dialog.locator('.plugin-editor-json')
        json_box.fill('{not json')
        dialog.get_by_role('button', name='Apply advanced configuration JSON', exact=True).click()
        expect(dialog.locator('.plugin-editor-advanced .plugin-editor-form-error')).to_be_visible()
        json_box.fill(json.dumps({'alpha': 'x', 'beta': 2, 'gamma': False}))
        dialog.get_by_role('button', name='Apply advanced configuration JSON', exact=True).click()
        expect(dialog.locator('.plugin-editor-row')).to_have_count(3)
        expect(dialog.locator('.plugin-editor-row[data-key="alpha"]')).to_have_count(1)
        dialog.get_by_role('button', name='Cancel configuration', exact=True).click()
        expect(dialog).to_have_count(0)
        page.wait_for_timeout(400)
        assert plugin()[0]['config'] == {'title': 'Notes', 'count': 7, 'pinned': True, 'note': 'hello'}

        # Removing a key cannot be expressed as a merge, so it uses whole-object configure.
        dialog = open_config()
        assert row(dialog, 'title').count() == 1
        row(dialog, 'title').locator('.plugin-remove-field').click()
        operation = save_config_capture(dialog)
        assert operation['action'] == 'plugin_configure', operation
        assert operation['config'] == {'count': 7, 'pinned': True, 'note': 'hello'}, operation
        page.wait_for_timeout(600)
        assert 'title' not in plugin()[0]['config']

        # Window editor: friendly name/font/opacity, partial patch, no geometry clobbering.
        dialog = open_window()
        assert dialog.get_by_label('Window name', exact=True).input_value() == 'Notes'
        assert dialog.get_by_label('Font size (px)', exact=True).input_value() == '19'
        assert dialog.get_by_label('Opacity', exact=True).input_value() == ''
        dialog.get_by_label('Window name', exact=True).fill('Focused notes')
        dialog.get_by_label('Font size (px)', exact=True).fill('22')
        dialog.get_by_label('Opacity', exact=True).fill('0.8')
        operation = save_window_capture(dialog)
        assert operation == {'action': 'plugin_window', 'plugin_id': PLUGIN_ID, 'settings': {'name': 'Focused notes', 'fontSize': 22, 'opacity': 0.8}}, operation
        page.wait_for_timeout(600)
        assert plugin()[1]['name'] == 'Focused notes' and plugin()[1]['opacity'] == 0.8

        dialog = open_window()
        assert dialog.get_by_label('Window name', exact=True).input_value() == 'Focused notes'
        dialog.get_by_label('Font size (px)', exact=True).fill('24')
        operation = save_window_capture(dialog)
        assert operation == {'action': 'plugin_window', 'plugin_id': PLUGIN_ID, 'settings': {'fontSize': 24}}, operation
        page.wait_for_timeout(600)
        window = plugin()[1]
        assert window['name'] == 'Focused notes' and window['opacity'] == 0.8 and window['fontSize'] == 24

        dialog = open_window()
        dialog.get_by_label('Font size (px)', exact=True).fill('99')
        expect(dialog.locator('.plugin-editor-status')).to_be_visible()
        expect(dialog.get_by_role('button', name='Save window settings', exact=True)).to_be_disabled()
        dialog.get_by_role('button', name='Cancel window settings', exact=True).click()
        expect(dialog).to_have_count(0)

        # A stale revision / API conflict keeps the dialog open with the typed draft
        # and never shows a false "saved" close.
        conflict = {'armed': False}

        def conflict_route(route):
            try:
                body = route.request.post_data_json or {}
            except Exception:
                body = {}
            if conflict['armed'] and body.get('action') == 'plugins_apply':
                conflict['armed'] = False
                route.fulfill(status=409, content_type='application/json', body=json.dumps({'category': 'REVISION_CONFLICT', 'error': 'Workspace changed; read and retry'}))
            else:
                route.continue_()

        page.route('**/api/workspace', conflict_route)
        dialog = open_config()
        draft = row(dialog, 'note').locator('.plugin-field-input')
        draft.fill('stale-draft')
        conflict['armed'] = True
        dialog.get_by_role('button', name='Save configuration', exact=True).click()
        expect(dialog).to_be_visible()
        expect(dialog.locator('.plugin-editor-status')).to_contain_text('Workspace changed')
        assert draft.input_value() == 'stale-draft'
        expect(dialog.get_by_role('button', name='Save configuration', exact=True)).to_be_enabled()
        dialog.get_by_role('button', name='Cancel configuration', exact=True).click()
        expect(dialog).to_have_count(0)
        page.unroute('**/api/workspace', conflict_route)
        page.wait_for_timeout(300)
        assert plugin()[0]['config']['note'] == 'hello'

        # Backend-connected widgets state that config is not delivered to the backend.
        revision = snapshot()['revision']
        status, data = api({'action': 'plugins_apply', 'base_revision': revision, 'operation_id': str(uuid.uuid4()), 'intent': 'Connect synthetic backend',
                            'operations': [{'action': 'plugin_backend', 'plugin_id': PLUGIN_ID, 'endpoint': 'https://example.com', 'confirm_host_access': True}]})
        assert status == 200, data
        page.wait_for_timeout(400)
        manager.get_by_role('button', name='Refresh workspace plugins', exact=True).click()
        page.wait_for_timeout(600)
        dialog = open_config()
        notice = dialog.locator('.plugin-editor-backend')
        expect(notice).to_be_visible()
        expect(notice).to_contain_text('NOT sent to the external service')
        dialog.get_by_role('button', name='Cancel configuration', exact=True).click()
        expect(dialog).to_have_count(0)

        # Stable docs links, not the old feature branch.
        href = manager.locator('.plugin-contribute').get_attribute('href')
        assert '/blob/main/plugin-catalog/README.md' in href, href
        assert page.locator('a[href*="feat/reviewed-plugin-catalog"]').count() == 0
        assert not native_dialogs, native_dialogs
        assert not errors, errors
        page.screenshot(path='/tmp/opencode/orbit-plugin-editors.png')
        print('PASS: accessible plugin config/window editors — typing, validation, cancel, partial patch, backend notice, stable links')
        context.close(); browser.close()


if __name__ == '__main__':
    main()
