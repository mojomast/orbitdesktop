"""Local deployment; no Jev key or inference. Requires installed dashboard Doom skill."""
import json, shutil, subprocess, socket
from pathlib import Path
from urllib.parse import urlsplit
R=Path(__file__).resolve().parents[1]
D=Path.home()/'.hermes/skills/gaming/doom-player'
def run(*args):return json.loads(subprocess.check_output(['python3',str(R/'scripts/extensions.py'),*args],text=True))
p=R/'.runtime/hermes-doom';p.mkdir(mode=0o700,parents=True,exist_ok=True)
c=json.loads((R/'.runtime/devplan-interview/config.json').read_text())
u=urlsplit(c['public_origin'])
c={k:c[k] for k in ('orbit_origin','orbit_auth_url')}
c.update(public_origin=f'{u.scheme}://{u.hostname}:4362',python=str(D/'.venv/bin/python'),python_prefix=str(D/'.venv'),wad=str(D/'wads/doom1.wad'),policy=str(p/'frozen-policy-v3.json'))
if not Path(c['policy']).exists():shutil.copyfile(D/'audit/route_policy_v3.json',c['policy'])
Path(c['policy']).chmod(0o600)
(p/'config.json').write_text(json.dumps(c));(p/'config.json').chmod(0o600)
# A clean staging tree excludes interpreter caches.
b=R/'.runtime/hermes-doom/build';b.mkdir(exist_ok=True)
for f in (R/'extensions/hermes-doom').iterdir():
    if f.is_file():shutil.copyfile(f,b/f.name)
with socket.socket() as sock:sock.bind(('127.0.0.1',4462))
r=run('stage',str(b));run('activate',r['id'],r['release'],'--port','4462','--trust-host-code')
subprocess.run(['tailscale','serve','--bg','--https=4362','http://127.0.0.1:4462'],check=True)
print(json.dumps({'health':run('health','hermes-doom'),'url':c['public_origin']}))
