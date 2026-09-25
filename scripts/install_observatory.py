"""Install tested Observatory without replacing any existing workspace content."""
from pathlib import Path
import json
import subprocess
ROOT=Path(__file__).resolve().parents[1]
WORKSPACE='eed047a8-e519-495e-a7ca-1c8c150a6ef4'
COMMAND=['python3',str(ROOT/'scripts/workspace_control.py'),'--workspace',WORKSPACE]
def call(*args):
 return json.loads(subprocess.check_output(COMMAND+list(args),text=True))
def main():
 before=call('read')
 manifest={'apiVersion':1,'id':'orbit-observatory','version':'1.0.0','title':'Orbit Observatory','entry':'/apps/orbit-observatory-8aa34f2601b1358f33e1a6e5/index.html'}
 installed=call('apply',json.dumps({'action':'plugin_install','manifest':manifest,'config':{}}),'--base-revision',str(before['revision']))
 operations=[{'action':'plugin_window','plugin_id':'orbit-observatory','settings':{'name':'Observatory · Mission intelligence','diagonal':56,'aspect':'16:9','frame':{'x':32,'y':24,'width':1120,'height':820,'z':200}}},{'action':'plugin_enable','plugin_id':'orbit-observatory'}]
 preview=call('preview',json.dumps(operations),'--base-revision',str(installed['revision']))
 after=call('apply',json.dumps(operations),'--base-revision',str(installed['revision']))
 for old in before['state']['monitors']:
  current=next(x for x in after['state']['monitors'] if x['id']==old['id'])
  assert current==old,'Existing monitor was changed'
 assert after['state']['appearance']==before['state']['appearance']
 new=next(x for x in after['state']['plugins'] if x['manifest']['id']=='orbit-observatory')
 assert new['enabled']
 print(json.dumps({'revision':after['revision'],'observed_revision':after['observed_revision'],'browser_applied':after['browser_applied'],'existing_windows_preserved':len(before['state']['monitors']),'dashboard_window_id':new['window']['id'],'entry':manifest['entry']}))
if __name__=='__main__':main()
