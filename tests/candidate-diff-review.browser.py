"""Private-server candidate identity and shared-viewer journey in either renderer.

Disposable project, SQLite, build, server and browser. No model, owner runtime or
request interception. The real host-regression recorder supplies review evidence.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
import uuid

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
def math(operator, note='baseline'):
    lines = [f'// fixture line {i:03d}' for i in range(1, 96)]
    lines[5] = f'// distant review note: {note}'
    return '\n'.join(lines) + f'\nexport const sum = (a,b) => a {operator} b;\n'


WRONG = math('-')
RIGHT = math('+', 'repaired')
THIRD = math('+', 'later independent edit').replace('a + b;', 'Number(a) + Number(b);')
README = '# Candidate comparison\n'
README_EDIT = '# Candidate comparison\n\nThree-file cumulative review.\n'
CONFIG = '{"mode":"fixture"}\n'
CONFIG_EDIT = '{"mode":"reviewed"}\n'


def run(*args, cwd, env):
    result = subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True)
    if result.returncode: raise RuntimeError(f'Isolated command failed: {args[0]} {args[1]}\n{result.stdout}\n{result.stderr}')
    return result


def journey(renderer, page, origin, token, project):
    requests = []
    def record(request):
        if '/api/workbench/' in request.url and request.method == 'POST':
            try: requests.append((request.url.rsplit('/', 1)[-1], request.post_data_json.get('action')))
            except (ValueError, AttributeError): pass
    page.on('request', record)
    page.goto(origin + ('?renderer=docking' if renderer == 'docking' else ''), wait_until='domcontentloaded')
    if page.locator('dialog.orbit-onboarding').is_visible():
        page.keyboard.press('Escape')
    page.get_by_role('button', name='Connect local host', exact=True).click()
    page.get_by_role('textbox', name='Host session token').fill(token)
    page.get_by_role('button', name='Unlock local host', exact=True).click()
    expect(page.locator('.saved')).to_contain_text('Workspace connected', timeout=15000)
    page.get_by_role('button', name='Open orbit menu').click()
    page.get_by_role('button', name='Project Workbench', exact=True).click()
    dialog = page.locator('dialog.project-workbench-dialog')
    dialog.get_by_label('Project root directory').fill(str(project))
    dialog.get_by_label('Project name').fill('candidate-diff-fixture')
    dialog.get_by_role('button', name='Preview project registration').click()
    dialog.get_by_role('button', name='Confirm project registration').click()
    expect(dialog.get_by_role('button', name='Open project candidate-diff-fixture')).to_be_visible()
    # Owner-authenticated real API calls. Browser is only a client of the same
    # backend as Workbench; none of the source or expected hashes are invented.
    def api(endpoint, body):
        response = page.evaluate('''async ({endpoint,body,token}) => {
          const response=await fetch('/api/workbench'+(endpoint?'/'+endpoint:''),{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
          return {status:response.status,data:await response.json()};
        }''', {'endpoint': endpoint, 'body': body, 'token': token})
        assert response['status'] == 200 and response['data'].get('ok') is True, (endpoint, body['action'], response)
        return response['data']

    workspace = page.evaluate("localStorage.getItem('orbit.workspace.id')")
    projects = api('', {'action': 'list', 'workspace_id': workspace})['projects']
    project_id = next(entry['id'] for entry in projects if entry['name'] == 'candidate-diff-fixture')
    scope = {'workspace_id': workspace, 'project_id': project_id}
    execution = lambda action, **fields: api('execution', {**scope, 'action': action, **fields})
    task = execution('task_create', title='Three-file candidate comparison', acceptance_statement='sum(2,3) is 5', check_definition_id='host-regression', profile_id='default', session_id='fixture')['task']
    preview = execution('candidate_preview', task_id=task['id'])
    candidate = execution('candidate_create', task_id=task['id'], preview_id=preview['preview_id'], preview_digest=preview['preview']['digest'])['candidate']
    identity = lambda row: {'kind': 'candidate', 'id': row['id'], 'generation': row['generation'], 'hash': row['hash']}
    gen1 = dict(candidate)
    read = execution('candidate_read', candidate_id=candidate['id'], path='math.js')['file']
    candidate = execution('candidate_edit', candidate_id=candidate['id'], path='math.js', expected_hash=read['hash'], content=RIGHT)['candidate']
    gen2 = dict(candidate)
    detail = lambda reference, comparison='previous': api('live', {**scope, 'action': 'detail', 'reference': reference, 'comparison': comparison})
    first = detail(identity(gen2))
    assert first['available'] and first['from']['generation'] == 1 and first['to']['generation'] == 2
    assert [file['path'] for file in first['files']] == ['math.js']
    assert first['files'][0]['old_text'] == WRONG and first['files'][0]['new_text'] == RIGHT
    # Owner candidate_edit is single-file/single-generation. Three changed files
    # are therefore an honest cumulative 1→4 comparison, not an invented 1→2.
    for path, content in [('README.md', README_EDIT), ('config.json', CONFIG_EDIT)]:
        original = execution('candidate_read', candidate_id=candidate['id'], path=path)['file']
        candidate = execution('candidate_edit', candidate_id=candidate['id'], path=path, expected_hash=original['hash'], content=content)['candidate']
    gen4 = dict(candidate)
    cumulative = detail(identity(gen4), 'initial')
    assert cumulative['from']['generation'] == 1 and cumulative['to']['generation'] == 4
    assert [(file['path'], file['old_text'], file['new_text']) for file in cumulative['files']] == [
        ('README.md', README, README_EDIT), ('config.json', CONFIG, CONFIG_EDIT), ('math.js', WRONG, RIGHT)]
    dialog.evaluate('node => node.close()')
    page.locator('.agent-mode-button').filter(has_text='Workbench').click()
    workbench = page.locator('.pane-workbench')
    expect(workbench).to_be_visible()
    workbench.locator('.pane-workbench-settings > summary').click()
    workbench.get_by_label('Workbench project').select_option(project_id)
    expect(workbench.get_by_label('Workbench task', exact=True).locator(f'option[value="{task["id"]}"]')).to_have_count(1)
    workbench.get_by_label('Workbench task', exact=True).select_option(task['id'])
    workbench.locator('.pane-workbench-identities > summary').click()
    expect(workbench.get_by_label('Workbench candidate').locator(f'option[value="{candidate["id"]}"]')).to_have_count(1)
    workbench.get_by_label('Workbench candidate').select_option(candidate['id'])
    expect(workbench.locator('.pane-workbench-candidate-line')).to_contain_text('Candidate 4')
    workbench.get_by_role('tab', name='Changes').click()
    expect(workbench.locator('.pane-workbench-changes-diff .candidate-diff-viewer')).to_be_visible()
    changes = workbench.locator('.pane-workbench-changes-diff .candidate-diff-viewer')
    expect(changes).to_contain_text('Initial candidate generation 1 → generation 4')
    expect(changes.locator('.cdv-file')).to_have_count(3)
    expect(changes.locator('.cdv-header .cdv-muted')).to_contain_text('3 / 3 files')
    changes.get_by_role('button', name='M math.js').click()
    expect(changes.locator('.cdv-table')).to_be_visible()
    expect(changes.locator('.cdv-hunk')).to_have_count(2)
    expect(changes.locator('.cdv-fold')).not_to_have_count(0)
    expect(changes.locator('.cdv-word')).not_to_have_count(0)
    changes.get_by_role('button', name='Next hunk').click()
    expect(changes.locator('.cdv-target')).not_to_have_count(0)
    before_reads = len([item for item in requests if item == ('live', 'detail')])
    changes.get_by_label('Diff layout').select_option('unified')
    expect(changes.locator('.cdv-unified')).to_be_visible()
    changes.get_by_label('Context lines').select_option('-1')
    changes.get_by_role('button', name='Raw unified', exact=True).click()
    expect(changes.locator('.cdv-raw')).to_contain_text('export const sum')
    changes.get_by_role('button', name='Raw unified', exact=True).click()
    changes.get_by_label('Search supplied file paths and source').fill('distant review note')
    expect(changes.locator('.cdv-search')).to_contain_text('matching paths / side-lines')
    changes.get_by_role('button', name='Previous file').click()
    expect(changes.locator('.cdv-file-title')).to_have_text('config.json')
    assert len([item for item in requests if item == ('live', 'detail')]) == before_reads, 'Presentation navigation fetched source again'
    workbench.get_by_label('Candidate comparison').select_option('previous')
    expect(workbench.locator('.pane-workbench-changes-diff')).to_contain_text('Latest transition → generation 4')
    workbench.get_by_label('Candidate comparison').select_option('initial')
    workbench.get_by_role('tab', name='Live').click()
    event_row = workbench.locator('.pane-workbench-live-timeline .alt-row').filter(has_text='Candidate generation 2').first
    expect(event_row).to_be_visible()
    event_row.locator('summary').click()
    event_row.get_by_role('button', name='View diff').click()
    live_dialog = page.locator('dialog.pane-workbench-detail')
    expect(live_dialog.locator('.candidate-diff-viewer')).to_be_visible()
    expect(live_dialog.locator('.cdv-identity-strip')).to_contain_text('From g1')
    expect(live_dialog.locator('.cdv-identity-strip')).to_contain_text('To g2')
    expect(live_dialog.locator('.cdv-viewport')).to_contain_text('a + b')
    live_dialog.get_by_role('button', name='Close focused detail').click()
    workbench.get_by_role('tab', name='Changes').click()
    # A real retained review: host-owned check, evidence and owner decision.
    check = execution('check_preview', candidate_id=candidate['id'], definition_id='host-regression')
    result = execution('check_run', candidate_id=candidate['id'], preview_id=check['preview_id'], preview_digest=check['preview']['spec_digest'], op_id=str(uuid.uuid4()))
    evidence = result['evidence']
    assert evidence['verdict'] == 'pass'
    state = execution('execution_state')
    review = execution('review_decide', candidate_id=candidate['id'], evidence_ids=[evidence['id']], decision='approved', expected_identity=state['review_identity'][candidate['id']])['review']
    workbench.get_by_role('button', name='Create or select one trusted project-bound Review pane').click()
    expect(page.locator('.workbench-review-status')).to_contain_text('Review ready')
    expect(page.locator('.workbench-review-diff .candidate-diff-viewer')).to_be_visible()
    expect(page.locator('.workbench-review-diff .cdv-identity-strip')).to_contain_text('To g4')
    expect(page.locator('.workbench-review-diff .cdv-file')).to_have_count(3)
    expect(page.locator('.workbench-review-recorder-counts')).to_contain_text('Service-recorded')
    viewer = page.locator('.workbench-review-diff .candidate-diff-viewer')
    viewer.get_by_role('button', name='Review controls and files', exact=True).click()
    viewer.get_by_label('Diff layout').select_option('unified')
    viewer.get_by_label('Search supplied file paths and source').fill('math.js')
    expect(viewer).to_contain_text('math.js')
    stored = page.evaluate("Object.entries(localStorage).map(([key,value])=>key+'='+value)")
    assert not any(text in item for item in stored for text in (WRONG.strip(), RIGHT.strip(), token)), 'Private source/token persisted in localStorage'
    # Edit after approval: old event stays exactly 1→2, current overall is
    # 1→5 and current transition is 4→5. Reload must not replay execution.
    read = execution('candidate_read', candidate_id=candidate['id'], path='math.js')['file']
    gen5 = execution('candidate_edit', candidate_id=candidate['id'], path='math.js', expected_hash=read['hash'], content=THIRD)['candidate']
    old = detail(identity(gen2))
    latest = detail(identity(gen5))
    overall = detail(identity(gen5), 'initial')
    assert old['from']['generation'] == 1 and old['to']['generation'] == 2 and old['files'][0]['new_text'] == RIGHT
    assert latest['from']['generation'] == 4 and latest['to']['generation'] == 5 and latest['files'][0]['new_text'] == THIRD
    assert overall['from']['generation'] == 1 and overall['to']['generation'] == 5 and len(overall['files']) == 3
    events = api('live', {**scope, 'action': 'page', 'after_sequence': 0, 'limit': 200})['events']
    retained = [item['reference'] for item in events if item.get('reference', {}).get('kind') == 'candidate' and item['reference'].get('generation') == 2 and item['reference'].get('hash') == gen2['hash']]
    assert retained and detail(retained[0])['files'][0]['new_text'] == RIGHT, 'Historical activity reference was retargeted'
    page.get_by_role('button', name='Revalidate candidate, frozen checks, review, and worker explanation').click()
    expect(page.locator('.workbench-review-historical')).to_contain_text('Historical approved review')
    expect(page.locator('.workbench-review-historical')).to_contain_text(review['candidate_hash'])
    historical_viewer = page.locator('.workbench-review-historical .candidate-diff-viewer')
    expect(historical_viewer).to_be_visible()
    expect(historical_viewer.locator('.cdv-identity-strip')).to_contain_text('To g4')
    historical_viewer.get_by_role('button', name='Review controls and files', exact=True).click()
    historical_viewer.get_by_role('button', name='M math.js').click()
    expect(historical_viewer.locator('.cdv-viewport')).to_contain_text('a + b')
    assert 'Number(a)' not in historical_viewer.locator('.cdv-viewport').inner_text()
    mutation_count = len([action for route, action in requests if route in ('native', 'execution') and action in ('candidate_edit', 'candidate_patch', 'check_run', 'check_start', 'review_decide')])
    page.reload(wait_until='domcontentloaded')
    assert detail(identity(gen2))['files'][0]['new_text'] == RIGHT
    assert execution('execution_state')['candidates'][0]['generation'] == 5
    assert len([action for route, action in requests if route in ('native', 'execution') and action in ('candidate_edit', 'candidate_patch', 'check_run', 'check_start', 'review_decide')]) == mutation_count
    assert not any(text in item for item in page.evaluate("Object.entries(localStorage).map(([key,value])=>key+'='+value)") for text in (WRONG.strip(), RIGHT.strip(), THIRD.strip(), token))

    # Revoke through the real owner route after the historical-read checks.
    # Refreshing the selected pane must drop the old bound controls and exact
    # comparison, not keep a stale candidate or authority for a revoked root.
    page.get_by_role('button', name='Connect local host', exact=True).click()
    page.get_by_role('textbox', name='Host session token').fill(token)
    page.get_by_role('button', name='Unlock local host', exact=True).click()
    expect(page.locator('.saved')).to_contain_text('Workspace connected', timeout=15000)
    workbench = page.locator('.pane-workbench')
    expect(workbench).to_be_visible(timeout=15000)
    settings = workbench.locator('.pane-workbench-settings')
    if settings.get_attribute('open') is None:
        settings.locator(':scope > summary').click()
    expect(workbench.get_by_label('Workbench project')).to_have_value(project_id)
    expect(workbench.get_by_label('Workbench task', exact=True)).to_have_value(task['id'])
    workbench.get_by_role('tab', name='Changes').click()
    current = next(entry for entry in api('', {'action': 'list', 'workspace_id': workspace})['projects'] if entry['id'] == project_id)
    revoked = api('', {**scope, 'action': 'revoke_project', 'base_generation': current['generation']})['project']
    assert revoked['active'] is False
    settings.get_by_role('button', name='Re-read projects, tasks and state without executing anything').click()
    expect(workbench.get_by_label('Workbench project')).to_have_value('', timeout=15000)
    expect(workbench.locator('.pane-workbench-scope-line')).to_contain_text('Choose project')
    expect(workbench.locator('.pane-workbench-changes-diff .candidate-diff-viewer')).to_have_count(0)
    expect(workbench.locator('.pane-workbench-authority-body')).to_be_empty()


def main(renderer):
    with open('/tmp/opencode/comet-next-heavy-check.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with tempfile.TemporaryDirectory(prefix='orbit-candidate-diff-', dir='/tmp/opencode') as directory:
            root = Path(directory)
            for name in ('server', 'src', 'contracts', 'docs', 'public', 'scripts'):
                shutil.copytree(ROOT / name, root / name)
            for name in ('index.html', 'package.json', 'tsconfig.json', 'vite.config.js'):
                shutil.copy2(ROOT / name, root / name)
            (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
            for name in ('runtime', 'home', 'cwd', 'tmux'): (root / name).mkdir()
            env = {'HOME': str(root / 'home'), 'PATH': os.environ['PATH'], 'npm_config_cache': str(root / '.npm')}
            # The CI typecheck is a separate gate; this journey builds the exact
            # disposable source and tests browser/server behavior in isolation.
            run(shutil.which('node'), str(ROOT / 'scripts/isolated_build.mjs'), '--source', str(root), '--dest', str(root / 'dist'), '--allow-source-dist', cwd=root, env=env)
            project = root / 'project'; project.mkdir()
            for name, text in {'math.js': WRONG, 'README.md': README, 'config.json': CONFIG}.items(): (project / name).write_text(text)
            git_env = {'PATH': os.environ['PATH'], 'HOME': str(root / 'home'), 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
            run('git', 'init', cwd=project, env=git_env)
            run('git', 'add', '.', cwd=project, env=git_env)
            run('git', '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', 'commit', '-m', 'fixture', cwd=project, env=git_env)
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
            token = secrets.token_urlsafe(36)
            server_env = {**env, 'PORT': str(port), 'ORBIT_TOKEN': token, 'ORBIT_RUNTIME_DIR': str(root / 'runtime'), 'ORBIT_TMUX_SOCKET': 'candidate-' + str(uuid.uuid4()), 'ORBIT_TMUX_CONFIG': '/dev/null', 'TMUX_TMPDIR': str(root / 'tmux'), 'ORBIT_CWD': str(root / 'cwd')}
            with (root / 'server.log').open('w+') as log:
                server = subprocess.Popen([shutil.which('node'), '--experimental-strip-types', 'server/index.mjs'], cwd=root, env=server_env, stdout=log, stderr=log)
                try:
                    origin = f'http://127.0.0.1:{port}'
                    for _ in range(200):
                        if server.poll() is not None: log.seek(0); raise RuntimeError(log.read().replace(token, '[REDACTED]'))
                        try: urllib.request.urlopen(origin + '/api/health', timeout=1).close(); break
                        except OSError: time.sleep(.05)
                    else: raise RuntimeError('server readiness timeout')
                    with sync_playwright() as playwright:
                        browser = playwright.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
                        try:
                            for selected in (('default', 'docking') if renderer == 'both' else (renderer,)):
                                context = browser.new_context(viewport={'width': 1650, 'height': 1100})
                                workspace = str(uuid.uuid4()); pane = str(uuid.uuid4()); monitor = str(uuid.uuid4())
                                state = {'version': 1, 'selected': monitor, 'arc': 14, 'view': 'windows', 'monitors': [{'id': monitor, 'name': 'Workbench fixture', 'diagonal': 32, 'aspect': '16:9', 'height': 0, 'distance': 0, 'pitch': 0, 'yaw': 0, 'offset': 0, 'fontSize': 19, 'frame': {'x': 0, 'y': 0, 'width': 1050, 'height': 900, 'z': 0}, 'layout': {'type': 'pane', 'pane': {'id': pane, 'kind': 'agent', 'url': ''}}}]}
                                context.add_init_script("if(window===window.top&&!localStorage.getItem('orbit.workspace.id')){localStorage.setItem('orbit.workspace.id'," + json.dumps(workspace) + ");localStorage.setItem('orbit.experimental.v1','{\"version\":1,\"workbench\":true}');localStorage.setItem('orbit.workspace.v1',JSON.stringify(" + json.dumps(state) + '));}')
                                page = context.new_page()
                                try:
                                    journey(selected, page, origin, token, project)
                                    print(f'PASS candidate diff renderer={selected} three-file cumulative comparison, historical Live detail, Review and reload')
                                finally: context.close()
                        finally: browser.close()
                finally:
                    server.terminate()
                    try: server.wait(timeout=10)
                    except subprocess.TimeoutExpired: server.kill(); server.wait()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--renderer', choices=('default', 'docking', 'both'), default='both')
    main(parser.parse_args().renderer)
