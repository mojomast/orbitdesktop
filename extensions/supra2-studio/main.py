"""Owner-only Supra2 service with a bounded, idle-unloading warm worker."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from warm import WarmWorker
WORKER = WarmWorker()
import json, math, os, re, subprocess, threading, time, uuid
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = Path('/home/mojo/.hermes-instances/fresh/workspace/supra2-service')
OUT = BASE / 'studio-outputs'
ORIGIN = 'https://kimi.tailec998.ts.net:4363'
OWNER = 'mojomasta@gmail.com'
LOCK = threading.Lock()
JOBS = {}
BUSY = False
RETAIN = 256

def save_history():
    # Called with LOCK held; private metadata never enters the public bundle.
    temp = OUT / 'history.tmp'
    temp.write_text(json.dumps(list(JOBS.values())))
    temp.chmod(0o600)
    temp.replace(OUT / 'history.json')

def load_history():
    path = OUT / 'history.json'
    if not path.exists(): return
    for job in json.loads(path.read_text())[-RETAIN:]:
        if job['status'] in ('running','queued'):
            job.update(status='cancelled',error='Interrupted by service restart; not resumed.')
        job.setdefault('batch', 'previous-session')
        if job['status'] != 'done' or (OUT / (job['id']+'.png')).is_file():
            JOBS[job['id']] = job

def expand(d):
    import secrets
    if not isinstance(d, dict) or set(d) != {'prompt','count','steps','guidance'}:
        raise ValueError('Expected prompt, count, steps and guidance only.')
    if type(d['count']) is not int or not 1 <= d['count'] <= 32:
        raise ValueError('Seed count must be 1–32.')
    if any(not isinstance(d[k], list) or not 1 <= len(d[k]) <= 8 for k in ('steps','guidance')):
        raise ValueError('Supply 1–8 values for steps and guidance.')
    if d['count'] * len(d['steps']) * len(d['guidance']) > 128:
        raise ValueError('At most 128 images per batch.')
    seeds = set()
    while len(seeds) < d['count']: seeds.add(secrets.randbelow(2147483648))
    return [validate(dict(prompt=d['prompt'],seed=seed,steps=steps,cfg=cfg))
            for seed in seeds for steps in d['steps'] for cfg in d['guidance']]

def run_batch(ids):
    global BUSY
    try:
        for job_id in ids:
            with LOCK:
                if JOBS[job_id]['status'] == 'cancelled': continue
                JOBS[job_id].update(status='running', started=time.time())
                d = {k:JOBS[job_id][k] for k in ('prompt','seed','steps','cfg')}
            run(job_id, d)
            with LOCK: save_history()
    finally:
        with LOCK: BUSY = False

def validate(d):
    if not isinstance(d, dict) or set(d) != {'prompt','seed','steps','cfg'}:
        raise ValueError('Expected prompt, seed, steps and cfg only.')
    if not isinstance(d['prompt'], str) or not 1 <= len(d['prompt'].strip()) <= 1000:
        raise ValueError('Prompt must contain 1–1000 characters.')
    for key, lo, hi in [('seed',0,2147483647),('steps',1,100)]:
        if type(d[key]) is not int or not lo <= d[key] <= hi:
            raise ValueError(f'{key} must be an integer from {lo} to {hi}.')
    if type(d['cfg']) not in (int,float) or not math.isfinite(d['cfg']) or not 1 <= d['cfg'] <= 10:
        raise ValueError('Guidance must be from 1 to 10.')
    return d

def run(job_id, d):
    global BUSY
    start = time.monotonic()
    path = OUT / (job_id + '.png')
    try:
        result = WORKER.generate(dict(d, out=str(path)))
        if not path.is_file() or path.read_bytes()[:8] != b'\x89PNG\r\n\x1a\n':
            raise RuntimeError('Generation failed. Check available memory and the local Supra2 installation.')
        for old in sorted(OUT.glob('*.png'), key=lambda p: p.stat().st_mtime)[:-RETAIN]:
            old.unlink(missing_ok=True)
        with LOCK:
            JOBS[job_id].update(status='done', seconds=round(time.monotonic()-start,2), image='/images/'+job_id+'.png', warm=result['warm'], threads=result['threads'], generation_seconds=result['generation_seconds'], prompt_cache_hit=result.get('prompt_cache_hit', False), prompt_encode_seconds=result.get('prompt_encode_seconds'))
    except subprocess.TimeoutExpired:
        with LOCK: JOBS[job_id].update(status='failed', error='Generation exceeded the 240-second limit.')
    except Exception:
        with LOCK: JOBS[job_id].update(status='failed', error='Generation failed. Check available memory and the local Supra2 installation.')

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def reply(self, code, data, kind='application/json'):
        if kind == 'application/json': data = json.dumps(data).encode()
        self.send_response(code)
        self.send_header('Content-Type',kind)
        self.send_header('Content-Length',str(len(data)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; frame-ancestors https://kimi.tailec998.ts.net:4325 http://127.0.0.1:4334")
        self.end_headers()
        try: self.wfile.write(data)
        except (BrokenPipeError,ConnectionResetError): pass
    def authenticated(self):
        # Only loopback listener; Tailscale Serve strips and supplies this identity.
        if self.headers.get('Tailscale-User-Login') != OWNER:
            self.reply(403, {'error':'Open through the owner’s authenticated tailnet connection.'})
            return False
        return True
    def do_GET(self):
        if self.path == '/health':
            return self.reply(200, {'ok':True,'release':os.environ.get('ORBIT_EXTENSION_RELEASE','test')})
        if not self.authenticated(): return
        if self.path in ('/','/app.js'):
            file = 'index.html' if self.path == '/' else 'app.js'
            return self.reply(200,(Path(__file__).parent/file).read_bytes(), 'text/html; charset=utf-8' if file.endswith('html') else 'text/javascript')
        if self.path == '/api/status':
            with LOCK: result = {'busy':BUSY, 'device':'CPU', 'mode':'Warm worker; unloads after 10 minutes idle', 'worker':WORKER.status(), 'jobs':list(JOBS.values())[::-1]}
            return self.reply(200,result)
        if re.fullmatch(r'/images/[0-9a-f]{32}\.png', self.path):
            path = OUT / self.path.rsplit('/',1)[1]
            if path.is_file(): return self.reply(200,path.read_bytes(),'image/png')
        self.reply(404,{'error':'Not found'})
    def do_POST(self):
        global BUSY
        if not self.authenticated(): return
        if self.headers.get('Origin') != ORIGIN or self.headers.get('Content-Type') != 'application/json':
            return self.reply(403,{'error':'Invalid origin or content type'})
        if self.path == '/api/cancel':
            with LOCK:
                for job in JOBS.values():
                    if job['status'] == 'queued': job['status'] = 'cancelled'
                save_history()
            return self.reply(200, {'ok':True})
        if self.path not in ('/api/generate','/api/batch'): return self.reply(404,{'error':'Not found'})
        try:
            n = int(self.headers.get('Content-Length','0'))
            if not 0 < n <= 8192: raise ValueError('Request too large or empty')
            data = json.loads(self.rfile.read(n))
            items = expand(data) if self.path == '/api/batch' else [validate(data)]
        except (ValueError,UnicodeError) as e:
            return self.reply(400,{'error':str(e)})
        with LOCK:
            if BUSY: return self.reply(429,{'error':'A batch is already running. Wait or cancel its queued images.'})
            BUSY = True
            batch_id = uuid.uuid4().hex
            ids = []
            while len(JOBS) + len(items) > RETAIN:
                old = next(iter(JOBS)); JOBS.pop(old); (OUT/(old+'.png')).unlink(missing_ok=True)
            for d in items:
                job_id = uuid.uuid4().hex
                ids.append(job_id)
                JOBS[job_id] = dict(d,id=job_id,batch=batch_id,status='queued',created=time.time())
            save_history()
        threading.Thread(target=run_batch,args=(ids,),daemon=True).start()
        self.reply(202,{'id':ids[0], 'batch':batch_id, 'ids':ids})

if __name__ == '__main__':
    OUT.mkdir(mode=0o700,parents=True,exist_ok=True)
    load_history()
    # Disk retention is bounded across restarts too; in-memory history is session-only.
    for p in sorted(OUT.glob('*.png'),key=lambda p:p.stat().st_mtime)[:-RETAIN]: p.unlink()
    ThreadingHTTPServer(('127.0.0.1',int(os.environ.get('ORBIT_EXTENSION_PORT','8674'))),Handler).serve_forever()
