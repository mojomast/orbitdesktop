"""Isolated validation and persistence unit tests. No synthesis is simulated."""
import importlib.util, tempfile, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('bench',Path(__file__).resolve().parents[1]/'extensions/omnivoice-bench/main.py')
bench=importlib.util.module_from_spec(spec);spec.loader.exec_module(bench)
class BenchTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();bench.DATA=Path(self.tmp.name);bench.PAUSED=False;bench.initialize()
    def tearDown(self):self.tmp.cleanup()
    def test_defaults(self):self.assertEqual(bench.validate({'text':'Hello'})['num_step'],16)
    def test_no_profile_or_proxy(self):
        for k in ['profile_id','ref_audio','url','path','engine']:
            with self.assertRaises(ValueError):bench.validate({'text':'Hello',k:'x'})
    def test_bad_numbers(self):
        for k,v in [('seed',-1),('num_step',1.5),('speed',True),('speed',float('nan')),('guidance_scale',6)]:
            with self.assertRaises(ValueError):bench.validate({'text':'Hello',k:v})
    def test_voice_tags(self):
        self.assertEqual(bench.validate({'text':'Hello','instruct':'MALE, british accent'})['instruct'],'male, british accent')
        for v in ['a warm friendly voice','male, female','high pitch, low pitch']:
            with self.assertRaises(ValueError):bench.validate({'text':'Hello','instruct':v})
    def test_bounded_text(self):
        for v in ['', 'x'*2001]:
            with self.assertRaises(ValueError):bench.validate({'text':v})
    def test_queue_bound(self):
        for i in range(8):bench.enqueue({'text':'Hello','seed':i})
        with self.assertRaises(ValueError):bench.enqueue({'text':'Hello'})
    def test_restart_no_automatic_replay(self):
        bench.enqueue({'text':'Hello'});bench.initialize()
        self.assertEqual(bench.items('takes')[0]['status'],'interrupted')
    def test_pause_blocks_submit(self):
        bench.PAUSED=True
        with self.assertRaises(ValueError):bench.enqueue({'text':'Hello'})
    def test_session_signature(self):
        t=bench.issue_token();self.assertTrue(bench.valid_token(t));self.assertFalse(bench.valid_token(t+'0'));self.assertFalse(bench.valid_token(''))
    def test_no_audio_path_lookup(self):
        with self.assertRaises(ValueError):bench.get_take('../../etc/passwd')
if __name__=='__main__':unittest.main()
