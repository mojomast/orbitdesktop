import json,subprocess,sys
from pathlib import Path
R=Path(__file__).resolve().parents[1]
cli=['python3',str(R/'scripts/workspace_control.py'),'--workspace','eed047a8-e519-495e-a7ca-1c8c150a6ef4']
s=json.loads(subprocess.check_output(cli+['read']))
manifest={'apiVersion':1,'id':'cocs-graphics-lab','version':'1.0.0','title':'COCS · Graphics Lab','entry':'/apps/cocs-graphics-lab-a74ebc8f3d38e5a93b5a2d7a/index.html'}
if '--enable' in sys.argv:
 ops=[{'action':'plugin_enable','plugin_id':'cocs-graphics-lab'}]
else:
 ops=[{'action':'plugin_install','manifest':manifest,'config':{}},{'action':'plugin_window','plugin_id':'cocs-graphics-lab','settings':{'name':'COCS · Graphics Lab','frame':{'x':650,'y':200,'width':1500,'height':1050,'z':350}}}]
r=json.loads(subprocess.check_output(cli+['apply',json.dumps(ops),'--base-revision',str(s['revision'])]))
print(json.dumps({k:v for k,v in r.items() if k not in ('state','app_versions')},indent=2))
a=json.loads(subprocess.check_output(cli+['read']))
for old in s['state']['monitors']:
 current=next(w for w in a['state']['monitors'] if w['id']==old['id']);assert current['layout']==old['layout'],'Existing pane layout changed'
print('Existing panes preserved; observed revision:',a.get('observed_revision'))
