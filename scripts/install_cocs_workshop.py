import json,subprocess
from pathlib import Path
R=Path(__file__).resolve().parents[1]
cli=['python3',str(R/'scripts/workspace_control.py'),'--workspace','eed047a8-e519-495e-a7ca-1c8c150a6ef4']
s=json.loads(subprocess.check_output(cli+['read']))
p=next(x for x in s['state']['plugins'] if x['manifest']['id']=='cocs-viewer')
print('Read revision',s['revision'],'existing entry',p['manifest']['entry'],flush=True)
manifest={'apiVersion':1,'id':'cocs-viewer','version':'2.0.0','title':'COCS · Asset Workshop','entry':'/apps/cocs-viewer-7b0acda75f4ab60e72fb2113/index.html'}
ops=[{'action':'plugin_update','plugin_id':'cocs-viewer','manifest':manifest}]
result=json.loads(subprocess.check_output(cli+['apply',json.dumps(ops),'--base-revision',str(s['revision'])]))
print(json.dumps({k:v for k,v in result.items() if k not in ['state','app_versions']},indent=2))
a=json.loads(subprocess.check_output(cli+['read']))
old=[(w['id'],w['layout']) for w in s['state']['monitors'] if w['id']!=p['window']['id']]
new=[(w['id'],w['layout']) for w in a['state']['monitors'] if w['id']!=p['window']['id']]
assert old==new,'Other panes changed concurrently; inspect state'
print('Verified unrelated window/pane layouts preserved. Current revision',a['revision'],'observed',a.get('observed_revision'))
