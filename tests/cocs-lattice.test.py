import importlib.util,tempfile,unittest,uuid,json,shutil
from pathlib import Path
from unittest.mock import patch
R=Path(__file__).resolve().parents[1];spec=importlib.util.spec_from_file_location('lattice',R/'extensions/cocs-lattice-lab/main.py');lab=importlib.util.module_from_spec(spec);spec.loader.exec_module(lab);m=lab.m
class Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.old=m.DATA;m.DATA=Path(self.tmp.name);self.s={'id':uuid.uuid4().hex,'asset':'operation:cocs-director','status':'ready','branch':'lattice-lab/test','prompt':'unit fixture','evidence':'unit fixture'};self.repo=m.DATA/self.s['id']/'repo';(self.repo/'game').mkdir(parents=True);(self.repo/'game/cocs-director.mjs').write_text('export const value=1;\n');m.cmd(['git','init','-q'],self.repo);m.git(self.s,'add','.');m.git(self.s,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');self.s['base']=m.git(self.s,'rev-parse','HEAD');(self.repo/'game/cocs-director.mjs').write_text('export const value=2;\n');_,self.s['digest'],_=m.inspect(self.s);self.s.update(validation_policy=m.POLICY,validated_digest=self.s['digest'])
 def tearDown(self):m.DATA=self.old;self.tmp.cleanup()
 def test_scope(self):
  for name in ['game/view.mjs','game/protocol.mjs','game/maps.mjs']:
   with self.assertRaises(ValueError):lab.compatibility(self.s,[name])
 def test_stale_policy(self):
  self.s['validation_policy']='cocs-contracts-v1'
  with self.assertRaisesRegex(ValueError,'predates'):m.publish(self.s,{'confirm':True,'digest':self.s['digest'],'title':'No'})
 def test_target_branch_external_calls_mocked(self):
  calls=[];real=m.cmd
  def command(args,cwd=None,timeout=120):
   if 'push' in args:calls.append(args);return ''
   if args[0]=='/usr/bin/gh':calls.append(args);return 'https://github.com/mojomast/cocs/pull/123456'
   return real(args,cwd,timeout)
  with patch.object(m,'cmd',command),patch.object(m,'compatibility',return_value='fixture only'):
   result=m.publish(self.s,{'confirm':True,'digest':self.s['digest'],'title':'Fixture'})
  self.assertEqual(result['status'],'published');self.assertIn('feat/fieldwork-plan',calls[1]);self.assertNotIn('main',calls[1])
 def test_actual_draft_smoke_evidence(self):
  s=json.loads((R/'.runtime/lattice-real-generation.json').read_text());self.assertEqual(s['status'],'ready');self.assertEqual(s['target_branch'],'feat/fieldwork-plan');self.assertIn('Actual PvP and Operations Match',s['evidence']);self.assertEqual(s['files'],['game/cocs-director.mjs'])
if __name__=='__main__':unittest.main(verbosity=2)
