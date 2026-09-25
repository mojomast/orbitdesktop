import json, os, shutil, socket, subprocess
from pathlib import Path
from urllib.parse import urlsplit
R=Path(__file__).resolve().parents[1]
c=json.loads((R/'.runtime/plugin-catalog/config.json').read_text())
u=urlsplit(c['public_origin']); c['public_origin']=f'{u.scheme}://{u.hostname}:4361'
c['hermes_source']=str(Path(shutil.which('hermes')).resolve().parents[2])
p=R/'.runtime/devplan-interview/config.json'; p.parent.mkdir(mode=0o700,parents=True,exist_ok=True);p.write_text(json.dumps(c));p.chmod(0o600)
def run(*args): return json.loads(subprocess.check_output(['python3',str(R/'scripts/extensions.py'),*args],text=True))
r=run('stage',str(R/'extensions/devplan-interview'))
for port in range(4440,4450):
 with socket.socket() as s:
  try:s.bind(('127.0.0.1',port))
  except OSError:continue
  break
else:raise RuntimeError('No candidate port')
a=run('activate',r['id'],r['release'],'--port',str(port),'--trust-host-code')
subprocess.run(['tailscale','serve','--bg','--https=4361',f'http://127.0.0.1:{port}'],check=True)
print(json.dumps({'health':run('health','devplan-interview'),'url':c['public_origin']}))
