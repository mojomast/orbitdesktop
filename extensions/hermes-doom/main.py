"""Private Orbit Doom service. Isolated engine, frozen copied policy, opt-in Jev."""
import base64, json, os, secrets, sys, threading, time, urllib.request
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
ROOT=Path(__file__).resolve().parent
CONFIG_PATH=next((p/'hermes-doom/config.json' for p in ROOT.parents if p.name=='.runtime'), ROOT/'config.json')
CONFIG={}; SESSIONS={}; LOGINS=[]; AUTH_LOCK=threading.Lock()
STATE=None; JEV=None

def observation(game, frame, stuck, map_name):
    import engine as e
    x,y,angle=e.get_player_position(game)
    labels=[]
    for label in list(frame.labels)[:24]:
        labels.append({'name':label.object_name[:60],'category':str(getattr(label,'object_category','unknown'))[:30],'x':int(label.x),'y':int(label.y),'width':int(label.width),'height':int(label.height)})
    depth=frame.depth_buffer
    return {'map':map_name,'health':float(game.get_game_variable(e.vzd.GameVariable.HEALTH)),'ammo':float(game.get_game_variable(e.vzd.GameVariable.SELECTED_WEAPON_AMMO)), 'position':[round(x,1),round(y,1)],'angle':round(angle,1),'stuck_ticks':stuck,'screen_width':int(frame.screen_buffer.shape[-1]),'visible_objects':labels,'depth_sectors':[] if depth is None else [round(float(part.mean()),1) for part in __import__('numpy').array_split(depth,5,axis=1)]}

def setup_engine():
    global STATE,JEV
    import engine as e
    from jev import Controller
    if e.vzd is None or e.Image is None:raise RuntimeError('ViZDoom and Pillow required; no fake game fallback')
    e.DOOM_SHAREWARE_WAD=Path(CONFIG['wad'])
    e.LEARNING_POLICY_PATH=Path(CONFIG['policy'])
    STATE=e.DoomState(); STATE.paused=True
    STATE.controls.update(freeze_learning=True,self_improve=True)
    JEV=Controller()
    def choose(game,frame,fallback,stuck,map_name):
        buttons={str(b).split('.')[-1] for b in game.get_available_buttons()}
        actions={k:v for k,v in e.LEARNED_ACTIONS.items() if set(v)<=buttons}
        obs=observation(game,frame,stuck,map_name)
        with STATE.lock:STATE.status['observation']=obs
        return JEV.choose(obs,actions,fallback)
    STATE.select_action=choose
    def run():
        try:e.run_vizdoom_loop(STATE)
        except Exception as exc:
            STATE.paused=True; STATE.set_frame(b'',mode='error',message='Game engine failed: '+type(exc).__name__)
            JEV.disable('Engine stopped')
    threading.Thread(target=run,daemon=True).start()

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def send(self,status,data,mime='application/json'):
        raw=json.dumps(data,allow_nan=False).encode() if mime=='application/json' else data
        self.send_response(status)
        for k,v in {'Content-Type':mime,'Content-Length':str(len(raw)),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors "+CONFIG['orbit_origin']}.items():self.send_header(k,v)
        self.end_headers(); self.wfile.write(raw)
    def host(self):return self.headers.get('Host') in {urlsplit(CONFIG['public_origin']).netloc,f'127.0.0.1:{self.server.server_port}'}
    def do_GET(self):
        if not self.host():return self.send(403,{'error':'Host rejected'})
        if self.path=='/health':return self.send(200,{'ok':True,'release':os.environ.get('ORBIT_EXTENSION_RELEASE','dev')})
        files={'/':('index.html','text/html'),'/app.js':('app.js','text/javascript'),'/style.css':('style.css','text/css')}
        if self.path not in files:return self.send(404,{'error':'Not found'})
        name,mime=files[self.path];self.send(200,(ROOT/name).read_bytes(),mime)
    def do_POST(self):
        if not self.host() or self.headers.get('Origin')!=CONFIG['public_origin']:return self.send(403,{'error':'Origin rejected'})
        try:
            n=int(self.headers.get('Content-Length','0'))
            if not 0<n<=4096 or self.headers.get('Content-Type')!='application/json':raise ValueError()
            data=json.loads(self.rfile.read(n))
            if not isinstance(data,dict):raise ValueError()
            if self.path=='/api/unlock':
                now=time.time()
                with AUTH_LOCK:
                    LOGINS[:]=[t for t in LOGINS if now-t<60]
                    if len(LOGINS)>=10:return self.send(429,{'error':'Wait a minute before retrying'})
                    LOGINS.append(now)
                token=data.get('token')
                if not isinstance(token,str) or not 32<=len(token)<=512:return self.send(401,{'error':'Invalid host token'})
                try:
                    req=urllib.request.Request(CONFIG['orbit_auth_url'],data=json.dumps({'token':token}).encode(),headers={'Content-Type':'application/json','Origin':CONFIG['orbit_origin']})
                    with urllib.request.urlopen(req,timeout=10) as r:valid=json.load(r).get('ok') is True
                    if not valid:raise ValueError()
                except Exception:return self.send(401,{'error':'Host unlock failed'})
                with AUTH_LOCK:
                    for k in list(SESSIONS):
                        if SESSIONS[k]<now:del SESSIONS[k]
                    key=secrets.token_urlsafe(32);SESSIONS[key]=now+14400
                return self.send(200,{'session_token':key})
            with AUTH_LOCK:expiry=SESSIONS.get(self.headers.get('Authorization','').removeprefix('Bearer '),0)
            if expiry<time.time():return self.send(401,{'error':'Unlock with Orbit host token first'})
            if self.path=='/api/status':
                frame,status=STATE.snapshot()
                status.pop('wad',None)
                return self.send(200,{'game':status,'paused':STATE.paused,'jev':JEV.snapshot(),'decisions':JEV.decisions(),'frame':base64.b64encode(frame).decode()})
            if self.path=='/api/start':STATE.paused=False
            elif self.path=='/api/pause':STATE.paused=True;JEV.disable()
            elif self.path=='/api/local':JEV.disable()
            elif self.path=='/api/jev':JEV.enable(data.get('key'),data.get('consent'),data.get('budget'));STATE.paused=False
            elif self.path=='/api/restart':
                JEV.disable();STATE.update_controls({'restart':True});STATE.paused=False
            else:return self.send(404,{'error':'Not found'})
            self.send(200,{'ok':True})
        except (ValueError,TypeError):self.send(400,{'error':'Invalid request; Jev needs a key, explicit consent, and a 1–100 call budget'})
        except Exception:self.send(500,{'error':'Service request failed'})

if __name__=='__main__':
    CONFIG=json.loads(CONFIG_PATH.read_text())
    if sys.prefix!=CONFIG['python_prefix']:
        os.execv(CONFIG['python'],[CONFIG['python'],str(ROOT/'main.py')])
    setup_engine()
    ThreadingHTTPServer(('127.0.0.1',int(os.environ['ORBIT_EXTENSION_PORT'])),Handler).serve_forever()
