"""Offline batch validation, serial execution and persistence tests (no inference)."""
import importlib.util, tempfile, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('studio',Path(__file__).resolve().parents[1]/'extensions/supra2-studio/main.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class BatchTests(unittest.TestCase):
    def test_matrix(self):
        jobs=m.expand(dict(prompt='test',count=3,steps=[5,10],guidance=[2,3]))
        self.assertEqual(len(jobs),12)
        seeds={j['seed'] for j in jobs};self.assertEqual(len(seeds),3)
        for seed in seeds:self.assertEqual({(j['steps'],j['cfg']) for j in jobs if j['seed']==seed},{(5,2),(5,3),(10,2),(10,3)})
    def test_invalid(self):
        d=dict(prompt='test',count=2,steps=[5],guidance=[3])
        for patch in [dict(count=True),dict(count=33),dict(steps=[]),dict(steps=[True]),dict(steps=[2.5]),dict(guidance=[float('nan')]),dict(guidance=[11]),dict(count=32,steps=[1,2,3],guidance=[1,2]),dict(extra=1),dict(prompt=' ')]:
            with self.subTest(patch=patch),self.assertRaises(ValueError):m.expand({**d,**patch})
    def test_serial_cancel_persistence(self):
        oldout,oldrun=m.OUT,m.run
        try:
            with tempfile.TemporaryDirectory() as td:
                m.OUT=Path(td);m.JOBS.clear();seen=[]
                for i in range(3):m.JOBS[str(i)]=dict(id=str(i),prompt='test',seed=i,steps=1,cfg=1,status='queued')
                m.JOBS['1']['status']='cancelled'
                def fake_run(i,d):
                    self.assertTrue(m.BUSY);seen.append(i);m.JOBS[i]['status']='failed'
                m.run=fake_run;m.BUSY=True;m.run_batch(['0','1','2'])
                self.assertEqual(seen,['0','2']);self.assertFalse(m.BUSY)
                m.JOBS['2']['status']='queued';m.save_history();m.JOBS.clear();m.load_history()
                self.assertEqual(m.JOBS['2']['status'],'cancelled')
                self.assertEqual((m.OUT/'history.json').stat().st_mode&0o777,0o600)
        finally:m.OUT=oldout;m.run=oldrun;m.JOBS.clear()
if __name__=='__main__':unittest.main()
