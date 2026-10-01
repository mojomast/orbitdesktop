"""Private visual QA: real app/renderers, intercepted synthetic authority responses.

No owner workspace, model, terminal, or deployment is used. Source is copied into
an isolated Vite root. Screenshots default outside Git. A --baseline run captures
a representative historical source tree, not an owner-supplied screenshot.

PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
 /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/agent-pane-ux.browser.py
"""
import argparse
import json
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = '11111111-1111-4111-8111-111111111111'
PANE = '22222222-2222-4222-8222-222222222222'
MONITOR = '33333333-3333-4333-8333-333333333333'
SESSION = 'orbit-44444444-4444-4444-8444-444444444444'
SIZES = [(1326, 947), (1000, 800), (760, 700), (520, 700)]
STATES = ['idle', 'running', 'approval', 'workbench-running', 'review', 'diff', 'unknown']
NOW = 1790596800000


def state_for(width, height):
    return {'version': 1, 'selected': MONITOR, 'arc': 14, 'view': 'windows',
            'appearance': {'fullViewport': True}, 'monitors': [{
                'id': MONITOR, 'name': 'Hermes · synthetic UX fixture', 'diagonal': 32,
                'aspect': '16:9', 'height': 0, 'distance': 0, 'pitch': 0, 'yaw': 0,
                'offset': 0, 'fontSize': 14,
                'frame': {'x': 0, 'y': 0, 'width': width, 'height': height, 'z': 0},
                'layout': {'type': 'pane', 'pane': {'id': PANE, 'kind': 'agent', 'url': ''}}}]}


def install_fixture(context, origin, name, width, height, theme=None):
    layout = state_for(width, height)
    if theme:
        layout['appearance']['theme'] = theme
    wb = name in ('workbench-running', 'review', 'diff')
    chat = {'session': SESSION, 'profile_id': 'default', 'binding_revision': 1,
            'title': 'Design review', 'messages': [
                {'role': 'user', 'text': 'Help me simplify the agent pane. Keep the conversation easy to follow.'},
                {'role': 'assistant', 'text': 'I’ll keep the conversation central, move detailed activity into the inspector, and preserve explicit controls for approval and review.'}]}
    if name in ('running', 'approval'):
        chat['run'] = 'fixture-run'
    prefs = {'version': 1, 'mode': 'workbench' if wb else 'normal',
             'projectId': 'fixture-project' if wb else None,
             'taskId': 'fixture-task' if wb else None,
             'candidateId': 'fixture-candidate' if wb else None,
             'attemptId': 'fixture-attempt' if wb else None,
             'grantId': 'fixture-grant' if wb else None, 'resultId': None, 'reviewId': None}
    storage = {'orbit.workspace.id': WORKSPACE, 'orbit.workspace.v1': json.dumps(layout),
               f'orbit-pane-prefs:{WORKSPACE}:{PANE}': json.dumps(prefs),
               'orbit.experimental.v1': json.dumps({'version': 1, 'workbench': True}),
               'orbit.onboarded': 'true'}
    context.add_init_script('''(function() { const storage = %s;
      for (const [key,value] of Object.entries(storage)) localStorage.setItem(key,value);
      sessionStorage.setItem(%s, %s); Date.now = () => %s;
    })()''' % (json.dumps(storage), json.dumps(f'orbit-hermes-chat:{PANE}'), json.dumps(json.dumps(chat)), NOW))
    calls = []
    candidate = {'id': 'fixture-candidate', 'task_id': 'fixture-task', 'generation': 2,
                 'hash': 'b' * 64, 'status': 'ready', 'changed_files': 1, 'project_generation': 1}
    grant = {'id': 'fixture-grant', 'attempt_id': 'fixture-attempt',
             'candidate_id': candidate['id'], 'status': 'running' if name == 'workbench-running' else 'finalized',
             'model': 'Fixture model (no requests)', 'calls_used': 3, 'checks_used': 1,
             'repairs_used': 0, 'budget': {'calls': 8, 'checks': 3, 'repair_iterations': 1},
             'started_at': NOW - 65000, 'expires_at': NOW + 600000}
    lane = {'agent_busy': name == 'workbench-running', 'job_busy': False, 'unknown': name == 'unknown'}
    result = {'id': 'fixture-result', 'availability': 'available', 'candidate_id': candidate['id'],
              'candidate_hash': candidate['hash'], 'candidate_generation': 2, 'grant_id': grant['id'],
              'text': 'The candidate is ready for your review. No owner files were changed.',
              'task_id': 'fixture-task', 'attempt_id': 'fixture-attempt', 'hermes_completed': True,
              'project_generation': 1, 'received_at': NOW, 'retained_until': NOW + 86400000,
              'termination': 'completed', 'review_status': 'unreviewed'} if name == 'review' else None
    execution = {'tasks': [{'id': 'fixture-task', 'title': 'Simplify the agent pane', 'status': 'active'}],
                 'candidates': [candidate], 'definitions': [], 'jobs': [], 'reviews': [], 'evidence': [],
                 'target_changed': {}, 'review_identity': {}}
    requests_unknown = []

    def route_api(route):
        path = route.request.url.split(origin)[-1].split('?')[0]
        try:
            body = route.request.post_data_json or {}
        except Exception:
            body = {}
        action = body.get('action', '')
        calls.append((path, action))
        data = {'ok': True}
        if path == '/api/workspace':
            data.update(state=layout, revision=1)
        elif path == '/api/agent':
            if action == 'shared_chat': data.update(state=chat, execution_lane=lane)
            elif action == 'profiles': data.update(profiles=[{'id': 'default', 'label': 'Default', 'configured': True}])
            elif action == 'sessions': data.update(supported=True, sessions=[{'id': SESSION, 'title': 'Design review'}])
            elif action == 'status': data.update(status='waiting_for_approval' if name == 'approval' else 'running',
                approvals=[{'command': 'npm run check', 'reason': 'Run the recorded checks in the private candidate.'}] if name == 'approval' else [])
            elif action == 'capabilities': data.update(features={})
            elif action == 'activity': data.update(activity=[{'kind': 'call', 'name': 'read_file', 'id': 'fixture-call', 'detail': 'SYNTHETIC_TOOL_ARGUMENT'}])
            elif action == 'events':
                if name == 'running':
                    events = [{'event': 'tool.started', 'tool': 'read_file', 'tool_call_id': 'fixture-live-call', 'arguments': {'path': 'synthetic.txt'}},
                              {'event': 'tool.completed', 'tool': 'read_file', 'tool_call_id': 'fixture-live-call', 'output': 'SYNTHETIC_LIVE_RESULT', 'duration': .2}]
                    route.fulfill(content_type='text/event-stream', body=''.join('data: ' + json.dumps(event) + '\n\n' for event in events)); return
                data.update(events=[])
            else: requests_unknown.append((path, action))
        elif path == '/api/workbench': data.update(projects=[{'id': 'fixture-project', 'name': 'Orbit UX', 'active': True}])
        elif path == '/api/workbench/context': data.update(attempts=[{'id': 'fixture-attempt', 'task_id': 'fixture-task'}], contexts=[], packets=[])
        elif path == '/api/workbench/execution':
            if action == 'candidate_get': data.update(candidate=candidate)
            else: data.update(execution)
        elif path == '/api/workbench/native':
            data.update(grants=[grant] if wb else [], cards=[], grant=grant, result=result)
        elif path == '/api/workbench/live':
            if action == 'stream':
                route.fulfill(status=503, json={'ok': False, 'code': 'fixture_page_transport'}); return
            if action == 'detail':
                data = {'ok': True, 'mode': 'candidate_generation_diff', 'available': True, 'comparison': 'previous',
                    'from': {'candidate_id': candidate['id'], 'generation': 1, 'candidate_hash': 'a'*64},
                    'to': {'candidate_id': candidate['id'], 'generation': 2, 'candidate_hash': 'b'*64},
                    'changed_files': 1, 'truncated': False, 'files': [{'path': 'src/example.ts', 'old_hash': 'a'*64,
                    'new_hash': 'b'*64, 'old_mode': '100644', 'new_mode': '100644', 'text_available': True,
                    'old_text': "export const title = 'Agent';\n", 'new_text': "export const title = 'Hermes';\n"}]}
            else:
                events = [] if body.get('after_sequence', 0) else [{
                    'version': 1, 'id': 'fixture-live-event', 'sequence': 1, 'at': NOW - 12000,
                    'authority': 'observed', 'category': 'agent', 'kind': 'grant',
                    'summary': 'Inspecting the private candidate' if name == 'workbench-running' else 'Candidate available for human review',
                    'status': 'running' if name == 'workbench-running' else 'completed',
                }]
                data.update(version=1, events=events, after_sequence=max(1, body.get('after_sequence', 0)), reset_required=False,
                    has_more=False, project_generation=1, lane=lane,
                    snapshot={'scope': 'attempt', 'candidate': candidate, 'grant': grant, 'result': result,
                              'active_grants': int(name == 'workbench-running'), 'active_jobs': 0, 'results': int(bool(result))})
        elif path.endswith('/events'): data.update(events=[], after_sequence=0, cursor=0, has_more=False)
        route.fulfill(json=data)

    context.route('**/api/**', route_api)
    return calls, requests_unknown


def audit_idle(page, inspector_screenshot):
    pane = page.locator(f'.pane[data-pane-id="{PANE}"]')
    expect(pane.get_by_role('button', name='Normal Hermes mode', exact=True)).to_be_visible()
    expect(pane.get_by_role('button', name='Workbench Hermes mode', exact=True)).to_be_visible()
    metrics = pane.evaluate('''root => {
      const h = s => root.querySelector(s).getBoundingClientRect().height;
      const composer = root.querySelector('.chat-form').getBoundingClientRect();
      return {header:h('.pane-head'), composer:h('.chat-form'), conversation:h('.chat-messages'), body:h('.chat-body'),
        composerBottom:composer.bottom, composerTop:composer.top, viewportHeight:innerHeight};
    }''')
    assert metrics['header'] <= 52, metrics
    assert 64 <= metrics['composer'] <= 96, metrics
    assert metrics['conversation'] > metrics['body'] / 2, metrics
    assert 0 <= metrics['composerTop'] < metrics['composerBottom'] <= metrics['viewportHeight'], metrics
    expect(pane.get_by_role('button', name='Start a separate Hermes conversation', exact=True)).to_be_visible()
    expect(pane.get_by_role('button', name='Open recent Hermes conversations', exact=True)).to_be_visible()
    if page.locator('html').get_attribute('data-docking-renderer') == 'docking':
        toggle = page.get_by_label('Docking layout controls', exact=True)
        expect(page.locator('.topbar .docking-controls')).to_have_count(1)
        expect(page.locator('.docking-root .docking-toolbar')).to_have_count(0)
        toggle.click()
        toolbar = page.get_by_role('toolbar', name='Docking layout', exact=True)
        expect(toolbar).to_be_visible()
        toolbar.get_by_label('Docking window', exact=True).focus()
        page.keyboard.press('Escape')
        expect(toolbar).to_be_hidden()
        expect(toggle).to_be_focused()
    inspector = page.locator(f'.agent-inspector[data-pane-id="{PANE}"]')
    for selector in ('.agent-binding-controls', '.alt-toolbar', '.agent-submission-recovery'):
        for node in inspector.locator(selector).all(): expect(node).to_be_hidden()
    expect(pane.locator('.alt-toolbar')).to_have_count(0)
    assert SESSION not in pane.inner_text(), 'Raw binding exposed at idle'
    message = pane.get_by_label('Message to Hermes', exact=True)
    message.fill('A private fixture draft survives settings and mode changes.')
    tools = pane.get_by_role('button', name='Toggle tool activity in chat', exact=True)
    expect(tools).to_be_visible()
    expect(tools).to_have_text('Show tools')
    tools.click()
    expect(tools).to_have_attribute('aria-expanded', 'true')
    tool_view = pane.get_by_role('region', name='Inline tool activity', exact=True)
    expect(tool_view).to_be_visible()
    tool_view.get_by_role('button', name='Load persisted tool arguments and results for this conversation').click()
    expect(tool_view.locator('.inline-tools-saved')).to_contain_text('Arguments · read_file')
    tool_view.get_by_text('Arguments · read_file', exact=True).click()
    expect(tool_view.get_by_text('SYNTHETIC_TOOL_ARGUMENT', exact=True)).to_be_visible()
    page.evaluate("window.__qaToolNode = document.querySelector('.inline-tools')")
    pane.get_by_role('button', name='Workbench Hermes mode', exact=True).click()
    expect(tool_view).to_be_hidden()
    pane.get_by_role('button', name='Normal Hermes mode', exact=True).click()
    expect(tool_view).to_be_visible()
    assert page.evaluate("window.__qaToolNode === document.querySelector('.inline-tools')"), 'Tool DOM replaced on mode switch'
    expect(message).to_have_value('A private fixture draft survives settings and mode changes.')
    assert page.evaluate("localStorage.getItem('orbit-inline-tools:' + %s)" % json.dumps(PANE)) == 'on'
    assert page.evaluate("JSON.stringify(localStorage).includes('SYNTHETIC_TOOL_ARGUMENT')") is False
    tools.click()
    expect(tool_view).to_be_hidden()
    settings = pane.get_by_role('button', name='Agent pane menu', exact=True)
    settings.click()
    page.get_by_role('menuitem', name='Conversation settings', exact=True).click()
    dialog = page.locator(f'.agent-inspector[data-pane-id="{PANE}"]')
    expect(dialog).to_be_visible()
    assert dialog.evaluate("node => node.matches(':modal')"), 'Inspector must use native modal focus containment'
    theme_metrics = dialog.evaluate('''node => {
      const l = color => { const v = color.match(/[\\d.]+/g).slice(0,3).map(n => {const s = Number(n)/255; return s <= .04045 ? s/12.92 : ((s+.055)/1.055)**2.4;}); return .2126*v[0]+.7152*v[1]+.0722*v[2]; };
      const style = getComputedStyle(node), bg = l(style.backgroundColor), fg = l(style.color);
      const note = l(getComputedStyle(node.querySelector('.agent-notice')).color);
      const contrast = a => (Math.max(bg,a)+.05)/(Math.min(bg,a)+.05);
      return {theme:document.documentElement.dataset.orbitTheme || 'owner-css', scheme:style.colorScheme,
              background:style.backgroundColor, text:style.color, contrast:contrast(fg), noteContrast:contrast(note)};
    }''')
    assert theme_metrics['contrast'] >= 4.5, theme_metrics
    assert theme_metrics['noteContrast'] >= 4.5, theme_metrics
    if theme_metrics['theme'] in ('paper', 'xp', 'classic'):
        assert theme_metrics['scheme'] == 'light', theme_metrics
    metrics['inspector'] = theme_metrics
    assert dialog.evaluate('''node => [...node.querySelectorAll('[role=tab]')].every(tab => {
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      return panel?.getAttribute('role') === 'tabpanel' && panel.getAttribute('aria-labelledby') === tab.id;
    })'''), 'Tabs must label their persistent panels'
    title = dialog.get_by_label('Conversation title', exact=True)
    expect(title).to_have_value('Design review')
    title.fill('Fixture settings updated')
    page.screenshot(path=str(inspector_screenshot))
    title.fill('Design review')
    page.evaluate('''() => {
      window.__qaInspectorNodes = [...document.querySelectorAll('.agent-inspector-panel')].map(panel => panel.firstElementChild);
    }''')
    selected = dialog.get_by_role('tab', selected=True)
    selected.press('End')
    expect(dialog.get_by_role('tab').last).to_be_focused()
    selected = dialog.get_by_role('tab', selected=True)
    selected.press('Home')
    expect(dialog.get_by_role('tab').first).to_be_focused()
    page.keyboard.press('Escape')
    expect(dialog).to_be_hidden()
    expect(settings).to_be_focused()
    settings.click()
    page.get_by_role('menuitem', name='Activity', exact=True).click()
    assert page.evaluate('''() => [...document.querySelectorAll('.agent-inspector-panel')].every((panel, i) => panel.firstElementChild === window.__qaInspectorNodes[i])'''), 'Inspector moved/rebuilt registered content'
    page.keyboard.press('Escape')
    pane.get_by_role('button', name='Workbench Hermes mode', exact=True).click()
    pane.get_by_role('button', name='Normal Hermes mode', exact=True).click()
    expect(message).to_have_value('A private fixture draft survives settings and mode changes.')
    message.fill('')
    # The preference survives a real page reload; tool payloads remain memory-only.
    tools.click()
    page.reload(wait_until='networkidle')
    page.keyboard.press('Escape')
    page.evaluate('window.__qaUnlock()')
    expect(pane.get_by_role('button', name='Toggle tool activity in chat')).to_have_text('Hide tools')
    expect(pane.get_by_role('region', name='Inline tool activity')).to_be_visible()
    expect(pane.locator('.inline-tools-saved')).not_to_contain_text('SYNTHETIC_TOOL_ARGUMENT')
    return metrics


def main(args):
    out = Path(args.output); out.mkdir(parents=True, exist_ok=True)
    report = {'kind': 'representative baseline' if args.baseline else 'synthetic authoritative UI fixture',
              'source': str(args.source), 'cases': [], 'limitations': ['Network authority is mocked; no model or execution is exercised.', 'Private activity uses page fallback transport.']}
    with tempfile.TemporaryDirectory(prefix='orbit-agent-ux-', dir='/tmp/opencode') as temp:
        root = Path(temp)
        for folder in ('src', 'contracts', 'server', 'scripts', 'docs'):
            shutil.copytree(args.source / folder, root / folder)
        for file in ('index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.js'):
            shutil.copy2(args.source / file, root / file)
        (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        # A production bundle avoids Vite dependency-discovery reloads resetting
        # the in-memory host session midway through Workbench fixture loading.
        # This bridge exposes only the existing setToken function in this copy.
        (root / 'src/qa-entry.js').write_text("import './main.ts'; import { setToken } from './panes.ts'; window.__qaUnlock = () => setToken('synthetic-fixture-token');\n")
        index = root / 'index.html'
        index.write_text(index.read_text().replace('/src/main.ts', '/src/qa-entry.js'))
        subprocess.run(['node', str(ROOT / 'node_modules/vite/bin/vite.js'), 'build'], cwd=root,
                       check=True, text=True, capture_output=True)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        origin = f'http://127.0.0.1:{port}'
        with (root / 'vite.log').open('w') as log:
            server = subprocess.Popen(['node', str(ROOT / 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', str(port)], cwd=root, stdout=log, stderr=log)
            try:
                for _ in range(100):
                    try:
                        urllib.request.urlopen(origin, timeout=1).close(); break
                    except OSError: time.sleep(.1)
                with sync_playwright() as p:
                    browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
                    for renderer in args.renderers.split(','):
                        for width, height in SIZES:
                            for name in args.states.split(','):
                                context = browser.new_context(viewport={'width': width, 'height': height}, reduced_motion='reduce')
                                calls, unknown = install_fixture(context, origin, name, width, height, args.theme)
                                page = context.new_page(); errors = []
                                page.on('pageerror', lambda e: errors.append(str(e)))
                                page.goto(origin + ('/?renderer=docking' if renderer == 'docking' else '/'), wait_until='networkidle')
                                if args.theme:
                                    expect(page.locator('html')).to_have_attribute('data-orbit-theme', args.theme)
                                page.keyboard.press('Escape')
                                if renderer == 'docking':
                                    page.wait_for_function("document.documentElement.dataset.dockingRenderer === 'docking'")
                                page.evaluate("() => window.__qaUnlock()")
                                pane = page.locator(f'.pane[data-pane-id="{PANE}"]')
                                expect(pane).to_be_visible()
                                page.wait_for_timeout(1300)
                                if name in ('workbench-running', 'review', 'diff'):
                                    try:
                                        expect(pane.locator('.pane-workbench-scope-line')).to_contain_text('Orbit UX', timeout=15000)
                                    except AssertionError:
                                        print('FIXTURE DIAGNOSTIC', json.dumps({'calls': calls, 'errors': errors, 'pane': pane.text_content()}), flush=True)
                                        raise
                                    expect(pane.locator('.pane-workbench-scope-line')).to_contain_text('Simplify the agent pane')
                                if name == 'workbench-running':
                                    expect(pane.get_by_role('button', name='Workbench Hermes mode', exact=True)).to_contain_text('Running')
                                if name == 'diff':
                                    pane.get_by_role('tab', name='Changes workbench view', exact=True).click()
                                    if not args.baseline: expect(pane.locator('.candidate-diff-viewer')).to_be_visible()
                                if name == 'workbench-running':
                                    pane.get_by_role('tab', name='Live workbench view', exact=True).click()
                                if name == 'review':
                                    pane.get_by_role('tab', name='Result workbench view', exact=True).click()
                                label = f'{"before" if args.baseline else "after"}-{renderer}-{name}-{width}x{height}'
                                page.screenshot(path=str(out / f'{label}.png'))
                                metrics = None
                                if not args.baseline:
                                    if name == 'idle': metrics = audit_idle(page, out / f'{label}-inspector.png')
                                    elif name == 'running':
                                        tools = pane.get_by_role('button', name='Toggle tool activity in chat', exact=True)
                                        tools.click()
                                        view = pane.get_by_role('region', name='Inline tool activity')
                                        expect(view.locator('.inline-tool')).to_have_count(1)
                                        expect(view.locator('.inline-tools-totals')).to_contain_text('1 completed')
                                        view.locator('.inline-tool > summary').click()
                                        view.get_by_text('tool.completed', exact=True).click()
                                        expect(view.get_by_text('SYNTHETIC_LIVE_RESULT', exact=True)).to_be_visible()
                                        page.screenshot(path=str(out / f'{label}-tools.png'))
                                        tools.click(); expect(view).to_be_hidden()
                                        tools.click(); expect(view.get_by_text('SYNTHETIC_LIVE_RESULT', exact=True)).to_be_visible()
                                    elif name == 'approval': expect(pane.get_by_role('button', name='Allow once for the pending tool action', exact=True)).to_be_visible()
                                    elif name == 'unknown':
                                        message = pane.get_by_label('Message to Hermes', exact=True)
                                        message.fill('Do not dispatch this unknown-lane fixture draft.')
                                        expect(pane.locator('.chat-send')).to_be_disabled()
                                        expect(pane.get_by_role('button', name='Open submission receipt and recovery', exact=True)).to_be_visible()
                                        message.fill('')
                                assert not errors, errors
                                forbidden = [c for c in calls if c[1] in ('start', 'submit', 'approve', 'run', 'dispatch', 'task_create')]
                                assert not forbidden, forbidden
                                case = {'renderer': renderer, 'state': name, 'theme': args.theme or 'owner-css baseline', 'viewport': [width, height], 'screenshot': str(out / f'{label}.png'), 'metrics': metrics, 'unhandled_agent_reads': unknown}
                                report['cases'].append(case)
                                (out / ('baseline-report.json' if args.baseline else 'report.json')).write_text(json.dumps(report, indent=2))
                                print('PASS', label, metrics or '', flush=True)
                                context.close()
                    browser.close()
            finally:
                server.terminate(); server.wait(timeout=10)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, default=ROOT)
    parser.add_argument('--output', default='/tmp/opencode/orbit-agent-ux-qa')
    parser.add_argument('--baseline', action='store_true')
    parser.add_argument('--renderers', default='default,docking')
    parser.add_argument('--states', default=','.join(STATES))
    parser.add_argument('--theme', choices=['midnight', 'paper', 'xp', 'classic'])
    main(parser.parse_args())
