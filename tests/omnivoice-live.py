"""Real service checks. Tokens stay in process; no test doubles for generation."""
import io,json,re,sys,urllib.request,urllib.error,wave,time
BASE='https://kimi.tailec998.ts.net:10445'
def get(path,token=None,data=None,base=BASE):
    headers={'X-Bench-Token':token} if token else {}
    if data is not None:headers['Content-Type']='application/json'
    req=urllib.request.Request(base+path,headers=headers,data=None if data is None else json.dumps(data).encode())
    return urllib.request.urlopen(req,timeout=20)
html=get('/').read().decode()
token=re.search('name="bench-token" content="([^"]+)"',html)[1]
assert '__BENCH_TOKEN__' not in html
for path in ['/api/state','/profiles','/system/info']:
    try:get(path)
    except urllib.error.HTTPError as e:assert e.code in (403,404)
    else:raise AssertionError('Unauthenticated/private route allowed')
try:get('/',base='http://127.0.0.1:4410')
except urllib.error.HTTPError as e:assert e.code==403
else:raise AssertionError('Unidentified direct request allowed')
print('PASS: Tailscale-authenticated page; missing session token rejected; direct anonymous access rejected; Studio management routes unavailable',flush=True)
for data in [{'text':'test','profile_id':'unauthorized'},{'text':'test','num_step':999},{'text':'test','seed':-1}]:
    try:get('/api/takes',token,data)
    except urllib.error.HTTPError as e:assert e.code==400
    else:raise AssertionError('Invalid payload accepted')
print('PASS: profile injection and invalid generation controls rejected',flush=True)
if '--generate' in sys.argv:
    recipe={'label':'Verified smoke test · seed 42','text':'Hello. Welcome to the voice lab.','instruct':'male, middle-aged, low pitch, british accent','seed':42,'num_step':8,'speed':1,'guidance_scale':2,'language':'en','effect_preset':'raw'}
    t=json.load(get('/api/takes',token,recipe));id=t['id'];print('Queued real Studio test:',id,flush=True)
    deadline=time.time()+1500
    while time.time()<deadline:
        state=json.load(get('/api/state',token));t=next(t for t in state['takes'] if t['id']==id)
        if t['status'] in ('done','error','interrupted'):break
        time.sleep(5)
    print(json.dumps(t,indent=2),flush=True)
    assert t['status']=='done','Real generation did not finish successfully'
    raw=get('/api/audio/'+id,token).read()
    with wave.open(io.BytesIO(raw),'rb') as w:
        print('PASS: real WAV:',len(raw),'bytes;',w.getframerate(),'Hz;',w.getnframes(),'frames',flush=True)
