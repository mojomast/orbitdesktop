import json,subprocess
from pathlib import Path
R=Path(__file__).resolve().parents[1]
cli=['python3',str(R/'scripts/workspace_control.py'),'--workspace','eed047a8-e519-495e-a7ca-1c8c150a6ef4']
def call(*a):return json.loads(subprocess.check_output(cli+list(a),text=True))
before=call('read')
manifest={'apiVersion':1,'id':'cocs-studio','version':'1.1.0','title':'COCS · Studio','entry':'/apps/cocs-studio-d686a30b14a5477c43d7b0e0/index.html'}
op={'action':'plugin_update','plugin_id':'cocs-studio','manifest':manifest}
r=call('apply',json.dumps(op),'--base-revision',str(before['revision']))
print(json.dumps({k:v for k,v in r.items() if k not in ('state','app_versions')}))
after=call('read')
assert before['state']['appearance']==after['state']['appearance']
for old in before['state']['monitors']:
 new=next(w for w in after['state']['monitors'] if w['id']==old['id'])
 if old['id']!='81279907-8566-4e05-9a7c-972fcae81a0a':assert old['layout']==new['layout']
 else:assert old['layout']['pane']['id']==new['layout']['pane']['id']
print('Verified pane preservation; observed revision',after.get('observed_revision'))
