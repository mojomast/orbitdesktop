import json,subprocess
cmd=['python3','scripts/workspace_control.py','--workspace','eed047a8-e519-495e-a7ca-1c8c150a6ef4']
d=json.loads(subprocess.check_output(cmd+['read']))
existing=[w for w in d['state']['monitors'] if w['name']=='MiMo · Performance Lab']
if existing: op={'action':'select','window_id':existing[0]['id']}
else: op={'action':'add_window','name':'MiMo · Performance Lab','kind':'browser','url':'https://kimi.tailec998.ts.net:4366/','frame':{'x':300,'y':180,'width':1450,'height':1250,'z':max((w.get('frame',{}).get('z',0) for w in d['state']['monitors']),default=0)+1}}
r=subprocess.run(cmd+['apply',json.dumps(op),'--base-revision',str(d['revision'])],capture_output=True,text=True)
if r.returncode: print(r.stdout,r.stderr);raise SystemExit(r.returncode)
result=json.loads(r.stdout)
print(json.dumps({k:v for k,v in result.items() if k not in ('state','app_versions')},indent=2))
