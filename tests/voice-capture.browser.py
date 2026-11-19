"""Disposable dictation-surface acceptance for the Grok Bots microphone path.

The real Orbit Vue-free surface is mounted in a Vite fixture. A synthetic
oscillator-backed microphone and an in-page local worker stub exercise the
capture lifecycle and reviewed draft transfer. No model download, owner runtime,
real microphone, provider request or external origin is used.

PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-technology-browsers \
  /tmp/opencode/orbit-technology-venv/bin/python tests/voice-capture.browser.py
"""
import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix='orbit-dictation-', dir='/tmp/opencode') as temporary:
        root = Path(temporary)
        (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        (root / 'src').symlink_to(ROOT / 'src', target_is_directory=True)
        (root / 'contracts').symlink_to(ROOT / 'contracts', target_is_directory=True)
        (root / 'index.html').write_text('<meta charset="utf-8"><div id="host"></div><script type="module" src="/fixture.js"></script>')
        (root / 'fixture.js').write_text('''
          import {mountVoiceCapture} from '/src/voice-capture.ts';
          import {registerConversationRecipient} from '/src/conversation-transfer.ts';
          window.__delivered = '';
          registerConversationRecipient({id: 'fixture-grokbots', title: 'Grok Bots', available: true,
            receive: delivery => { window.__delivered = delivery.text; return {accepted: true}; }});
          const view = mountVoiceCapture(document.querySelector('#host'), () => 'fixture-token');
          const dispose = document.createElement('button');
          dispose.id = 'dispose'; dispose.textContent = 'Dispose fixture';
          dispose.onclick = () => view.dispose();
          document.body.append(dispose);
        ''')
        (root / 'vite.config.mjs').write_text('''
          export default {server:{fs:{allow:[%s,%s]}}};
        ''' % (json.dumps(str(ROOT)), json.dumps(str(root))))
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        origin = f'http://127.0.0.1:{port}'
        server = subprocess.Popen(
            [str(ROOT / 'node_modules/.bin/vite'), '--host', '127.0.0.1', '--port', str(port), '--strictPort'],
            cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            for _ in range(150):
                try:
                    urllib.request.urlopen(origin, timeout=1).close()
                    break
                except OSError:
                    time.sleep(.1)
            else:
                raise AssertionError('Fixture Vite did not start')
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True, args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
                context = browser.new_context(viewport={'width': 720, 'height': 900})
                context.add_init_script('''
                  class LocalWorkerStub {
                    postMessage(message) {
                      setTimeout(() => this.onmessage && this.onmessage({data: {id: message.id, type: 'result', text: 'Synthetic dictation.'}}), 20);
                    }
                    terminate() {}
                  }
                  window.Worker = LocalWorkerStub;
                  navigator.mediaDevices.getUserMedia = async () => {
                    const context = new AudioContext();
                    await context.resume();
                    const oscillator = context.createOscillator();
                    const destination = context.createMediaStreamDestination();
                    oscillator.connect(destination);
                    oscillator.start();
                    window.__fixtureMicrophone = context;
                    return destination.stream;
                  };
                ''')
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.route('**/vendor/voice/config.json', lambda route: route.fulfill(status=404, body=''))
                page.goto(origin)
                surface = page.locator('.voice-capture')
                expect(surface.get_by_role('heading', name='Dictation')).to_be_visible()
                expect(surface).to_contain_text('separately provisioned Moonshine model')
                expect(surface).to_contain_text('not provisioned')

                surface.get_by_role('button', name='Start recording').click()
                expect(surface).to_contain_text('Recording…')
                page.wait_for_timeout(800)
                surface.get_by_role('button', name='Stop recording').click()
                expect(surface.get_by_role('textbox', name='Dictation text')).to_have_value('Synthetic dictation.')

                surface.get_by_role('textbox', name='Dictation text').fill('Reviewed synthetic dictation.')
                surface.get_by_role('button', name='Insert into selected draft').click()
                dialog = page.get_by_role('dialog', name='Send text to a conversation')
                expect(dialog).to_be_visible()
                dialog.get_by_role('radio', name='Grok Bots').click()
                dialog.get_by_role('button', name='Insert into draft').click()
                expect(dialog).to_be_hidden()
                assert page.evaluate('window.__delivered') == 'Reviewed synthetic dictation.'

                page.locator('#dispose').click()
                expect(page.locator('.voice-capture')).to_have_count(0)
                assert not errors, errors
                browser.close()
                print('PASS dictation: local capture lifecycle, reviewed text and explicit Grok Bots draft transfer')
        finally:
            server.terminate()
            server.wait(timeout=10)


if __name__ == '__main__':
    main()
