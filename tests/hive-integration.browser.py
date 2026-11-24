"""Isolated real Orbit pane → real Workflow collector HTTP handler with synthetic
data → trusted projection → real R12 reader/proxy/render. See HIVE_INTEGRATION.md.
Requires a Workflow source tree, Node >=22, Chromium, and local Orbit dependencies.
"""
from contextlib import ExitStack
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
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
from unittest.mock import patch
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'contrib'))
from rizzstack_rails import RailsLedger


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def synthetic():
    # Exercise the same tracked snapshot fixture that the portable pane uses.
    # Only the optional real-collector HTTP integration needs a Workflow tree.
    raw = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
        "import {fixtures} from './apps/rizzstack-hive/fixtures.js'; console.log(JSON.stringify(fixtures.shift));"], cwd=ROOT))
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


def advance(snapshot):
    """A new source observation, independently of the Rails invalidation hint."""
    newer=deepcopy(snapshot)
    stamp=datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    assert stamp > snapshot['generated_at']
    newer['generated_at']=newer['fleet']['collected_at']=stamp
    attempt=newer['fleet']['attempts'][0]
    assert attempt['attempt_id']=='att-fixture' and attempt['state']=='running'
    attempt.update(state='succeeded', generated_at=stamp, updated_at=stamp)
    newer['fleet']['in_flight']-=1
    return newer


def seed_reports(root, snapshot, env):
    reports=root/'enrolled'; reports.mkdir(mode=0o700)
    # Copy ONLY the native producer's synthetic public queue docket, never
    # its private verification state. Use an independently pinned public release
    # capture, when supplied, or generate one from the producer's offline API
    # fixture. Never invoke the live release CLI or discover an operator directory.
    def import_packet(key,limit):
        prefix='HIVE_'+key.upper()+'_TEST_'
        name=os.environ.get(prefix+'PACKET'); digest=os.environ.get(prefix+'SHA256')
        if not name or not digest: raise ValueError(f'Set {prefix}PACKET and {prefix}SHA256; see docs/HIVE_MISSION_QA.md')
        with open(name,'rb') as source: data=source.read(limit+1)
        if len(data)>limit or hashlib.sha256(data).hexdigest()!=digest: raise ValueError(key+' fixture size/digest mismatch')
        f=reports/(key+'.json');f.write_bytes(data);f.chmod(0o600)
    import_packet('queue',65536)
    if os.environ.get('HIVE_RELEASE_TEST_PACKET') or os.environ.get('HIVE_RELEASE_TEST_SHA256'):
        import_packet('release',16384)
    else:
        release_fixture=load('release_fixture',ROOT/'tests/test_hive_release_read.py')
        with patch.object(release_fixture.reader, '_get', side_effect=release_fixture.api):
            release_fixture.reader.publish(str(reports),include_hive=True)
    fixture=json.loads(subprocess.check_output(['node','tests/hive-mission-fixtures.mjs',str(reports)],
        input=json.dumps(snapshot),text=True,cwd=ROOT,env=env))
    return reports, fixture


def run():
    workflow=Path(os.environ.get('HIVE_WORKFLOW_TEST_ROOT',ROOT.parent/'workflow')).resolve()
    collector=load('collector',workflow/'contrib/rizzstack-observability/collector.py')
    rails_fixture=load('rails_browser',ROOT/'tests/rails-live.browser.py')
    original=snapshot=synthetic()
    owner, reader, upstream = [secrets.token_urlsafe(36) for _ in range(3)]
    with tempfile.TemporaryDirectory(prefix='orbit-hive-') as tmp, ExitStack() as cleanup:
        root=Path(tmp)
        for name in ('home','cwd','runtime','apps'): (root/name).mkdir()
        # Server's repository-relative runtime modules, assets and guides.
        for name in ('src','server','contracts','docs','packages','public','scripts'):
            shutil.copytree(ROOT/name,root/name,ignore=shutil.ignore_patterns('node_modules','__pycache__'))
        shutil.copytree(ROOT/'apps/rizzstack-rails',root/'apps/rizzstack-rails')
        # Import the actual server validators from the portable app files, not
        # from runtime/apps, a test stub or the publisher's addressed bundle.
        for member in json.loads((ROOT/'scripts/portable-product.json').read_text())['required']:
            if member.startswith('apps/rizzstack-hive/'):
                (root/member).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT/member, root/member)
        shutil.copy2(ROOT/'package.json',root/'package.json')
        (root/'node_modules').symlink_to(ROOT/'node_modules',target_is_directory=True)
        env={'PATH':os.environ['PATH'],'HOME':str(root/'home'),'TMPDIR':tmp,
             'PYTHONDONTWRITEBYTECODE':'1','ORBIT_AGENT_DISCOVERY':'off','ORBIT_BUILD_SCRATCH':str(root.parent)}
        manifest=json.loads(subprocess.check_output([sys.executable,'scripts/plugin_publish.py','apps/rizzstack-hive',
            '--id','rizzstack-hive','--version','1.0.0','--title','The Hive','--runtime',str(root/'runtime')],cwd=ROOT,env=env))
        if manifest['entry'] not in (ROOT/'src/hive-host.ts').read_text():raise RuntimeError('reviewed entry does not match the published fixture')
        reports,fixture=seed_reports(root,snapshot,env)
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
            reads.append(time.monotonic())
            # Make the event-induced floor (start + 30 s) distinguishable from
            # the ordinary timer (successful completion + 30 s). Still well
            # inside the production read deadline; no fake clocks/short timers.
            if len(reads)==1:time.sleep(4)
            return snapshot

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
                'ORBIT_HIVE_REPORT_DIR':str(reports),
                'ORBIT_TMUX_SOCKET':'hive-'+uuid4().hex[:16],'ORBIT_TMUX_CONFIG':'/dev/null',
                'ORBIT_RAILS_READ_TOKEN_FILE':str(root/'proxy-read'),'FIXTURE_COLLECTOR_PORT':str(collector_port),
                'ORBIT_EXT_OBSERVATORY_UPSTREAM':'http://127.0.0.1:'+str(collector_port),
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
                 capture=os.getenv('HIVE_TEST_CAPTURE_DIR'),fixture=fixture)
        js.stdin.write(json.dumps(cfg)+'\n');js.stdin.flush()
        appended=advanced=replaying=revoked=False
        for line in js.stdout:
            if line.strip()=='append':
                assert not appended
                appended=True
                js.stdin.write(rails_fixture.event(ledger,2)+'\n');js.stdin.flush()
            elif line.strip()=='advance':
                assert appended and not advanced
                advanced=True; snapshot=advance(snapshot)
                js.stdin.write('advanced\n');js.stdin.flush()
            elif line.strip()=='replay-old':
                assert advanced and not replaying and len(reads)>=3
                assert original['generated_at'] < snapshot['generated_at']
                # Replay the exact previously accepted /1 source. Only the
                # provider changes; the next ordinary host poll still goes
                # through owner auth, proxy and credentialed Workflow HTTP.
                replaying=True; before_replay=len(reads); snapshot=original
                js.stdin.write('replaying\n');js.stdin.flush()
            elif line.strip()=='revoke':
                assert replaying and not revoked and len(reads)>before_replay, 'expected a credentialed read of the older snapshot'
                revoked=True; prior=len(reads)
                stop_collector();server=serve(collector_port,secrets.token_urlsafe(36))
                js.stdin.write('revoked\n');js.stdin.flush()
            else:raise AssertionError('unexpected fixture control message')
        if js.wait():raise RuntimeError('Hive real-browser assertions failed')
        assert revoked and len(reads)==prior, 'rotated collector credential must not reach the provider'
        intervals=[b-a for a,b in zip(reads,reads[1:])]
        # These are provider arrivals after owner reauthentication + two HTTP
        # hops, not the scheduling clock. The browser also measures read starts.
        assert all(t>=29.75 for t in intervals),f'credentialed collector reads too close: {intervals}'
        print('PASS: exact Hive pane → overview and enrolled evidence → exact selected R12 append → '
              'authoritative snapshot and duplicate → out-of-order report scope withheld → collector revocation. '
              'Credentialed provider intervals (s): '+', '.join(f'{v:.3f}' for v in intervals))


if __name__=='__main__': run()
