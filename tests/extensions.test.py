import json,os,subprocess,sys,tempfile,socket,shutil
from pathlib import Path
R=Path(__file__).resolve().parents[1]
def port():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
with tempfile.TemporaryDirectory() as tmp:
 env={**os.environ,'ORBIT_EXTENSIONS_DIR':str(Path(tmp)/'runtime')};src=Path(tmp)/'source';shutil.copytree(R/'examples/extensions/example-service',src,ignore=shutil.ignore_patterns('__pycache__'))
 def cli(*args,ok=True):
  r=subprocess.run([sys.executable,str(R/'scripts/extensions.py'),*args],env=env,capture_output=True,text=True);assert (r.returncode==0)==ok,r.stdout+r.stderr;return json.loads(r.stdout)
 try:
  first=cli('stage',str(src));release=first['release'];assert not first['activated']
  cli('activate','example-service',release,'--port',str(port()),ok=False)
  a=cli('activate','example-service',release,'--port',str(port()),'--trust-host-code');assert a['pid']>0
  assert json.loads(cli('request','example-service','/health')['body'])['release']==release
  (src/'main.py').write_text((src/'main.py').read_text()+'\n# version two\n')
  second=cli('stage',str(src))['release'];assert second!=release
  cli('activate','example-service',second,'--port',str(port()),'--trust-host-code')
  assert cli('health','example-service')['healthy']
  restarted=cli('restart','example-service','--port',str(port()),'--trust-host-code');assert restarted['release']==second
  assert cli('status')['previous']['example-service']['release']==release
  assert len(cli('releases','example-service')['releases'])==2
  assert 'GET /health' in cli('logs','example-service')['text']
  rollback=cli('rollback','example-service','--port',str(port()),'--trust-host-code');assert rollback['release']==release
  (src/'main.py').write_text('raise RuntimeError("bad release")\n');bad=cli('stage',str(src))['release']
  cli('activate','example-service',bad,'--port',str(port()),'--trust-host-code',ok=False)
  status=cli('status');assert status['active']['example-service']['release']==release;assert status['active']['example-service']['running']
  cli('safe-mode');assert cli('status')['active']=={}
  cli('activate','example-service',release,'--port',str(port()),'--trust-host-code',ok=False)
  cli('resume')
  print('PASS: real-process stage, explicit trust, healthy promotion, rollback, failed-release preservation, safe mode and resume')
 finally:cli('safe-mode')
