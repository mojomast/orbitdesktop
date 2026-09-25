"""One actual Hermes generation; never publishes."""
import json,re,time,urllib.request
from pathlib import Path
base='http://127.0.0.1:4416';headers={'Tailscale-User-Login':'mojomasta@gmail.com'}
html=urllib.request.urlopen(urllib.request.Request(base+'/',headers=headers)).read().decode();token=re.search(r"window.workshopToken='([^']+)'",html)[1]
headers.update({'X-Workshop-Token':token,'Content-Type':'application/json'})
def api(op,**data):
 req=urllib.request.Request(base+'/api',headers=headers,data=json.dumps({'op':op,**data}).encode())
 with urllib.request.urlopen(req,timeout=240) as r:return json.load(r)
s=api('edit',asset='operation:cocs-director',prompt='Local-only validation draft: in game/cocs-director.mjs, add one accurate comment explaining that directorPhase inputs are tick counts at RULES.dt, not wall-clock seconds. Do not change runtime behavior or other files. Do not commit or publish. This tests the actual Hermes draft workflow.')
print('Created local-only draft',s['id'],flush=True)
for _ in range(180):
 time.sleep(3);s=api('get',id=s['id']);print(s['status'],flush=True)
 if s['status'] in ('ready','blocked','published','publish-review'):
  Path('.runtime/lattice-real-generation.json').write_text(json.dumps(s));print(json.dumps({k:s.get(k) for k in ['id','status','error','files','evidence']}));break
else:raise SystemExit('Timed out: run retained for review, not retried')
