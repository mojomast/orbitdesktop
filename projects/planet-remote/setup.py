import json,subprocess
from relay import CMD,run
s=json.loads(run(CMD+['read']))
m=next(m for m in s['state']['monitors'] if m['id']=='925e8d26-fdbd-4722-a9dd-c2a2f44a965e')
assert m['layout']['type']=='pane'
r=json.loads(run(CMD+['apply',json.dumps({'action':'split_pane','window_id':m['id'],'pane_id':m['layout']['pane']['id'],'axis':'row','ratio':0.65,'kind':'browser'}),'--base-revision',str(s['revision'])]))
if 'error' in r:raise RuntimeError(r['error'])
m=next(m for m in r['state']['monitors'] if m['id']==m['id'] and m['id']=='925e8d26-fdbd-4722-a9dd-c2a2f44a965e')
print(json.dumps({'revision':r['revision'],'layout':m['layout'],'browser_applied':r.get('browser_applied')}))
