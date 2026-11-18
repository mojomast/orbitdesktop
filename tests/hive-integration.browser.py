"""Isolated real Orbit pane → real Workflow collector HTTP handler with synthetic
data → trusted projection → real R12 reader/proxy/render. See HIVE_INTEGRATION.md.
Requires a Workflow source tree, Node >=22, Chromium, and local Orbit dependencies.
"""
from contextlib import ExitStack
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from urllib.request import urlopen
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'contrib'))
from rizzstack_rails import RailsLedger


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def synthetic(workflow):
    raw = json.loads((workflow/'schemas/hive/fixtures/shift.json').read_text())
    shift = datetime.now(timezone.utc) - datetime.fromisoformat(raw['generated_at'].replace('Z','+00:00'))

    def rebase(value):
        if isinstance(value,list):return [rebase(v) for v in value]
        if isinstance(value,dict):return {k:rebase(v) for k,v in value.items()}
        if isinstance(value,str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ',value):
            return (datetime.fromisoformat(value.replace('Z','+00:00'))+shift).strftime('%Y-%m-%dT%H:%M:%SZ')
        return value
    raw=rebase(raw)
    raw['fleet']['attempts'][0].update(attempt_id='att-fixture',job_id='job-fixture',detail='PRIVATE-FIXTURE-OMIT')
    raw['pipeline']['jobs'][0]['job_id']='job-fixture'
    return raw


def stop(process):
    if process.poll() is None:
        process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: process.kill(); process.wait()


def run():
    workflow=Path(os.environ.get('HIVE_WORKFLOW_TEST_ROOT',ROOT.parent/'workflow'))
    collector=load('collector',workflow/'contrib/rizzstack-observability/collector.py')
    rails_fixture=load('rails_browser',ROOT/'tests/rails-live.browser.py')
    snapshot=synthetic(workflow)
    owner, reader, upstream = [secrets.token_urlsafe(36) for _ in range(3)]
    with tempfile.TemporaryDirectory(prefix='orbit-hive-') as tmp, ExitStack() as cleanup:
        root=Path(tmp)
        for name in ('home','cwd','runtime','apps'): (root/name).mkdir()
        # Server's repository-relative runtime modules, assets and guides.
        for name in ('src','server','contracts','docs','packages','public','scripts'):
            shutil.copytree(ROOT/name,root/name,ignore=shutil.ignore_patterns('node_modules','__pycache__'))
        shutil.copytree(ROOT/'apps/rizzstack-rails',root/'apps/rizzstack-rails')
        shutil.copy2(ROOT/'package.json',root/'package.json')
        (root/'node_modules').symlink_to(ROOT/'node_modules',target_is_directory=True)
        env={'PATH':os.environ['PATH'],'HOME':str(root/'home'),'TMPDIR':tmp,
             'ORBIT_AGENT_DISCOVERY':'off','ORBIT_BUILD_SCRATCH':str(root.parent)}
        manifest=json.loads(subprocess.check_output([sys.executable,'scripts/plugin_publish.py','apps/rizzstack-hive',
            '--id','rizzstack-hive','--version','1.0.0','--title','The Hive','--runtime',str(root/'runtime')],cwd=ROOT,env=env))
        if manifest['entry'] not in (ROOT/'src/hive-host.ts').read_text():raise RuntimeError('reviewed entry does not match the published fixture')
        dist=os.getenv('HIVE_TEST_DIST')
        if dist: (root/'dist').symlink_to(Path(dist).resolve(),target_is_directory=True)
        else: subprocess.run(['node','scripts/isolated_build.mjs','--dest',str(root/'dist')],cwd=ROOT,env=env,check=True)
        # Intentionally unaddressed lookalike with identical bytes; no grant is offered.
        shutil.copytree(ROOT/'apps/rizzstack-hive',root/'runtime/apps/rizzstack-hive')
        for name in ('upstream-read','proxy-read'):
            f=root/name;f.write_text(reader);f.chmod(0o600)
        ledger=RailsLedger(root/'ledger.sqlite');cleanup.callback(ledger.close)
        event_id=rails_fixture.event(ledger,1)
        read=subprocess.Popen([sys.executable,str(ROOT/'tests/rails-live.browser.py'),'--fixture-reader','0',tmp],
                              cwd=root,env=env,stdout=subprocess.PIPE,text=True);cleanup.callback(stop,read)
        rails_port=int(read.stdout.readline()); reads=[]

        def provider():
            reads.append(time.monotonic());return snapshot

        def serve(port, token):
            httpd=collector.make_server('127.0.0.1',port,provider,token)
            thread=threading.Thread(target=httpd.serve_forever,kwargs={'poll_interval':0.05},daemon=True)
            thread.start();return httpd
        server=serve(0,upstream);collector_port=server.server_port
        def stop_collector(): server.shutdown();server.server_close()
        cleanup.callback(stop_collector)
        with socket.socket() as probe:
            probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
        origin=f'http://127.0.0.1:{port}'
        process=subprocess.Popen(['node','--experimental-strip-types','--import',str(ROOT/'tests/hive-integration.remap.mjs'),'server/index.mjs'],
            cwd=root,stdout=subprocess.DEVNULL,env={**env,'PORT':str(port),'ORBIT_HOST':'127.0.0.1','ORBIT_CWD':str(root/'cwd'),
                'ORBIT_TOKEN':owner,'ORBIT_RUNTIME_DIR':str(root/'runtime'),'ORBIT_RAILS_PORT':str(rails_port),
                'ORBIT_TMUX_SOCKET':'hive-'+uuid4().hex[:16],'ORBIT_TMUX_CONFIG':'/dev/null',
                'ORBIT_RAILS_READ_TOKEN_FILE':str(root/'proxy-read'),'FIXTURE_COLLECTOR_PORT':str(collector_port),
                'ORBIT_OBS_COLLECTOR_TOKEN':upstream});cleanup.callback(stop,process)
        for _ in range(160):
            if process.poll() is not None: raise RuntimeError('isolated Orbit exited')
            try:
                with urlopen(origin+'/api/health',timeout=.5):break
            except OSError: time.sleep(.05)
        else: raise RuntimeError('isolated Orbit boot timed out')
        js_env={**env,'PLAYWRIGHT_BROWSERS_PATH':os.getenv('PLAYWRIGHT_BROWSERS_PATH',str(Path.home()/'.cache/ms-playwright'))}
        if os.getenv('CHROMIUM_EXECUTABLE'):js_env['CHROMIUM_EXECUTABLE']=os.environ['CHROMIUM_EXECUTABLE']
        js=subprocess.Popen(['node','tests/hive-integration.browser.mjs'],cwd=ROOT,env=js_env,text=True,
                             stdin=subprocess.PIPE,stdout=subprocess.PIPE);cleanup.callback(stop,js)
        cfg=dict(origin=origin,workspace=str(uuid4()),entry=manifest['entry'],owner=owner,reader=reader,upstream=upstream,event=event_id,
                 capture=os.getenv('HIVE_TEST_CAPTURE_DIR'))
        js.stdin.write(json.dumps(cfg)+'\n');js.stdin.flush()
        for line in js.stdout:
            if line.strip()=='revoke':
                assert len(reads)==1,'unexpected upstream credentialed read count'
                stop_collector();server=serve(collector_port,secrets.token_urlsafe(36))
                js.stdin.write('revoked\n');js.stdin.flush()
        if js.wait():raise RuntimeError('Hive real-browser assertions failed')
        assert len(reads)==1
        print('PASS: exact Hive pane → consent → mediated Workflow snapshot → exact R12 origin mark → selection focus; scope, document, credential, revocation and throttle checks passed.')


if __name__=='__main__': run()
