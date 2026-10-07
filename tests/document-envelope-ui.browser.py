"""Real agent-chat completion path: envelope acceptance and visible refusal.

Each scenario mounts the actual chat adapter against a synthetic authenticated
run, so the assertions cover the shipped UI rather than the parser alone.
No provider, no owner APIs, no private data.
"""
import json, os, socket, subprocess, tempfile, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault('PLAYWRIGHT_BROWSERS_PATH', '/tmp/opencode/orbit-evolution-browsers')

def element(**over):
    base = dict(id='shape-1', type='rectangle', x=0, y=0, width=120, height=60, angle=0,
                strokeColor='#1e1e1e', backgroundColor='transparent', fillStyle='solid',
                strokeWidth=2, strokeStyle='solid', roughness=1, opacity=100, groupIds=[],
                frameId=None, index='a0', roundness=None, seed=1, version=1, versionNonce=1,
                isDeleted=False, boundElements=None, updated=1, link=None, locked=False)
    base.update(over)
    return base

RICHTEXT = {'title': 'Project brief', 'kind': 'richtext', 'format': 'lexical', 'content': json.dumps({'root': {'type': 'root', 'version': 1, 'format': '', 'indent': 0, 'direction': None, 'children': []}})}
# A canvas shaped like a genuine Excalidraw export: full appState, collaborators,
# frame name and element customData.
CANVAS = {'title': 'Deployment plan', 'kind': 'scene', 'format': 'excalidraw', 'content': json.dumps({
    'type': 'excalidraw', 'version': 2, 'source': 'https://excalidraw.com',
    'elements': [element(), element(id='text-1', type='text', fontFamily=5, fontSize=16, text='Crew', originalText='Crew', width=60, height=20),
                 element(id='frame-1', type='frame', name='Stage 1', customData={'note': 'power'})],
    'appState': {'gridSize': 20, 'viewBackgroundColor': '#ffffff', 'scrollX': 90, 'scrollY': -12,
                 'zoom': {'value': 1.25}, 'theme': 'light', 'currentItemFontFamily': 5,
                 'collaborators': {'u1': {'username': 'owner'}}, 'openDialog': 'elementProperties'},
    'files': {}})}

def fence(document):
    return '```orbit-document\n' + json.dumps({'document': document}) + '\n```'

SCENARIOS = [
    # fix 3: an explanatory reply followed by the artifact must still deliver.
    ('prose-then-canvas', 'Here is the plan. Relay month 14 from DOC-04.\n\n' + fence(CANVAS), 'ok', 'Deployment plan'),
    # fix 2: the canvas itself is the thing that used to be refused.
    ('canvas-only', fence(CANVAS), 'ok', 'Deployment plan'),
    ('richtext-only', fence(RICHTEXT), 'ok', 'Project brief'),
    ('bare-json', json.dumps({'document': RICHTEXT}), 'ok', 'Project brief'),
    # fix 1: these must each explain themselves instead of vanishing.
    ('truncated', '```orbit-document\n' + json.dumps({'document': CANVAS})[:400] + '\n```', 'refused', 'not complete valid JSON'),
    ('retired-font', fence({**CANVAS, 'content': CANVAS['content'].replace('"fontFamily": 5', '"fontFamily": 1')}), 'refused', 'Excalifont'),
    ('trailing-text', fence(RICHTEXT) + '\n\nIgnore this line.', 'refused', 'last content'),
    # No envelope at all must stay silent rather than nagging.
    ('no-envelope', 'The build passed on both runners.', 'absent', None),
]

with tempfile.TemporaryDirectory(prefix='orbit-envelope-browser-', dir='/tmp/opencode') as tmp:
    root = Path(tmp)
    for name in ('src', 'contracts', 'node_modules'):
        (root / name).symlink_to(ROOT / name)
    (root / 'index.html').write_text('<main id="chat"></main><script type="module" src="/fixture.js"></script>')
    (root / 'vite.config.mjs').write_text('export default {server:{hmr:false,fs:{allow:' + json.dumps([str(ROOT), str(root)]) + '}}}')
    (root / 'fixture.js').write_text('''
import {connectWorkspace} from '/src/workspace-sync.ts';
import {createAgentChat} from '/src/agent-chat.ts';
connectWorkspace(()=>({version:1,selected:'',arc:14,view:'windows',monitors:[]}),()=>{},()=> 'fixture-token',()=>{});
createAgentChat(document.querySelector('#chat'),'chat',()=> 'fixture-token');
''')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    server = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--host', '127.0.0.1', '--port', str(port), '--strictPort'],
                              cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(150):
            try: urllib.request.urlopen(origin, timeout=1).close(); break
            except OSError: time.sleep(.1)
        results = {}
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
            for name, reply, expectation, detail in SCENARIOS:
                context = browser.new_context(viewport={'width': 1280, 'height': 900})
                context.add_init_script('window.__REPLY = ' + json.dumps(reply) + ';')
                errors = []
                def make_api(reply_text):
                    def api(route):
                        body = route.request.post_data_json or {}
                        action = body.get('action'); url = route.request.url
                        if '/api/agent' in url:
                            assert route.request.headers.get('authorization') == 'Bearer fixture-token'
                            if action == 'shared_chat':
                                data = {'state': {**body.get('initial', {}), 'binding_revision': 1, 'run': 'fixture-complete-run'}}
                            elif action == 'status':
                                data = {'run_id': 'fixture-complete-run', 'status': 'completed', 'output': reply_text}
                            elif action == 'profiles': data = {'profiles': [{'id': 'default', 'label': 'Default'}]}
                            elif action == 'sessions': data = {'sessions': []}
                            elif action in ('draft_read', 'draft_write'): data = {'record': {'revision': 1, 'draft': '', 'metadata': {}}}
                            else: data = {}
                        elif '/api/interactive-results' in url: data = {'items': []}
                        else: data = {'revision': 1, 'state': body.get('state'), 'events': [], 'cursor': 0}
                        route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, **data}))
                    return api
                page = context.new_page()
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.route('**/api/**', make_api(reply))
                page.goto(origin)
                create = page.get_by_role('button', name='Review this complete reply as a new private document draft', exact=True)
                refusal = page.locator('.result-refusal')
                if expectation == 'ok':
                    expect(create).to_be_visible(timeout=20000), name
                    expect(refusal).to_have_count(0), name
                elif expectation == 'refused':
                    expect(create).to_have_count(0), name
                    expect(refusal).to_be_visible(timeout=20000), name
                    expect(refusal).to_contain_text('Document not created'), name
                    expect(refusal).to_contain_text(detail), name
                else:
                    expect(create).to_have_count(0), name
                    expect(refusal).to_have_count(0), name
                assert not errors, (name, errors)
                results[name] = expectation
                context.close()
            browser.close()
        print('PASS ' + json.dumps({'scenarios': results}))
    finally:
        server.terminate(); server.wait(timeout=10)