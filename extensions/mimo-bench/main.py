"""Owner-authenticated, bounded MiMo benchmark. No arbitrary endpoints or prompts."""
import os, sys, json, time, threading, uuid, math, urllib.request, urllib.error
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
ROOT=Path('/home/mojo/.hermes-instances/fresh/workspace/orbitdesktop')
sys.path.insert(0,str(ROOT/'extensions/orbit-secrets'))
from vault import Vault
sys.path.insert(0,str(Path(__file__).parent))
import voice
ORIGIN='https://kimi.tailec998.ts.net:4366'
MODEL='mimo-v2.6-flash'
MODELS=['mimo-v2.6-flash','mimo-v2.6-pro','mimo-v2.6-pro-ultraspeed','mimo-v2.5','mimo-v2.5-pro']
AUDIO_MODELS=['mimo-v2.5-asr','mimo-v2.5-tts','mimo-v2.5-tts-voiceclone','mimo-v2.5-tts-voicedesign']
ENDPOINT='https://api.xiaomimimo.com/v1/chat/completions'
STORE=ROOT/'.runtime/mimo-bench'
LOCK=threading.RLock()
RUNS=[]
STOP=threading.Event()
PROMPTS={'latency':'Reply with exactly the word READY.', 'throughput':'Write a detailed factual explanation of how a bicycle works, using complete sentences. Continue until you have described all its major components.', 'json':'Return only valid JSON, no markdown, exactly this object: {"color":"blue","count":3,"ok":true}'}
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None

def config(d):
    if not isinstance(d,dict) or set(d)-{'samples','concurrency','max_tokens','preset','thinking','model'} or not {'samples','concurrency','max_tokens','preset','thinking'}<=set(d): raise ValueError()
    if d.get('model',MODEL) not in MODELS+['all']: raise ValueError()
    for k,lo,hi in [('samples',1,20),('concurrency',1,4),('max_tokens',32,1024)]:
        if type(d[k]) is not int or not lo<=d[k]<=hi: raise ValueError()
    if d['preset'] not in PROMPTS or d['thinking'] not in ('enabled','disabled'): raise ValueError()
    return d

def sample(c,key,i):
    start=time.perf_counter(); first=None; content_first=None; text=''; usage=None; finish=None; done=False
    out={'index':i+1,'ok':False,'ttft_ms':None,'answer_ms':None,'tokens':None,'tokens_per_second':None,'quality_pass':None}
    out['model']=c.get('model',MODEL)
    body={'model':out['model'],'messages':[{'role':'user','content':PROMPTS[c['preset']]}],'stream':True,'max_completion_tokens':c['max_tokens'],'thinking':{'type':c['thinking']}}
    try:
        req=urllib.request.Request(ENDPOINT,data=json.dumps(body).encode(),headers={'api-key':key,'Content-Type':'application/json'})
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        size=0
        with opener.open(req,timeout=45) as response:
            for raw in response:
                now=time.perf_counter()
                size+=len(raw)
                if now-start>120 or size>2000000: raise TimeoutError()
                if not raw.startswith(b'data:'): continue
                raw=raw[5:].strip()
                if raw==b'[DONE]': done=True; break
                if not raw: continue
                event=json.loads(raw)
                if event.get('error'): raise ValueError()
                if event.get('usage'): usage=event['usage']
                for choice in event.get('choices',[]):
                    delta=choice.get('delta') or {}
                    if delta.get('content') or delta.get('reasoning_content'):
                        if first is None: first=now
                    if delta.get('content'):
                        if content_first is None: content_first=now
                        text+=delta['content']
                    if choice.get('finish_reason'): finish=choice['finish_reason']
        if not done or finish is None: raise ValueError()
        elapsed=time.perf_counter()-start
        tokens=(usage or {}).get('completion_tokens')
        out.update(ok=True,ttft_ms=round((first-start)*1000,2) if first else None,answer_ms=round((content_first-start)*1000,2) if content_first else None,tokens=tokens,tokens_per_second=round(tokens/elapsed,2) if type(tokens) is int else None,usage=usage,finish_reason=finish,output=text[:12000])
        if c['preset']=='latency': out['quality_pass']=text.strip()=='READY'
        if c['preset']=='json':
            try: out['quality_pass']=json.loads(text)=={'color':'blue','count':3,'ok':True}
            except ValueError: out['quality_pass']=False
    except urllib.error.HTTPError as e: out['error']='Provider HTTP '+str(e.code)
    except Exception: out['error']='Network timeout, incomplete stream, or invalid provider response'
    out['elapsed_ms']=round((time.perf_counter()-start)*1000,2)
    return out

def percentile(values,p):
    a=sorted(values)
    if not a:return None
    return a[max(0,math.ceil(len(a)*p)-1)]

def summary(run):
    rows=run['results']; good=[r for r in rows if r['ok']]
    t=[r['ttft_ms'] for r in good if r['ttft_ms'] is not None]
    lat=[r['elapsed_ms'] for r in good]
    scored=[r['quality_pass'] for r in good if r['quality_pass'] is not None]
    rates=[r['tokens_per_second'] for r in good if r['tokens_per_second'] is not None]
    return {'completed':len(rows),'successful':len(good),'error_rate':(len(rows)-len(good))/len(rows) if rows else None,'ttft_p50_ms':percentile(t,.5),'ttft_p95_ms':percentile(t,.95),'latency_p50_ms':percentile(lat,.5),'latency_p95_ms':percentile(lat,.95),'throughput_p50':percentile(rates,.5),'quality_passed':sum(scored),'quality_scored':len(scored),'output_tokens':sum(r.get('tokens') or 0 for r in rows),'usage_missing':sum(r.get('tokens') is None for r in good)}

def save():
    STORE.mkdir(mode=0o700,parents=True,exist_ok=True)
    tmp=STORE/'results.tmp';tmp.write_text(json.dumps(RUNS));tmp.chmod(0o600);tmp.replace(STORE/'results.json')

def execute(run):
    try:
        key=Vault().get('MIMO_API_KEY')
        models=MODELS if run['config'].get('model')=='all' else [run['config'].get('model',MODEL)]
        def worker(task):
            i,model=task
            if STOP.is_set():return
            row=sample(dict(run['config'],model=model),key,i)
            with LOCK:
                run['results'].append(row);save()
        # Rotate the model order between rounds to reduce fixed-order bias.
        tasks=[(i,models[(j+i)%len(models)]) for i in range(run['config']['samples']) for j in range(len(models))]
        with ThreadPoolExecutor(max_workers=run['config']['concurrency']) as pool:list(pool.map(worker,tasks))
        with LOCK:run['status']='stopped' if STOP.is_set() else 'finished'
    except Exception:
        with LOCK:run['status']='failed';run['error']='Unable to load vault key or complete benchmark.'
    finally:
        with LOCK:run['ended']=time.time();save()

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def reply(self,status,data,kind='application/json'):
        raw=json.dumps(data).encode() if kind=='application/json' else data
        self.send_response(status)
        for k,v in {'Content-Type':kind,'Content-Length':str(len(raw)),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors https://kimi.tailec998.ts.net:4325"}.items():self.send_header(k,v)
        self.end_headers();self.wfile.write(raw)
    def auth(self):
        if self.headers.get('Host') not in ('kimi.tailec998.ts.net:4366','127.0.0.1:'+str(self.server.server_port)) or self.headers.get('Tailscale-User-Login')!='mojomasta@gmail.com':
            self.reply(403,{'error':'Owner tailnet authentication required'});return False
        return True
    def do_GET(self):
        if self.path=='/health':return self.reply(200,{'ok':True,'release':os.environ.get('ORBIT_EXTENSION_RELEASE','test')})
        if not self.auth():return
        if self.path in ('/','/app.js','/voice.js'):
            return self.reply(200,(Path(__file__).parent/('index.html' if self.path=='/' else self.path[1:])).read_bytes(),'text/html; charset=utf-8' if self.path=='/' else 'text/javascript')
        if self.path=='/api/runs':
            with LOCK:return self.reply(200,{'model':MODEL,'models':MODELS,'audio_models':AUDIO_MODELS,'runs':[dict(r,summary=summary(r),comparison={model:summary({'results':[x for x in r['results'] if x.get('model',r.get('model',MODEL))==model]}) for model in (MODELS if r['config'].get('model')=='all' else [r.get('model',MODEL)])}) for r in reversed(RUNS)]})
        return self.reply(404,{'error':'Not found'})
    def do_POST(self):
        if not self.auth():return
        if self.headers.get('Origin')!=ORIGIN or self.headers.get('Content-Type')!='application/json':return self.reply(403,{'error':'Origin or content type rejected'})
        if self.path=='/api/voice':
            acquired=False
            try:
                n=int(self.headers.get('Content-Length','0'))
                if not 0<n<8_020_000:raise ValueError('Request too large')
                self.connection.settimeout(20)
                body=voice.payload(json.loads(self.rfile.read(n)))
                acquired=voice.GATE.acquire(blocking=False)
                if not acquired:return self.reply(409,{'error':'A voice request is already running'})
                result=voice.call(body,Vault().get('MIMO_API_KEY'),urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect()))
                return self.reply(200,result)
            except ValueError as e:return self.reply(400,{'error':'Invalid voice request or response: '+str(e)[:150] if str(e) in ('Enter text to speak','Describe the voice to design','Confirm permission to clone this voice','Authorize paid API calls and data transmission') else 'Invalid voice input or provider response'})
            except urllib.error.HTTPError as e:return self.reply(502,{'error':'Provider HTTP '+str(e.code)})
            except Exception:return self.reply(502,{'error':'Voice provider timeout or invalid response'})
            finally:
                if acquired:voice.GATE.release()
        try:
            n=int(self.headers.get('Content-Length','0'))
            if not 0<n<4096:raise ValueError()
            self.connection.settimeout(10);d=json.loads(self.rfile.read(n))
            with LOCK:
                if self.path=='/api/stop':
                    if d!={}:raise ValueError()
                    STOP.set();return self.reply(200,{'ok':True})
                if self.path!='/api/run':return self.reply(404,{'error':'Not found'})
                c=config(d)
                if any(r['status']=='running' for r in RUNS):return self.reply(409,{'error':'A benchmark is already running'})
                STOP.clear()
                run={'id':uuid.uuid4().hex,'started':time.time(),'status':'running','model':c.get('model',MODEL),'config':c,'results':[]}
                RUNS.append(run);del RUNS[:-50];save()
                threading.Thread(target=execute,args=(run,),daemon=True).start()
                return self.reply(202,{'id':run['id']})
        except (ValueError,TypeError,KeyError):return self.reply(400,{'error':'Invalid benchmark configuration'})
        except Exception:return self.reply(500,{'error':'Local benchmark service failure'})

if __name__=='__main__':
    os.umask(0o077)
    if (STORE/'results.json').exists():
        RUNS=json.loads((STORE/'results.json').read_text())[-50:]
        for r in RUNS:
            if r['status']=='running':r['status']='interrupted'
    ThreadingHTTPServer(('127.0.0.1',int(os.environ['ORBIT_EXTENSION_PORT'])),Handler).serve_forever()
