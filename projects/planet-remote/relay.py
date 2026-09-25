"""Fixed-scope desktop mailbox -> planet-remote configuration. No shell input."""
import json, subprocess, time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
CMD=['python3',str(ROOT/'scripts/workspace_control.py'),'--workspace','eed047a8-e519-495e-a7ca-1c8c150a6ef4']
MAIL='/home/browser/.local/share/planet-remote/'
def run(args):return subprocess.run(args,capture_output=True,text=True,timeout=40,check=True).stdout
def status(text):
    subprocess.run(['docker','exec','-i','orbit-shared-desktop','tee',MAIL+'status.txt'],input=text,text=True,stdout=subprocess.DEVNULL,check=True)
def once(last):
    raw=run(['docker','exec','orbit-shared-desktop','python3','-c',f'from pathlib import Path; p=Path({MAIL+"request.json"!r}); print(p.read_text()[:4096] if p.exists() else "{{}}")'])
    d=json.loads(raw)
    if not d or d.get('nonce')==last:return last
    nonce=d['nonce']
    if d.get('theme') not in ['Aurora','Nebula','Solar','Ocean']:raise ValueError('Invalid theme')
    if type(d.get('size')) is not int or not 120<=d['size']<=280:raise ValueError('Invalid size')
    config={k:d[k] for k in ['theme','size','message','sent']}
    if not all(isinstance(config[k],str) for k in ['message','sent']):raise ValueError('Invalid text')
    config['message']=config['message'][:160];config['sent']=config['sent'][:32]
    state=json.loads(run(CMD+['read']))
    from urllib.parse import quote
    op={'action':'set_pane','window_id':'925e8d26-fdbd-4722-a9dd-c2a2f44a965e','pane_id':'b5cf35bb-b2a6-424f-be4d-166c643c6214','kind':'browser','url':'/apps/planet-remote-2b44f8321d59e51bd2941a4b/index.html#orbit-config='+quote(json.dumps(config))}
    result=json.loads(run(CMD+['apply',json.dumps(op),'--base-revision',str(state['revision'])]))
    status('Orbit received your signal.' if result.get('browser_applied') else 'Saved in Orbit; display acknowledgement pending.')
    if result.get('error'):raise RuntimeError(result['error'])
    print(json.dumps({'event':'transmitted','nonce':nonce,'revision':result.get('revision'),'browser_applied':result.get('browser_applied')}),flush=True)
    return nonce
if __name__=='__main__':
    last=None
    while True:
        try:last=once(last)
        except Exception as e:
            print(type(e).__name__,flush=True)
            status('Relay could not deliver. Check connection and try again.')
        time.sleep(2)
