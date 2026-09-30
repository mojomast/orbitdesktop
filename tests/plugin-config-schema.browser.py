"""Browser acceptance for the optional author config schema in the config editor.

Runs the real editor module against a disposable Vite dev server and a blank
fixture document. Verifies declared labels/help, dropdown enums, shown defaults
that never override a saved value, required markers, inline invalid handling,
cancel, advanced-JSON schema validation and a conflict that preserves the draft.
No workspace server, native prompt or external backend is involved.
"""
import json
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]

SCHEMA = {
    'fields': [
        {'key': 'title', 'type': 'string', 'title': 'Window title', 'description': 'Shown in the header.', 'default': 'Notes', 'required': True},
        {'key': 'mode', 'type': 'string', 'title': 'Theme mode', 'description': 'Pick a palette.', 'enum': ['light', 'dark'], 'default': 'light'},
        {'key': 'count', 'type': 'number', 'title': 'Item count', 'min': 0, 'max': 10, 'default': 5},
        {'key': 'pinned', 'type': 'boolean', 'title': 'Pin to top', 'default': False},
        {'key': 'owner', 'type': 'string', 'title': 'Owner', 'description': 'Required owner name.', 'required': True},
    ]
}


def main():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix='orbit-plugin-schema-', dir='/tmp/opencode') as scratch:
        config = Path(scratch) / 'vite.config.mjs'
        config.write_text('export default ' + json.dumps({
            'root': str(ROOT),
            'cacheDir': str(Path(scratch) / 'vite-cache'),
            'server': {'hmr': False},
            'optimizeDeps': {'entries': [str(ROOT / 'src/plugin-config-editor.ts'), str(ROOT / 'src/plugin-config-schema.ts')]},
        }))
        with open(Path(scratch) / 'vite.log', 'w') as log:
            server = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--config', str(config), '--host', '127.0.0.1', '--port', str(port), '--strictPort'],
                                      cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
            try:
                origin = f'http://127.0.0.1:{port}'
                for _ in range(200):
                    try:
                        urllib.request.urlopen(origin, timeout=.5).close()
                        break
                    except Exception:
                        if server.poll() is not None:
                            raise RuntimeError('Disposable frontend exited')
                        time.sleep(.1)
                else:
                    raise RuntimeError('Disposable frontend failed to start')
                run_browser(origin)
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()


def run_browser(origin):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        context = browser.new_context(viewport={'width': 1280, 'height': 1000})
        page = context.new_page()
        errors, native_dialogs = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('dialog', lambda dialog: (native_dialogs.append(dialog.message), dialog.dismiss()))
        page.route('**/__plugin_config_fixture__', lambda route: route.fulfill(content_type='text/html', body='<html><body style="margin:20px"></body></html>'))
        page.goto(origin + '/__plugin_config_fixture__')
        page.evaluate(
            """async (schema) => {
              await import('/src/plugin-config-editor.css');
              const { showPluginConfigEditor } = await import('/src/plugin-config-editor.ts');
              const { validatePluginConfigSchema } = await import('/src/plugin-config-schema.ts');
              const declared = validatePluginConfigSchema(schema);
              window.__applied = [];
              let conflict = false;
              window.__setConflict = value => { conflict = value; };
              window.__open = (config) => showPluginConfigEditor({
                pluginId: 'notes', title: 'Notes', backendConnected: false, schema: declared, config: config || {},
                onApply: async (operation) => {
                  if (conflict) { conflict = false; throw new Error('Workspace changed; read and retry'); }
                  window.__applied.push(operation);
                },
              });
            }""",
            SCHEMA,
        )

        def open_editor(config):
            page.evaluate('(config) => window.__open(config)', config)
            dialog = page.locator('dialog.plugin-editor')
            expect(dialog).to_be_visible()
            return dialog

        def row(dialog, key):
            return dialog.locator('.plugin-editor-row[data-key="' + key + '"]')

        seed = {'mode': 'light', 'count': 4, 'pinned': True, 'owner': 'Ada'}

        # Declared labels, help, enums, defaults and required markers render.
        dialog = open_editor(seed)
        title_row = row(dialog, 'title')
        expect(title_row.locator('.plugin-field-hint').first).to_contain_text('Shown in the header.')
        expect(title_row.locator('.plugin-field-default-hint')).to_contain_text('Default: "Notes"')
        assert title_row.locator('.plugin-field-input').get_attribute('placeholder') == 'Default: Notes', 'default is shown as a placeholder'
        expect(title_row.locator('.plugin-field-label').first).to_contain_text('required')
        mode_row = row(dialog, 'mode')
        assert mode_row.locator('select').input_value() == 'light', 'saved enum value wins over the default'
        assert set(mode_row.locator('select option').all_text_contents()) == {'—', 'light', 'dark'}
        assert row(dialog, 'count').locator('input').input_value() == '4', 'saved number must not be replaced by the default'
        assert row(dialog, 'pinned').locator('input[type=checkbox]').is_checked(), 'saved boolean preserved'
        expect(dialog.locator('.plugin-editor-schema-note')).to_contain_text('Declared by the app')

        # Editing one declared field patches only that key; untouched absent defaults stay absent.
        mode_row.locator('select').select_option('dark')
        dialog.get_by_role('button', name='Save configuration', exact=True).click()
        expect(dialog).to_have_count(0)
        assert page.evaluate('window.__applied') == [{'action': 'plugin_patch_config', 'patch': {'mode': 'dark'}}], page.evaluate('window.__applied')

        # Required field without a default blocks saving with an inline message.
        dialog = open_editor({'mode': 'light', 'count': 4, 'pinned': True})
        owner_row = row(dialog, 'owner')
        expect(owner_row.locator('.plugin-field-error')).to_contain_text('Required')
        expect(dialog.get_by_role('button', name='Save configuration', exact=True)).to_be_disabled()
        owner_row.locator('input').fill('Grace')
        expect(dialog.get_by_role('button', name='Save configuration', exact=True)).to_be_enabled()
        dialog.get_by_role('button', name='Cancel configuration', exact=True).click()
        expect(dialog).to_have_count(0)
        assert len(page.evaluate('window.__applied')) == 1, 'cancel must not apply'

        # Out-of-range numbers fail inline and keep the dialog open.
        dialog = open_editor(seed)
        row(dialog, 'count').locator('input').fill('99')
        expect(row(dialog, 'count').locator('.plugin-field-error')).to_contain_text('at most')
        expect(dialog.get_by_role('button', name='Save configuration', exact=True)).to_be_disabled()
        dialog.get_by_role('button', name='Cancel configuration', exact=True).click()
        expect(dialog).to_have_count(0)

        # Advanced JSON follows the same declared validation.
        dialog = open_editor(seed)
        dialog.locator('summary', has_text='Advanced').click()
        json_box = dialog.locator('.plugin-editor-json')
        json_box.fill(json.dumps({'mode': 'light', 'count': 4, 'pinned': True}))
        dialog.get_by_role('button', name='Apply advanced configuration JSON', exact=True).click()
        expect(dialog.locator('.plugin-editor-advanced .plugin-editor-form-error')).to_contain_text('owner')
        json_box.fill(json.dumps({'mode': 'dark', 'count': 4, 'pinned': True, 'owner': 'Ada'}))
        dialog.get_by_role('button', name='Apply advanced configuration JSON', exact=True).click()
        assert row(dialog, 'mode').locator('select').input_value() == 'dark', 'valid advanced JSON updates the form'
        dialog.get_by_role('button', name='Cancel configuration', exact=True).click()
        expect(dialog).to_have_count(0)

        # A conflict keeps the typed draft instead of closing on a false save.
        page.evaluate('window.__setConflict(true)')
        dialog = open_editor(seed)
        typed = row(dialog, 'title').locator('input')
        typed.fill('My notes')
        dialog.get_by_role('button', name='Save configuration', exact=True).click()
        expect(dialog).to_be_visible()
        expect(dialog.locator('.plugin-editor-status')).to_contain_text('Workspace changed')
        assert typed.input_value() == 'My notes', 'draft survives a conflict'
        assert len(page.evaluate('window.__applied')) == 1, 'conflict did not apply'
        dialog.get_by_role('button', name='Cancel configuration', exact=True).click()
        expect(dialog).to_have_count(0)

        assert not native_dialogs, native_dialogs
        assert not errors, errors
        page.screenshot(path='/tmp/opencode/orbit-plugin-config-schema.png')
        print('PASS: author config schema editor — labels, help, enums, defaults, required, invalid, cancel, conflict, advanced JSON')
        context.close()
        browser.close()


if __name__ == '__main__':
    main()
