import json,subprocess
from pathlib import Path
R=Path(__file__).resolve().parents[2]
cmd=['python3',str(R/'scripts/workspace_control.py'),'--workspace','eed047a8-e519-495e-a7ca-1c8c150a6ef4']
s=json.loads(subprocess.check_output(cmd+['read']))
p=next(p for p in s['state']['plugins'] if p['manifest']['id']=='cocs-viewer')
assert not p['enabled'],'Already enabled; review current window instead'
assert p['manifest']['entry']=='/apps/cocs-viewer-c4d972a35f33976570647f1a/index.html'
ops=[{'action':'plugin_window','plugin_id':'cocs-viewer','settings':{'name':'COCS · Asset Observatory','frame':{'x':70,'y':70,'width':1250,'height':900,'z':max(m.get('frame',{}).get('z',0) for m in s['state']['monitors'])+1},'diagonal':52,'aspect':'16:9'}},{'action':'plugin_enable','plugin_id':'cocs-viewer'}]
preview=json.loads(subprocess.check_output(cmd+['preview',json.dumps(ops)]))
print('Preview fields:',preview.get('changed_fields'),'; revision',s['revision'],flush=True)
# The operations only configure and enable this new plugin; no existing panes change.
r=subprocess.run(cmd+['apply',json.dumps(ops),'--base-revision',str(s['revision'])],capture_output=True,text=True)
if r.returncode: print(r.stdout,r.stderr);raise SystemExit(r.returncode)
out=json.loads(r.stdout)
print(json.dumps({k:v for k,v in out.items() if k not in ('state','app_versions')},indent=2))
s=json.loads(subprocess.check_output(cmd+['read']))
p=next(p for p in s['state']['plugins'] if p['manifest']['id']=='cocs-viewer')
print('Plugin:',json.dumps(p))
