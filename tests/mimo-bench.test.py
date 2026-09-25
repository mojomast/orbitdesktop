import importlib.util,unittest,tempfile,time
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('bench',Path(__file__).resolve().parents[1]/'extensions/mimo-bench/main.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
C=dict(samples=3,concurrency=1,max_tokens=128,preset='latency',thinking='disabled')
class Tests(unittest.TestCase):
    def test_validation(self):
        self.assertEqual(m.config(C),C)
        for k,v in [('samples',21),('samples',True),('concurrency',5),('max_tokens',100000),('preset','custom'),('thinking','bad')]:
            with self.assertRaises(ValueError):m.config(dict(C,**{k:v}))
        with self.assertRaises(ValueError):m.config(dict(C,endpoint='http://evil'))
    def test_models(self):
        for model in m.MODELS+['all']:self.assertEqual(m.config(dict(C,model=model))['model'],model)
        for model in m.AUDIO_MODELS+['bad']:
            with self.assertRaises(ValueError):m.config(dict(C,model=model))
    def test_comparison_schedule(self):
        # Mocked scheduling test, never stored as provider benchmark evidence.
        with tempfile.TemporaryDirectory() as d,patch.object(m,'STORE',Path(d)),patch.object(m,'sample',side_effect=lambda c,k,i:dict(model=c['model'],index=i+1)) as sample,patch.object(m,'Vault'):
            m.STOP.clear();run=dict(config=dict(C,model='all',samples=2),results=[],status='running');m.execute(run)
            self.assertEqual(run['status'],'finished');self.assertEqual(sample.call_count,10)
            for model in m.MODELS:self.assertEqual(sum(r['model']==model for r in run['results']),2)
            self.assertNotEqual(run['results'][0]['model'],run['results'][5]['model'])
    def test_percentiles(self):
        self.assertEqual(m.percentile([5,1,3],.5),3);self.assertEqual(m.percentile([5,1,3],.95),5);self.assertIsNone(m.percentile([],.5))
    def test_error_denominator(self):
        r={'results':[dict(ok=True,ttft_ms=100,elapsed_ms=200,tokens=10,tokens_per_second=50,quality_pass=True),dict(ok=False,ttft_ms=None,elapsed_ms=300,tokens=None,tokens_per_second=None,quality_pass=None)]}
        s=m.summary(r);self.assertEqual(s['error_rate'],.5);self.assertEqual(s['latency_p95_ms'],200);self.assertEqual(s['quality_scored'],1)
    def test_stop_skips_queued_calls(self):
        # Explicit unit fixture, not provider evidence. No network calls or production records.
        with tempfile.TemporaryDirectory() as d,patch.object(m,'STORE',Path(d)),patch.object(m,'sample') as sample,patch.object(m,'Vault') as vault:
            vault.return_value.get.return_value='unit-fixture';m.STOP.set();run=dict(config=C,results=[],status='running');m.execute(run);sample.assert_not_called();self.assertEqual(run['status'],'stopped');m.STOP.clear()
if __name__=='__main__':unittest.main()
