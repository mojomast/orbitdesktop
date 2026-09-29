"""Private, offline presentation checks; no backend, execution or model calls."""
import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def main():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix='orbit-diff-presentation-', dir='/tmp/opencode') as scratch:
        # This fixture injects a viewer after navigation, so a dependency-discovery
        # HMR reload would erase the harness. Use an isolated cold cache, discover
        # both entrypoints up front, and disable application reloads explicitly.
        config = Path(scratch) / 'vite.config.mjs'
        config.write_text('export default ' + json.dumps({'root': str(ROOT), 'cacheDir': str(Path(scratch) / 'vite-cache'), 'server': {'hmr': False}, 'optimizeDeps': {'entries': [str(ROOT / 'src/candidate-diff-viewer.ts'), str(ROOT / 'src/candidate-diff-worker.ts')]}}))
        with open(Path(scratch) / 'vite.log', 'w') as log:
            server = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--config', str(config), '--host', '127.0.0.1', '--port', str(port), '--strictPort'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
            try:
                origin = f'http://127.0.0.1:{port}'
                for _ in range(100):
                    try:
                        urllib.request.urlopen(origin, timeout=.5).close()
                        break
                    except Exception:
                        if server.poll() is not None:
                            raise RuntimeError('Disposable frontend exited')
                        time.sleep(.1)
                else:
                    raise RuntimeError('Disposable frontend failed to start')
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(headless=True)
                    context = browser.new_context(viewport={'width': 1440, 'height': 1100}, permissions=['clipboard-read', 'clipboard-write'])
                    page = context.new_page()
                    errors = []
                    requests = []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.on('request', lambda req: requests.append(req.url))
                    page.route('**/__diff_fixture__', lambda route: route.fulfill(content_type='text/html', body='<html><body style="margin:20px"></body></html>'))
                    page.goto(origin + '/__diff_fixture__')
                    page.evaluate(r'''async () => {
                      await import('/src/theme-chrome.css');
                      const {createCandidateDiffViewer}=await import('/src/candidate-diff-viewer.ts');
                      window.makeViewer=(data)=>{window.viewer?.dispose();window.viewer?.element.remove(); window.viewer=createCandidateDiffViewer(data);document.body.append(window.viewer.element);};
                      const base=Array.from({length:100},(_,i)=>`export const value${i} = ${i};\n`);
                      const after=[...base];after[10]='export const value10 = 999;\n';after[80]='export const value80 = 888;\n';
                      const file=(path,old_text,new_text)=>({path,old_hash:old_text===null?null:'a'.repeat(64),new_hash:new_text===null?null:'b'.repeat(64),old_mode:old_text===null?null:'100644',new_mode:new_text===null?null:'100644',text_available:true,old_text,new_text});
                      window.fixture={available:true,comparison:'previous',from:{candidate_id:'candidate-fixture',generation:1,candidate_hash:'1'.repeat(64)},to:{candidate_id:'candidate-fixture',generation:2,candidate_hash:'2'.repeat(64)},changed_files:4,files:[file('src/example.ts',base.join(''),after.join('')),file('new.html',null,'<img src=x onerror="window.injected=true">PRIVATE_DIFF_SENTINEL\n'),file('old.txt','removed\n',null),{...file('mode.sh','echo ok\n','echo ok\n'),new_hash:'a'.repeat(64),new_mode:'100755'}]};
                      document.documentElement.dataset.orbitTheme='midnight';makeViewer(fixture);
                    }''')
                    viewer = page.locator('.candidate-diff-viewer')
                    expect(viewer.locator('.cdv-header')).to_contain_text('4 / 4 files')
                    page.wait_for_function("document.querySelectorAll('.cdv-word').length > 0")
                    expect(viewer.locator('.cdv-table')).to_have_class('cdv-table cdv-split')
                    assert viewer.locator('.cdv-row').count() < 30
                    expect(viewer.locator('[class*="hljs-"]').first).to_be_attached()
                    page.wait_for_function("!document.querySelector('.cdv-header').textContent.includes('partial')")
                    expect(viewer.locator('.cdv-header')).to_contain_text('+3 −3')
                    expect(viewer.locator('.cdv-identity-strip')).to_contain_text('g1')
                    viewer.get_by_role('button', name='Next hunk', exact=True).click()
                    expect(viewer.locator('.cdv-navigation')).to_contain_text('1 / 2 hunks')
                    viewer.focus()
                    page.keyboard.press('Alt+ArrowDown')
                    expect(viewer.locator('.cdv-navigation')).to_contain_text('2 / 2 hunks')
                    viewer.get_by_label('Diff layout').select_option('unified')
                    expect(viewer.locator('.cdv-table')).to_have_class('cdv-table cdv-unified')
                    viewer.get_by_label('Search supplied file paths and source').fill('value50')
                    expect(viewer.locator('.cdv-match').first).to_have_text('value50')
                    viewer.get_by_role('button', name='Next search result', exact=True).click()
                    expect(viewer.locator('.cdv-search')).to_contain_text('2 / 2')
                    viewer.get_by_label('Search supplied file paths and source').fill('')
                    viewer.get_by_label('Context lines').select_option('-1')
                    expect(viewer.locator('.cdv-row')).to_have_count(102)
                    viewer.get_by_role('button', name='Wrap', exact=True).click()
                    expect(viewer.get_by_role('button', name='Wrap', exact=True)).to_have_attribute('aria-pressed', 'false')
                    viewer.get_by_role('button', name='Wrap', exact=True).click()
                    expect(viewer).to_have_class('candidate-diff-viewer cdv-wrap')
                    viewer.get_by_role('button', name='Raw unified', exact=True).click()
                    expect(viewer.locator('.cdv-raw')).to_contain_text('--- a/src/example.ts')
                    viewer.get_by_role('button', name='Copy raw unified', exact=True).click()
                    assert 'value10 = 999' in page.evaluate('navigator.clipboard.readText()')
                    viewer.get_by_role('button', name='Raw unified', exact=True).click()
                    viewport = viewer.locator('.cdv-viewport')
                    viewport.evaluate('(el)=>el.scrollTop=700')
                    previous = viewport.evaluate('(el)=>el.scrollTop')
                    viewer.get_by_role('button', name='Expand', exact=True).click()
                    expect(page.locator('dialog.cdv-dialog')).to_be_visible()
                    viewer.get_by_role('button', name='Return to pane', exact=True).click()
                    assert viewport.evaluate('(el)=>el.scrollTop') == previous
                    viewer.get_by_role('button', name='Next file', exact=True).click()
                    expect(viewer.locator('.cdv-file-identity')).to_contain_text('Added file')
                    assert viewer.locator('img').count() == 0
                    assert page.evaluate('window.injected === undefined')
                    viewer.get_by_role('button', name='Next file', exact=True).click()
                    expect(viewer.locator('.cdv-file-identity')).to_contain_text('Deleted file')
                    viewer.get_by_role('button', name='Next file', exact=True).click()
                    expect(viewer.locator('.cdv-file-identity')).to_contain_text('Mode change')
                    expect(viewer.locator('.cdv-file-identity')).to_contain_text('100644 → 100755')
                    stored = page.evaluate('JSON.stringify({...localStorage})')
                    assert 'PRIVATE_DIFF_SENTINEL' not in stored and 'value50' not in stored
                    assert not any('/api/' in url or 'PRIVATE_DIFF_SENTINEL' in url for url in requests)

                    # A minified file must remain bounded even with a one-character search.
                    page.evaluate('''()=>{const f=fixture.files[0];makeViewer({...fixture,changed_files:1,files:[{...f,path:'long.txt',old_text:'x'.repeat(30000),new_text:'x'.repeat(29999)+'y'}]});}''')
                    page.wait_for_function("document.querySelector('.cdv-row')")
                    viewer.get_by_label('Search supplied file paths and source').fill('x')
                    expect(viewer.locator('.cdv-search')).to_contain_text('matching paths')
                    assert viewer.locator('.cdv-match').count() <= 256
                    # The 5k-line source remains memory-local; All renders only one row page.
                    page.evaluate(r'''()=>{const old=Array.from({length:5000},(_,i)=>`v${i}\n`);const next=[...old];next[100]='changed\n';next[4900]='changedAgain\n';makeViewer({...fixture,changed_files:1,files:[{...fixture.files[0],old_text:old.join(''),new_text:next.join('')}]});}''')
                    page.wait_for_function("document.querySelector('.cdv-row')")
                    viewer.get_by_label('Context lines').select_option('-1')
                    assert viewer.locator('.cdv-row').count() <= 360
                    viewer.get_by_role('button', name='Ignore whitespace', exact=True).click()
                    expect(viewer).to_contain_text('Underlying candidate contents and hashes are unchanged')
                    page.set_viewport_size({'width': 420, 'height': 900})
                    page.wait_for_function("document.querySelector('.cdv-unified')")
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    for theme in ['midnight', 'paper']:
                        page.evaluate('(theme)=>document.documentElement.dataset.orbitTheme=theme', theme)
                        colors = viewer.evaluate('(el)=>({fg:getComputedStyle(el).color,bg:getComputedStyle(el).backgroundColor})')
                        assert colors['fg'] != colors['bg']
                    page.evaluate("()=>makeViewer({...fixture,available:false,reason:'historical_diff_unavailable',current_generation:5})")
                    expect(viewer).to_contain_text('No substitute version is displayed')
                    expect(viewer).to_contain_text('Current generation: 5')
                    assert viewer.locator('.cdv-row').count() == 0
                    page.evaluate('viewer.dispose()')
                    assert viewer.inner_text() == ''
                    assert not errors, errors
                    print('PASS diff presentation: navigation, folds, source safety, layout, themes, bounded long-line search and 5k-line paging')
                    browser.close()
            finally:
                server.terminate()
                server.wait(timeout=10)


if __name__ == '__main__':
    main()
