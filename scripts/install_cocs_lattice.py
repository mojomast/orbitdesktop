import json,subprocess
from pathlib import Path
R=Path(__file__).resolve().parents[1];cli=['python3',str(R/'scripts/workspace_control.py'),'--workspace','eed047a8-e519-495e-a7ca-1c8c150a6ef4']
def call(*args):return json.loads(subprocess.check_output(cli+list(args)))
s=call('read')
lab={'apiVersion':1,'id':'cocs-lattice-lab','version':'0.1.0','title':'COCS · Lattice Operations','entry':'/apps/cocs-lattice-lab-aabc58272cbf16d1a97562b0/index.html'}
work={'apiVersion':1,'id':'cocs-viewer','version':'2.1.0','title':'COCS · Asset Workshop','entry':'/apps/cocs-viewer-5b61a0c577823c22dda70c05/index.html'}
ops=[{'action':'plugin_update','plugin_id':'cocs-viewer','manifest':work},{'action':'plugin_install','manifest':lab,'config':{}},{'action':'plugin_window','plugin_id':'cocs-lattice-lab','settings':{'name':'COCS · Lattice Operations','frame':{'x':380,'y':100,'width':1450,'height':1000,'z':390}}}]
preview=call('preview',json.dumps(ops));print('Preview:',json.dumps({k:v for k,v in preview.items() if k not in ('state','app_versions')}))
r=call('apply',json.dumps(ops),'--base-revision',str(s['revision']));print('Install:',json.dumps({k:v for k,v in r.items() if k not in ('state','app_versions')}))
s2=call('read');r2=call('apply',json.dumps({'action':'plugin_enable','plugin_id':'cocs-lattice-lab'}),'--base-revision',str(s2['revision']));print('Enable:',json.dumps({k:v for k,v in r2.items() if k not in ('state','app_versions')}))
a=call('read')
for old in s['state']['monitors']:
 now=next(w for w in a['state']['monitors'] if w['id']==old['id'])
 if old['id']!='718f700e-cef8-4d28-a95f-e263ff78c5fa':assert old['layout']==now['layout'],'Unrelated pane layout changed'
 else:assert old['layout']['pane']['id']==now['layout']['pane']['id'],'Workshop pane ID changed'
assert s['state']['appearance']==a['state']['appearance']
print('Verified preserved existing pane IDs/layouts and appearance. Observed:',a.get('observed_revision'))
(R/'.runtime/lattice-install-evidence.json').write_text(json.dumps({'install':r,'enable':r2,'observed_revision':a.get('observed_revision')}))
