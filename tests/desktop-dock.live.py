"""Actual bridge security and desktop transfer acceptance. Never prints secrets."""
import base64,json,subprocess,urllib.request,urllib.error,uuid
BASE='https://kimi.tailec998.ts.net:4347'; ORIGIN=BASE
def remote(code):
    return subprocess.check_output(['docker','exec','orbit-shared-desktop','python3','-c',code],text=True)
def pairing():
    return remote("from pathlib import Path; print(Path('/home/browser/Desktop/Orbit Dock Pairing.txt').read_text().splitlines()[2])").strip()
def req(path,body=None,token='',origin=ORIGIN):
    headers={'Origin':origin}
    if token: headers['Authorization']='Bearer '+token
    if body is not None: headers['Content-Type']='application/json'
    r=urllib.request.Request(BASE+path,data=None if body is None else json.dumps(body).encode(),headers=headers)
    try:
        with urllib.request.urlopen(r,timeout=20) as x:return x.status,json.load(x)
    except urllib.error.HTTPError as e:return e.code,json.load(e)
assert req('/api/state')[0]==401
assert req('/api/pair',{'code':'bad'})[0]==401
assert req('/api/pair',{'code':pairing()},origin='https://evil.example')[0]==403
code=pairing(); status,res=req('/api/pair',{'code':code});assert status==200
token=res['token'];name='dock-test-'+uuid.uuid4().hex+'.txt';payload=b'Workspace to desktop: verified\n'
def action(q):return req('/api/action',q,token)
assert action({'action':'shell','command':'id'})[0]==400
assert action({'action':'launch','app':'terminal'})[0]==400
assert action({'action':'read','name':'../Desktop/Orbit Dock Pairing.txt'})[0]==400
assert action({'action':'read','name':'/etc/passwd'})[0]==400
assert action({'action':'focus','id':'0;id'})[0]==400
assert action({'action':'upload','name':name,'data':base64.b64encode(payload).decode()})[0]==200
assert action({'action':'upload','name':name,'data':'YQ=='})[0]==400
read=remote("from pathlib import Path; print(Path('/home/browser/Orbit Inbox/"+name+"').read_text(),end='')")
assert read.encode()==payload
# Real reverse handoff: desktop updates the file, bridge returns exact new bytes.
remote("from pathlib import Path; Path('/home/browser/Orbit Inbox/"+name+"').write_text('Desktop to workspace: verified')")
s,res=action({'action':'read','name':name});assert s==200 and base64.b64decode(res['result']['data'])==b'Desktop to workspace: verified'
link='dock-link-'+uuid.uuid4().hex+'.txt'
remote("import os; os.symlink('/etc/passwd','/home/browser/Orbit Inbox/"+link+"')")
assert action({'action':'read','name':link})[0]==400
assert action({'action':'upload','name':link,'data':'YQ=='})[0]==400
assert action({'action':'launch','app':'files'})[0]==200
s,state=req('/api/state',token=token);assert s==200 and state['windows'] and any(f['name']==name for f in state['files'])
assert all(f['name']!=link for f in state['files'])
assert req('/api/disconnect',{},token)[0]==200
assert req('/api/state',token=token)[0]==401
assert pairing()!=code
remote("from pathlib import Path; root=Path('/home/browser/Orbit Inbox'); (root/'"+name+"').unlink(); (root/'"+link+"').unlink()")
print('PASS: auth, origin, invalid commands, path traversal, symlink rejection, overwrite prevention, real two-way file transfer, launch receipt, live windows, session revocation and code rotation.')
