"""Owner-authorized, narrow desktop bridge. No shell/eval RPC, cookies, or CORS."""
import collections, hmac, json, os, secrets, subprocess, time
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

HERE=Path(__file__).resolve().parent
ORIGIN='https://kimi.tailec998.ts.net:4347'
CONTAINER='orbit-shared-desktop'
SESSIONS={}
EVENTS=collections.deque(maxlen=60)
ATTEMPTS=collections.deque(maxlen=20)
CODE=''

def rotate():
    global CODE
    CODE=secrets.token_urlsafe(24)
    SESSIONS.clear()
    # Pairing material is NOT in the transferable Inbox or any published app bundle.
    text='Orbit Desktop Dock pairing code\n\n'+CODE+'\n\nEnter this in the Desktop Dock pane in Orbit.\nThis grants Inbox transfers, app launching and window focus only.\nDisconnect all in the Dock revokes sessions and changes this code.\n'
    code="import os,sys; p='/home/browser/Desktop/Orbit Dock Pairing.txt'; fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600); os.fchmod(fd,0o600); os.write(fd,sys.stdin.buffer.read()); os.close(fd)"
    subprocess.run(['docker','exec','-i',CONTAINER,'python3','-c',code],input=text.encode(),check=True,timeout=8,capture_output=True)

def rpc(q):
    p=subprocess.run(['docker','exec','-i','-e','DISPLAY=:99',CONTAINER,'python3','-c',(HERE/'desktop.py').read_text()],input=json.dumps(q),text=True,capture_output=True,timeout=12)
    try: data=json.loads(p.stdout)
    except Exception: raise ValueError('Desktop unavailable')
    if not data.get('ok'): raise ValueError(data.get('error','Desktop request failed'))
    return data['result']

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass  # Do not log credentials, file contents or titles.
    def setup(self):
        super().setup(); self.connection.settimeout(10)
    def send(self,status,data,ctype='application/json'):
        b=json.dumps(data).encode() if ctype=='application/json' else data
        self.send_response(status)
        self.send_header('Content-Type',ctype)
        self.send_header('Content-Length',str(len(b)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors https://kimi.tailec998.ts.net:4325 https://kimi.tailec998.ts.net:4347")
        self.end_headers(); self.wfile.write(b)
    def host_ok(self):
        return self.headers.get('Host') in ('kimi.tailec998.ts.net:4347','127.0.0.1:'+str(self.server.server_port),'localhost:'+str(self.server.server_port))
    def authorized(self):
        t=self.headers.get('Authorization','').removeprefix('Bearer ')
        now=time.time()
        for key in list(SESSIONS):
            if SESSIONS[key]<now: del SESSIONS[key]
        return t in SESSIONS
    def do_GET(self):
        if not self.host_ok(): return self.send(403,{'error':'Host denied'})
        if self.path=='/health': return self.send(200,{'ok':True,'release':os.environ.get('ORBIT_EXTENSION_RELEASE','dev')})
        assets={'/':('index.html','text/html; charset=utf-8'),'/dock.js':('dock.js','text/javascript'),'/dock.css':('dock.css','text/css')}
        if self.path in assets:
            f,ct=assets[self.path]; return self.send(200,(HERE/f).read_bytes(),ct)
        if not self.authorized(): return self.send(401,{'error':'Pair the Dock to continue'})
        try:
            if self.path=='/api/state':
                return self.send(200,{'files':rpc({'action':'files'}),'windows':rpc({'action':'windows'}),'events':list(EVENTS),'expiresIn':'8 hours maximum'})
            self.send(404,{'error':'Not found'})
        except Exception: self.send(503,{'error':'Desktop unavailable; retry when it is running'})
    def do_POST(self):
        if not self.host_ok() or self.headers.get('Origin')!=ORIGIN: return self.send(403,{'error':'Origin denied'})
        if self.headers.get('Content-Type')!='application/json': return self.send(415,{'error':'JSON required'})
        if self.path!='/api/pair' and not self.authorized(): return self.send(401,{'error':'Pair the Dock to continue'})
        try:
            size=int(self.headers.get('Content-Length','0'))
            if size<1 or size>12*1024*1024: return self.send(413,{'error':'Request too large'})
            q=json.loads(self.rfile.read(size))
            if not isinstance(q,dict): raise ValueError('Object required')
            if self.path=='/api/pair':
                now=time.time()
                while ATTEMPTS and ATTEMPTS[0]<now-60: ATTEMPTS.popleft()
                if len(ATTEMPTS)>=10: return self.send(429,{'error':'Wait one minute before retrying'})
                ATTEMPTS.append(now)
                if not isinstance(q.get('code'),str) or not hmac.compare_digest(q['code'],CODE): return self.send(401,{'error':'Incorrect pairing code'})
                if len(SESSIONS)>=16: return self.send(429,{'error':'Too many sessions; disconnect existing sessions'})
                token=secrets.token_urlsafe(32); SESSIONS[token]=now+8*3600
                return self.send(200,{'token':token})
            if self.path=='/api/disconnect':
                rotate(); EVENTS.clear(); return self.send(200,{'ok':True})
            if self.path!='/api/action': return self.send(404,{'error':'Not found'})
            action=q.get('action')
            if action not in ('upload','read','launch','focus'): raise ValueError('Operation not allowed')
            event={'id':secrets.token_hex(4),'action':action,'time':time.strftime('%H:%M:%S'),'status':'running'}
            EVENTS.appendleft(event)
            try:
                result=rpc(q); event['status']='completed'; return self.send(200,{'ok':True,'task':event,'result':result})
            except Exception as e:
                event['status']='failed'; raise ValueError(str(e))
        except (ValueError,KeyError,TypeError) as e: self.send(400,{'error':str(e)[:200]})
        except Exception: self.send(503,{'error':'Desktop unavailable or timed out'})

if __name__=='__main__':
    rotate()
    HTTPServer(('127.0.0.1',int(os.environ.get('ORBIT_EXTENSION_PORT','4347'))),Handler).serve_forever()
