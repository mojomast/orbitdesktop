"""Private Graphics Lab UI and recipe store; inherits digest-gated draft workflow."""
import json,math,os,re,uuid
import importlib.util
from pathlib import Path
_spec=importlib.util.spec_from_file_location('graphics_backend',Path(__file__).with_name('backend.py'))
B=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(B)
from http.server import ThreadingHTTPServer
RANGES={'exposure':(.3,2.5),'bloom':(0,2),'saturation':(0,2),'contrast':(.5,1.8),'tintMix':(0,.65),'vignette':(0,1),'chromatic':(0,.012),'grain':(0,.15),'scanlines':(0,.35),'pixelSize':(1,12),'warp':(0,.15),'fov':(40,105)}
def validate(d):
 if not isinstance(d,dict) or d.get('schema')!=1:raise ValueError('Recipe schema 1 required')
 r=d.get('recipe',{})
 if not isinstance(r,dict):raise ValueError('Invalid recipe')
 for k,(lo,hi) in RANGES.items():
  v=r.get(k)
  if type(v) not in (int,float) or not math.isfinite(v) or not lo<=v<=hi:raise ValueError('Invalid '+k)
 if not re.fullmatch('#[a-fA-F0-9]{6}',str(r.get('tint',''))):raise ValueError('Invalid tint')
 if not isinstance(d.get('name'),str) or not 1<=len(d['name'])<=80:raise ValueError('Recipe name required')
 if not isinstance(d.get('context'),dict):raise ValueError('Context required')
 return {k:d[k] for k in ('schema','name','source','recipe','context','camera') if k in d}
class Handler(B.Handler):
 def do_GET(self):
  path=self.path.split('?')[0]
  if path in ('/','/app.js','/style.css'):
   if not self.identity():return self.reply(403,{'error':'Owner Tailscale identity required'})
   p=B.ROOT/('index.html' if path=='/' else path[1:])
   if path=='/':return self.reply(200,p.read_text().replace('__SESSION_TOKEN__',B.token()),'text/html',True)
   return self.reply(200,p.read_bytes(),'text/javascript' if path.endswith('.js') else 'text/css',True)
  return super().do_GET()
 def do_POST(self):
  if self.path!='/recipes':return super().do_POST()
  if not self.identity() or not B.valid(self.headers.get('X-Workshop-Token','')):return self.reply(403,{'error':'Unauthorized or expired session'},cors=True)
  try:
   n=int(self.headers.get('Content-Length','0'))
   if not 0<n<=32000:raise ValueError('Invalid request size')
   d=json.loads(self.rfile.read(n));directory=B.DATA/'recipes'
   with B.LOCK:
    directory.mkdir(exist_ok=True,mode=0o700)
    if d.get('op')=='recipes':result=[json.loads(p.read_text()) for p in sorted(directory.glob('*.json'),key=lambda p:p.stat().st_mtime,reverse=True)]
    elif d.get('op')=='saveRecipe':
     if len(list(directory.glob('*.json')))>=500:raise ValueError('Recipe library limit reached; export and archive recipes first')
     result=validate(d.get('recipe'));result['id']=uuid.uuid4().hex
     (directory/(result['id']+'.json')).write_text(json.dumps(result,allow_nan=False))
    else:raise ValueError('Unknown recipe action')
   self.reply(200,result,cors=True)
  except Exception as e:self.reply(400,{'error':str(e)[:1000]},cors=True)
if __name__=='__main__':
 B.initialize();ThreadingHTTPServer(('127.0.0.1',int(os.environ.get('ORBIT_EXTENSION_PORT','4414'))),Handler).serve_forever()
