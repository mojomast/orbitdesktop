import json,os
from http.server import BaseHTTPRequestHandler,HTTPServer
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  if self.path!='/health':self.send_error(404);return
  data=json.dumps({'ok':True,'release':os.environ['ORBIT_EXTENSION_RELEASE']}).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(data)
HTTPServer(('127.0.0.1',int(os.environ['ORBIT_EXTENSION_PORT'])),Handler).serve_forever()
