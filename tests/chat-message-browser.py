"""Disposable renderer fixture: no Orbit server, tokens, storage or providers.

Run with PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers
/tmp/opencode/orbit-evolution-browser-venv/bin/python tests/chat-message-browser.py
"""
import json
import pathlib
import socket
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]

with tempfile.TemporaryDirectory(prefix='.chat-renderer-test-', dir=ROOT) as fixture:
    path = pathlib.Path(fixture) / 'index.html'
    path.write_text('''<!doctype html><meta charset="utf-8">
<style>#messages { height: 240px; width: 480px; overflow: auto; }
.chat-message { padding: 8px; border-bottom: 1px solid gray; }</style>
<div id="messages"></div><div id="actions"></div>
<script type="module">
import {createChatMessageRenderer, renderChatText} from '/src/chat-message-renderer.ts';
import '/src/chat-message.css';
window.messages = document.querySelector('#messages');
window.renderer = createChatMessageRenderer(messages);
document.querySelector('#actions').append(renderer.latest);
window.turns = Array.from({length:30}, (_,i)=>({role:i%2?'assistant':'user',text:'Turn '+i+'\\nReadable paragraph for selection.'}));
window.draw = () => renderer.render(turns, 'fixture-session');
window.format = renderChatText;
window.copies = [];
Object.defineProperty(navigator, 'clipboard', {value:{writeText:async text=>copies.push(text)}, configurable:true});
draw(); window.ready = true;
</script>''')
    with tempfile.TemporaryFile() as log:
        server = subprocess.Popen(['node', 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', str(port), '--strictPort'], cwd=ROOT, stdout=log, stderr=log)
        try:
            url = f'http://127.0.0.1:{port}/{path.parent.name}/index.html'
            for _ in range(100):
                try:
                    urllib.request.urlopen(url, timeout=1).close()
                    break
                except Exception:
                    if server.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(log.read().decode())
                    time.sleep(.1)
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                page = browser.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(url)
                page.wait_for_function('window.ready === true')
                assert page.evaluate('messages.scrollHeight-messages.clientHeight-messages.scrollTop < 2')
                # Select an old paragraph while reading above the latest turn.
                page.evaluate('''() => {
                    messages.scrollTop = 150;
                    window.oldRow = messages.children[2];
                    const text = oldRow.querySelector('p').firstChild;
                    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 6);
                    getSelection().removeAllRanges(); getSelection().addRange(range);
                    window.selected = getSelection().toString(); window.topBefore = messages.scrollTop;
                    draw();
                }''')
                assert page.evaluate('messages.children[2] === oldRow && getSelection().toString() === selected && messages.scrollTop === topBefore')
                page.evaluate("turns.push({role:'assistant',text:'New unrelated reply'}); draw()")
                assert page.evaluate('messages.children[2] === oldRow && getSelection().toString() === selected && messages.scrollTop === topBefore')
                assert page.get_by_role('button', name='New messages · Jump to latest', exact=True).is_visible()
                page.get_by_role('button', name='New messages · Jump to latest', exact=True).click()
                assert page.evaluate('messages.scrollHeight-messages.clientHeight-messages.scrollTop < 2')
                page.evaluate("turns.push({role:'assistant',text:'Followed reply'}); draw()")
                assert page.evaluate('messages.scrollHeight-messages.clientHeight-messages.scrollTop < 2')
                # Trimming old history anchors the surviving visible paragraph.
                page.evaluate('''() => {
                    getSelection().removeAllRanges(); messages.scrollTop = 450;
                    window.anchor = [...messages.children].find(row => row.getBoundingClientRect().bottom > messages.getBoundingClientRect().top);
                    window.anchorY = anchor.getBoundingClientRect().top;
                    turns = turns.slice(2); draw();
                }''')
                assert page.evaluate('Math.abs(anchor.getBoundingClientRect().top-anchorY) < 2'), page.evaluate('({before:anchorY,after:anchor.getBoundingClientRect().top,top:messages.scrollTop})')
                # Updating another turn must not replace the selected turn.
                page.evaluate('''() => {
                    window.unchanged = messages.children[3];
                    turns[turns.length-1] = {role:'assistant', text:'Updated last reply'};
                    draw();
                }''')
                assert page.evaluate('messages.children[3] === unchanged')
                # Code, paragraphs and links are built as DOM; HTML is literal.
                rich = '<img src=x onerror="window.injected=true">\n\n[Safe](https://example.com) [Bad](javascript:alert%281%29)\n\n```js\nconst x = "<script>";\n```'
                page.evaluate('(text) => { turns.push({role:"assistant",text}); draw(); renderer.latest.click(); }', rich)
                assert page.locator('.chat-message').last.locator('img, script').count() == 0
                assert page.locator('.chat-message').last.locator('a').count() == 1
                assert page.locator('.chat-message').last.locator('a').get_attribute('rel') == 'noopener noreferrer'
                assert page.evaluate('window.injected !== true')
                page.locator('.chat-message').last.get_by_role('button', name='Copy message', exact=True).click()
                page.locator('.chat-message').last.get_by_role('button', name='Copy code', exact=True).click()
                assert page.evaluate('copies') == [rich, 'const x = "<script>";']
                page.evaluate('() => { navigator.clipboard.writeText = async () => { throw Error("denied"); }; }')
                page.locator('.chat-message').last.get_by_role('button', name='Copy code', exact=True).click()
                assert page.locator('.chat-message').last.get_by_text('Copy failed', exact=True).is_visible()
                assert page.evaluate('''() => {
                    const bounded = format('x\\n\\n'.repeat(1000));
                    const large = format('z'.repeat(100001));
                    const unclosed = format('```txt\\nraw <b>text</b>');
                    return bounded.children.length <= 401 && large.children.length === 1 && large.textContent.length === 100001 && unclosed.querySelector('code').textContent === 'raw <b>text</b>';
                }''')
                assert page.evaluate('''() => {
                    const unsafe = format('[a](data:text/html,evil) [b](//example.com) [c](javascript:alert%281%29) [d](mailto:owner@example.com)');
                    return unsafe.querySelectorAll('a').length === 1 && unsafe.querySelector('a').protocol === 'mailto:';
                }''')
                page.evaluate("renderer.render([{role:'user',text:'Different conversation'}], 'other-session')")
                assert page.locator('.chat-message').count() == 1
                assert not errors, json.dumps(errors)
                browser.close()
                print('PASS: selection, incremental updates, scroll/follow, history trimming, jump, copy/failure, safe formatting and bounds')
        finally:
            server.terminate()
            server.wait(timeout=10)
