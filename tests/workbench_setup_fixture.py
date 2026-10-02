"""Disposable real server + pinned Hermes + deterministic local model for setup QA.

No owner runtime, inherited model credentials, live terminals or external model
endpoint is used. This fixture reuses the native acceptance model protocol.
"""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('setup_native_fixture', ROOT / 'tests/workbench-native.browser.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
WRONG = 'export const sum = (a,b) => a-b;\n'
RIGHT = 'export const sum = (a,b) => a+b;\n'
native.RIGHT = RIGHT


@contextlib.contextmanager
def setup_fixture():
    with tempfile.TemporaryDirectory(prefix='orbit-goal-setup-', dir='/tmp/opencode') as temporary:
        root = Path(temporary)
        for name in ('server', 'src', 'contracts', 'docs', 'public', 'scripts', 'hermes-plugin'):
            shutil.copytree(ROOT / name, root / name)
        for name in ('index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.js'):
            shutil.copy2(ROOT / name, root / name)
        (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        for name in ('runtime', 'home', 'cwd', 'tmux', 'project'):
            (root / name).mkdir()
        project = root / 'project'
        (project / 'math.js').write_text(WRONG)
        (project / 'math.test.js').write_text(native.MATH_TEST)
        (project / 'package.json').write_text('{"name":"goal-fixture","version":"1.0.0","type":"module"}\n')
        env = {'HOME': str(root / 'home'), 'PATH': os.environ['PATH'], 'npm_config_cache': str(root / '.npm')}
        subprocess.run(['node', str(ROOT / 'scripts/isolated_build.mjs'), '--source', str(root),
                        '--dest', str(root / 'dist'), '--allow-source-dist'], cwd=root, env=env, check=True)
        source = native.HERMES_SOURCE
        assert str(source).startswith('/tmp/opencode/') and (source / '.venv/bin/python').is_file()
        assert subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip() == native.HERMES_PIN
        model, gateway = native.ModelFixture(), native.helper.SyntheticGateway()
        threads = [threading.Thread(target=host.serve_forever, daemon=True) for host in (model, gateway)]
        for thread in threads:
            thread.start()
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        origin, token = f'http://127.0.0.1:{port}', secrets.token_urlsafe(36)
        workspace, pane, monitor = (str(uuid.uuid4()) for _ in range(3))
        session = 'orbit-' + str(uuid.uuid4())
        state = {'version': 1, 'selected': monitor, 'arc': 14, 'view': 'windows', 'sidebarHidden': True,
                 'monitors': [{
                     'id': monitor, 'name': 'Goal-first fixture', 'diagonal': 32, 'aspect': '16:9',
                     'height': 0, 'distance': 0, 'pitch': 0, 'yaw': 0, 'offset': 0, 'fontSize': 14,
                     'frame': {'x': 0, 'y': 0, 'width': 1100, 'height': 900, 'z': 0},
                     'layout': {'type': 'pane', 'pane': {'id': pane, 'kind': 'agent', 'url': ''}}}]}
        server_env = {**env, 'PORT': str(port), 'ORBIT_TOKEN': token, 'ORBIT_RUNTIME_DIR': str(root / 'runtime'),
                      'ORBIT_CWD': str(root / 'cwd'), 'ORBIT_TMUX_SOCKET': 'setup-' + str(uuid.uuid4()),
                      'ORBIT_TMUX_CONFIG': '/dev/null', 'TMUX_TMPDIR': str(root / 'tmux'),
                      'HERMES_API_URL': f'http://127.0.0.1:{gateway.server_port}',
                      'HERMES_API_KEY': native.GATEWAY_KEY,
                      'ORBIT_NATIVE_HERMES_SOURCE': str(source),
                      'ORBIT_NATIVE_HERMES_PYTHON': str(source / '.venv/bin/python'),
                      'ORBIT_NATIVE_HERMES_MODEL_URL': f'http://127.0.0.1:{model.server_port}/v1',
                      'ORBIT_NATIVE_HERMES_PROFILE': 'default', 'ORBIT_NATIVE_HERMES_MODEL': 'orbit-local-fixture'}
        with (root / 'server.log').open('w+') as log:
            server = subprocess.Popen(['node', '--experimental-strip-types', 'server/index.mjs'], cwd=root,
                                      env=server_env, stdout=log, stderr=log)
            try:
                for _ in range(400):
                    if server.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(log.read().replace(token, '[REDACTED]'))
                    try:
                        urllib.request.urlopen(origin + '/api/health', timeout=1).close()
                        break
                    except OSError:
                        time.sleep(.05)
                else:
                    raise RuntimeError('Setup server readiness timeout')
                yield {'root': root, 'project': project, 'origin': origin, 'token': token, 'model': model,
                       'gateway': gateway, 'workspace': workspace, 'pane': pane, 'session': session,
                       'state': state, 'env': server_env}
            finally:
                server.terminate()
                try:
                    server.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    server.kill(); server.wait()
                for host in (model, gateway):
                    host.shutdown(); host.server_close()
                for thread in threads:
                    thread.join(timeout=5)


def seed(context, fixture):
    storage = {'orbit.workspace.id': fixture['workspace'], 'orbit.workspace.v1': json.dumps(fixture['state']),
               'orbit.onboarded': 'true', 'orbit.experimental.v1': json.dumps({'version': 1, 'workbench': True})}
    chat = {'session': fixture['session'], 'profile_id': 'default', 'messages': []}
    context.add_init_script('''(() => {
      if (window !== window.top || sessionStorage.getItem('setup-fixture-seeded')) return;
      for (const [key,value] of Object.entries(%s)) localStorage.setItem(key,value);
      sessionStorage.setItem(%s,JSON.stringify(%s));
      sessionStorage.setItem('setup-fixture-seeded','yes');
    })()''' % (json.dumps(storage), json.dumps('orbit-hermes-chat:' + fixture['pane']), json.dumps(chat)))
