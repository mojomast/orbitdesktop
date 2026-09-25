import json,subprocess
from pathlib import Path
R=Path(__file__).resolve().parents[2]
cmd=['python3',str(R/'scripts/workspace_control.py'),'--workspace','eed047a8-e519-495e-a7ca-1c8c150a6ef4']
s=json.loads(subprocess.check_output(cmd+['read']))
assert not any(p['manifest']['id']=='cocs-viewer' for p in s['state'].get('plugins',[])), 'Already installed; review before update'
print('Read revision',s['revision'],'; adding disabled plugin only, preserving current layout',flush=True)
op={'action':'plugin_install','manifest':{'apiVersion':1,'id':'cocs-viewer','version':'1.0.0','title':'COCS · Asset Observatory','entry':'/apps/cocs-viewer-c4d972a35f33976570647f1a/index.html'},'config':{}}
r=subprocess.run(cmd+['apply',json.dumps(op),'--base-revision',str(s['revision'])],capture_output=True,text=True)
if r.returncode: print(r.stdout,r.stderr);raise SystemExit(r.returncode)
out=json.loads(r.stdout)
print(json.dumps({k:v for k,v in out.items() if k not in ('state','app_versions')},indent=2))
