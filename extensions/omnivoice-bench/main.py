"""Private OmniVoice bench. Trusted host code; no arbitrary proxy or file paths."""
import base64, hashlib, hmac, io, json, math, os, queue, re, secrets, sqlite3, threading, time, urllib.request, urllib.error, urllib.parse, uuid, wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('BENCH_DATA', '/home/mojo/.hermes-instances/fresh/workspace/orbitdesktop/.runtime/omnivoice-bench'))
PORT = int(os.environ.get('ORBIT_EXTENSION_PORT', '4410'))
ORIGIN = 'https://kimi.tailec998.ts.net:10445'
OWNER = 'mojomasta@gmail.com'
UPSTREAM = 'http://127.0.0.1:3900'
LOCK = threading.RLock()
WAKE = threading.Event()
SECRET = secrets.token_bytes(32)
PAUSED = False
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

def connect():
    c = sqlite3.connect(DATA / 'bench.sqlite3', timeout=10)
    c.row_factory = sqlite3.Row
    return c

def initialize():
    os.umask(0o077)
    DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    DATA.chmod(0o700)
    with connect() as c:
        c.execute('CREATE TABLE IF NOT EXISTS takes (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
        c.execute('CREATE TABLE IF NOT EXISTS recipes (name TEXT PRIMARY KEY, data TEXT NOT NULL)')
        for row in c.execute('SELECT id,data FROM takes').fetchall():
            t = json.loads(row['data'])
            if t['status'] in ('running', 'queued'):
                t.update(status='interrupted', error='Bench restarted. This take was not automatically retried; Studio may still be working.')
                c.execute('UPDATE takes SET data=? WHERE id=?', (json.dumps(t), t['id']))

def items(table):
    with LOCK, connect() as c:
        return [json.loads(r['data']) for r in c.execute('SELECT data FROM '+table+' ORDER BY rowid DESC')]

def save_take(t):
    with connect() as c:
        c.execute('INSERT OR REPLACE INTO takes VALUES (?,?)', (t['id'], json.dumps(t)))

def get_take(id):
    with connect() as c:
        r = c.execute('SELECT data FROM takes WHERE id=?', (id,)).fetchone()
    if not r: raise ValueError('Take not found')
    return json.loads(r['data'])

def validate(d):
    if not isinstance(d, dict): raise ValueError('Recipe must be an object')
    allowed = {'text','instruct','language','seed','num_step','speed','guidance_scale','effect_preset','label'}
    if set(d)-allowed: raise ValueError('Unsupported recipe field')
    p = {'text':'', 'instruct':'', 'language':'en', 'seed':42, 'num_step':16, 'speed':1.0, 'guidance_scale':2.0, 'effect_preset':'raw', 'label':'Untitled take'}
    p.update(d)
    for k, maximum in [('text',2000),('instruct',800),('language',20),('label',100)]:
        if not isinstance(p[k],str) or len(p[k])>maximum: raise ValueError(k+' exceeds its limit')
    if not p['text'].strip(): raise ValueError('Enter a test passage')
    categories = [set(x.split('|')) for x in ['male|female','child|teenager|young adult|middle-aged|elderly','very low pitch|low pitch|moderate pitch|high pitch|very high pitch','whisper','american accent|british accent|australian accent|chinese accent|canadian accent|indian accent|korean accent|portuguese accent|russian accent|japanese accent']]
    tags = [x.strip().lower() for x in p['instruct'].split(',') if x.strip()]
    if set(tags)-set.union(*categories): raise ValueError('Use supported voice tags, not prose. See the voice-tag guide beneath Voice direction.')
    if any(len(set(tags)&c)>1 for c in categories): raise ValueError('Choose only one gender, age, pitch and accent tag per recipe')
    p['instruct'] = ', '.join(dict.fromkeys(tags))
    if p['language'] not in ['Auto','en','es','fr','de','it','pt','ja','ko','zh','ru','ar','hi']: raise ValueError('Unsupported language')
    for k,lo,hi,integer in [('seed',0,2147483647,True),('num_step',1,64,True),('speed',0.5,2.0,False),('guidance_scale',0,5,False)]:
        v = p[k]
        if isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or not lo<=v<=hi or (integer and int(v)!=v): raise ValueError('Invalid '+k)
        if integer:p[k]=int(v)
    if p['effect_preset'] not in ('raw','broadcast'):raise ValueError('Unsupported effect')
    return p

def enqueue(p):
    global PAUSED
    with LOCK:
        if PAUSED: raise ValueError('Queue paused after uncertain upstream failure. Check Studio before restarting the bench.')
        if sum(t['status'] in ('queued','running') for t in items('takes')) >= 8:raise ValueError('Queue limit is eight takes')
        if len(items('takes'))>=500:raise ValueError('Bench limit reached (500 takes); archive data before continuing')
        t = {'id':uuid.uuid4().hex,'recipe':validate(p),'status':'queued','created':time.time(),'notes':'','favorite':False}
        save_take(t)
    WAKE.set()
    return t

def upstream_json(path):
    with HTTP.open(UPSTREAM+path,timeout=5) as r: return json.loads(r.read(65536))

def worker():
    global PAUSED
    while True:
        WAKE.wait(2);WAKE.clear()
        with LOCK:
            pending=[t for t in reversed(items('takes')) if t['status']=='queued']
            if PAUSED or not pending:continue
            t=pending[0];t.update(status='running',started=time.time());save_take(t)
        try:
            payload={k:v for k,v in t['recipe'].items() if k!='label'}
            if payload['language']=='Auto':payload.pop('language')
            payload.update(denoise='true',postprocess_output='true')
            req=urllib.request.Request(UPSTREAM+'/generate',data=urllib.parse.urlencode(payload).encode(),headers={'Content-Type':'application/x-www-form-urlencoded'},method='POST')
            with HTTP.open(req,timeout=1800) as response:
                raw=response.read(32_000_001)
                if len(raw)>32_000_000:raise ValueError('Audio exceeded 32 MB')
                if raw[:4]!=b'RIFF' or raw[8:12]!=b'WAVE':raise ValueError('Studio did not return WAV audio')
                with wave.open(io.BytesIO(raw),'rb') as w:
                    meta={'duration':round(w.getnframes()/w.getframerate(),3),'sample_rate':w.getframerate(),'channels':w.getnchannels()}
                meta['studio_id']=response.headers.get('X-Audio-Id','')
            tmp=DATA/(t['id']+'.tmp');tmp.write_bytes(raw);tmp.replace(DATA/(t['id']+'.wav'))
            with LOCK:
                t=get_take(t['id']);t.update(status='done',finished=time.time(),elapsed=round(time.time()-t['started'],2),audio=meta);save_take(t)
        except Exception as e:
            if isinstance(e,urllib.error.HTTPError):
                try: message=json.loads(e.read(4096)).get('detail','Studio rejected the request')
                except Exception:message='Studio HTTP '+str(e.code)
            else:
                message=str(e)[:700]
                # An upstream timeout can leave inference running. Never send another request blindly.
                PAUSED=True
            with LOCK:
                t=get_take(t['id']);t.update(status='error',error=str(message)[:1000],finished=time.time(),elapsed=round(time.time()-t['started'],2));save_take(t)
        WAKE.set()

def issue_token():
    body=(str(int(time.time())+86400)+'.'+secrets.token_hex(16)).encode()
    return body.decode()+'.'+hmac.new(SECRET,body,hashlib.sha256).hexdigest()

def valid_token(s):
    try:
        expiry,nonce,signature=s.split('.')
        body=(expiry+'.'+nonce).encode()
        return int(expiry)>time.time() and hmac.compare_digest(signature,hmac.new(SECRET,body,hashlib.sha256).hexdigest())
    except Exception:return False

class Handler(BaseHTTPRequestHandler):
    server_version='OmniBench/1'
    def log_message(self,*args):pass
    def identity(self):
        return self.client_address[0]=='127.0.0.1' and self.headers.get('Tailscale-User-Login')==OWNER
    def reply(self,code,data,kind='application/json',cors=False):
        if isinstance(data,(dict,list)):data=json.dumps(data).encode()
        elif isinstance(data,str):data=data.encode()
        self.send_response(code)
        self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(data)))
        self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.send_header('Referrer-Policy','no-referrer')
        if cors:
            origin=self.headers.get('Origin','')
            if origin in ('null',ORIGIN):self.send_header('Access-Control-Allow-Origin',origin)
            self.send_header('Vary','Origin')
        if kind=='text/html':
            self.send_header('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src "+ORIGIN+" http://127.0.0.1:"+str(PORT)+"; media-src blob:; img-src data:; base-uri 'none'; form-action 'none'")
        self.end_headers();self.wfile.write(data)
    def do_OPTIONS(self):
        if not self.identity() or not self.path.startswith('/api/'):return self.reply(403,{'error':'Private bench'})
        origin=self.headers.get('Origin','')
        if origin not in ('null',ORIGIN):return self.reply(403,{'error':'Origin denied'})
        self.send_response(204);self.send_header('Access-Control-Allow-Origin',origin);self.send_header('Access-Control-Allow-Methods','GET, POST');self.send_header('Access-Control-Allow-Headers','Content-Type, X-Bench-Token');self.send_header('Vary','Origin');self.end_headers()
    def do_GET(self):self.route('GET')
    def do_POST(self):self.route('POST')
    def route(self,method):
        path=urllib.parse.urlsplit(self.path).path
        if method=='GET' and path=='/health':return self.reply(200,{'ok':True,'release':os.environ.get('ORBIT_EXTENSION_RELEASE','dev')})
        if not self.identity():return self.reply(403,{'error':'Only the owner’s authenticated Tailscale identity may access this bench.'})
        if method=='GET' and path in ('/','/index.html'):
            html=(ROOT/'index.html').read_text().replace('__BENCH_TOKEN__',issue_token())
            return self.reply(200,html,'text/html')
        if method=='GET' and path in ('/app.js','/style.css'):
            return self.reply(200,(ROOT/path[1:]).read_bytes(),'text/javascript' if path.endswith('.js') else 'text/css')
        if not path.startswith('/api/'):return self.reply(404,{'error':'Not found'})
        if not valid_token(self.headers.get('X-Bench-Token','')):return self.reply(403,{'error':'Session expired. Reload the bench.'},cors=True)
        try:
            if method=='GET':
                if path=='/api/state':return self.reply(200,{'takes':items('takes'),'recipes':items('recipes'),'paused':PAUSED},cors=True)
                if path=='/api/status':
                    try:
                        h=upstream_json('/health');m=upstream_json('/model/status')
                        d={'online':True,'device':h.get('device','unknown'),'model':m.get('status'),'detail':m.get('detail'),'error':m.get('error')}
                    except Exception:d={'online':False,'detail':'Studio unreachable on local port 3900'}
                    return self.reply(200,d,cors=True)
                match=re.fullmatch(r'/api/audio/([a-f0-9]{32})',path)
                if match:
                    t=get_take(match[1])
                    if t['status']!='done':raise ValueError('Audio not ready')
                    return self.reply(200,(DATA/(t['id']+'.wav')).read_bytes(),'audio/wav',cors=True)
            else:
                length=int(self.headers.get('Content-Length','0'))
                if not 0<length<=16000:raise ValueError('Invalid request size')
                if self.headers.get('Content-Type','').split(';')[0]!='application/json':raise ValueError('JSON required')
                d=json.loads(self.rfile.read(length))
                if not isinstance(d,dict):raise ValueError('Object required')
                if path=='/api/takes':return self.reply(201,enqueue(d),cors=True)
                if path=='/api/recipes':
                    if set(d)!= {'name','recipe'}:raise ValueError('Expected name and recipe')
                    name=d['name']
                    if not isinstance(name,str) or not 1<=len(name.strip())<=80:raise ValueError('Name required, maximum 80 characters')
                    p={'name':name.strip(),'recipe':validate(d['recipe'])}
                    with LOCK,connect() as c:
                        if len(items('recipes'))>=100:raise ValueError('Recipe limit reached')
                        c.execute('INSERT OR REPLACE INTO recipes VALUES (?,?)',(p['name'],json.dumps(p)))
                    return self.reply(200,p,cors=True)
                match=re.fullmatch(r'/api/takes/([a-f0-9]{32})',path)
                if match:
                    with LOCK:
                        t=get_take(match[1])
                        if set(d)-{'notes','favorite','cancel'}:raise ValueError('Unsupported take update')
                        if 'notes' in d:
                            if not isinstance(d['notes'],str) or len(d['notes'])>2000:raise ValueError('Notes too long')
                            t['notes']=d['notes']
                        if 'favorite' in d:
                            if not isinstance(d['favorite'],bool):raise ValueError('Favorite must be boolean')
                            t['favorite']=d['favorite']
                        if d.get('cancel'):
                            if t['status']!='queued':raise ValueError('Only queued takes can be cancelled. Running inference cannot be stopped here.')
                            t['status']='cancelled'
                        save_take(t)
                    return self.reply(200,t,cors=True)
            return self.reply(404,{'error':'Not found'},cors=True)
        except (ValueError,TypeError,KeyError,json.JSONDecodeError) as e:return self.reply(400,{'error':str(e)},cors=True)
        except Exception:return self.reply(500,{'error':'Bench storage or service error'},cors=True)

if __name__=='__main__':
    initialize()
    threading.Thread(target=worker,daemon=True).start()
    server=ThreadingHTTPServer(('127.0.0.1',PORT),Handler)
    server.serve_forever()
