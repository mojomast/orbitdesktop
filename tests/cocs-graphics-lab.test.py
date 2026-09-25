import importlib.util,json,tempfile,unittest,uuid
from pathlib import Path
from unittest.mock import patch
R=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('workshop',R/'extensions/cocs-graphics-lab/backend.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.old=m.DATA;m.DATA=Path(self.tmp.name);self.s={'id':uuid.uuid4().hex,'status':'ready','branch':'asset-workshop/test','asset':'vehicle:puma','prompt':'test','evidence':'test'}
  self.repo=m.DATA/self.s['id']/'repo';self.repo.mkdir(parents=True);(self.repo/'game').mkdir();(self.repo/'game/model.mjs').write_text('export const color=1;\n')
  m.cmd(['git','init','--quiet'],self.repo);m.git(self.s,'add','.');m.git(self.s,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--quiet','-m','base');self.s['base']=m.git(self.s,'rev-parse','HEAD')
  (self.repo/'game/model.mjs').write_text('export const color=2;\n');self.s['diff'],self.s['digest'],_=m.inspect(self.s)
 def tearDown(self):m.DATA=self.old;self.tmp.cleanup()
 def test_inspect_real_git(self):self.assertEqual(m.inspect(self.s)[2],['game/model.mjs'])
 def test_http_create_and_auth(self):
  import threading,urllib.request,urllib.error
  server=m.ThreadingHTTPServer(('127.0.0.1',0),m.Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
  url='http://127.0.0.1:'+str(server.server_port)+'/api'
  def request(headers):return urllib.request.urlopen(urllib.request.Request(url,data=json.dumps({'op':'edit','asset':'vehicle:puma','prompt':'Local API contract test'}).encode(),headers=headers),timeout=5)
  try:
   with self.assertRaises(urllib.error.HTTPError):request({})
   with patch.object(m,'work',lambda *args:None):
    with request({'Tailscale-User-Login':m.OWNER,'X-Workshop-Token':m.token(),'Content-Type':'application/json'}) as r:created=json.load(r)
    self.assertEqual(created['status'],'preparing');self.assertEqual(len(created['id']),32)
    self.assertEqual(m.get(created['id'])['asset'],'vehicle:puma')
  finally:server.shutdown();server.server_close()
 def test_auth(self):self.assertTrue(m.valid(m.token()));self.assertFalse(m.valid('invalid'));self.assertFalse(m.valid(m.token()+'x'))
 def test_untracked(self):
  (self.repo/'untracked').write_text('x')
  with self.assertRaises(ValueError):m.inspect(self.s)
 def test_outside(self):
  (self.repo/'outside.mjs').write_text('x');m.git(self.s,'add','outside.mjs')
  with self.assertRaises(ValueError):m.inspect(self.s)
 def test_syntax(self):
  (self.repo/'game/model.mjs').write_text('const x=;')
  with self.assertRaises(ValueError):m.inspect(self.s)
 def test_publish_confirmation(self):
  with self.assertRaises(ValueError):m.publish(self.s,{'digest':self.s['digest'],'title':'No confirmation'})
 def test_stale_digest(self):
  (self.repo/'game/model.mjs').write_text('export const color=3;')
  with self.assertRaises(ValueError):m.publish(self.s,{'digest':self.s['digest'],'title':'Stale','confirm':True})
 def test_publish_contract_mock_external_only(self):
  calls=[];real_cmd=m.cmd
  def command(args,cwd=None,timeout=120):
   if args[0]=='/usr/bin/gh':calls.append(args);return 'https://github.com/mojomast/cocs/pull/123456'
   if 'push' in args:calls.append(args);return ''
   return real_cmd(args,cwd,timeout)
  with patch.object(m,'cmd',command):
   result=m.publish(self.s,{'digest':self.s['digest'],'title':'Test change','confirm':True})
   self.assertEqual(result['status'],'published');self.assertEqual(len(calls),2)
   self.assertEqual(m.publish(result,{}),result);self.assertEqual(len(calls),2)
  self.assertIn('--base',calls[1]);self.assertIn('main',calls[1])
if __name__=='__main__':unittest.main(verbosity=2)
