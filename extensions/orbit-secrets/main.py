import os, sys, json
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0,str(Path(__file__).resolve().parent))
from vault import Vault
ORIGIN='https://kimi.tailec998.ts.net:4364'
OWNER='mojomasta@gmail.com'
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def reply(self,status,data,kind='application/json'):
        raw=json.dumps(data).encode() if kind=='application/json' else data
        self.send_response(status)
        for k,v in {'Content-Type':kind,'Content-Length':str(len(raw)),'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors https://kimi.tailec998.ts.net:4325"}.items(): self.send_header(k,v)
        self.end_headers(); self.wfile.write(raw)
    def auth(self):
        if self.headers.get('Host') not in ('kimi.tailec998.ts.net:4364','127.0.0.1:'+str(self.server.server_port)) or self.headers.get('Tailscale-User-Login')!=OWNER:
            self.reply(403,{'error':'Owner tailnet authentication required.'}); return False
        return True
    def do_GET(self):
        if self.path=='/health': return self.reply(200,{'ok':True,'release':os.environ.get('ORBIT_EXTENSION_RELEASE','test')})
        if not self.auth(): return
        if self.path in ('/','/app.js'):
            p=Path(__file__).parent/('index.html' if self.path=='/' else 'app.js')
            return self.reply(200,p.read_bytes(),'text/html; charset=utf-8' if self.path=='/' else 'text/javascript')
        if self.path=='/api/list': return self.reply(200,{'secrets':self.server.vault.list()})
        return self.reply(404,{'error':'Not found'})
    def do_POST(self):
        if not self.auth(): return
        if self.headers.get('Origin')!=ORIGIN or self.headers.get('Content-Type')!='application/json': return self.reply(403,{'error':'Origin or content type rejected.'})
        try:
            n=int(self.headers.get('Content-Length','0'))
            if not 0<n<=100000: raise ValueError('Invalid request size.')
            self.connection.settimeout(10)
            d=json.loads(self.rfile.read(n))
            if not isinstance(d,dict): raise ValueError('Expected object.')
            action=self.path
            expected={'name','value'} if action in ('/api/create','/api/replace') else {'name'}
            if set(d)!=expected: raise ValueError('Invalid fields.')
            v=self.server.vault
            if action in ('/api/create','/api/replace'): v.put(d['name'],d['value'],action=='/api/replace')
            elif action=='/api/copy': return self.reply(200,{'value':v.get(d['name'])})
            elif action=='/api/delete': v.delete(d['name'])
            else: return self.reply(404,{'error':'Not found'})
            self.reply(200,{'ok':True})
        except (ValueError,UnicodeError): self.reply(400,{'error':'Invalid request, duplicate name, or missing secret. Check the name and selected action.'})
        except Exception: self.reply(500,{'error':'Vault operation failed. No values logged.'})
if __name__=='__main__':
    os.umask(0o077)
    server=ThreadingHTTPServer(('127.0.0.1',int(os.environ.get('ORBIT_EXTENSION_PORT','4464'))),Handler)
    server.vault=Vault(); server.serve_forever()
