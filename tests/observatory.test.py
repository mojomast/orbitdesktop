import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('observatory',ROOT/'scripts/observatory_export.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class ObservatoryTests(unittest.TestCase):
 def test_real_sources_are_numeric_and_allowlisted(self):
  d,c=m.collect()
  self.assertEqual(set(d['sources'].values()),{'ok'})
  for name in ['host','usage','jobs','workspace','service','history']:
   def check(value):
    if isinstance(value,dict):
     for v in value.values():check(v)
    elif isinstance(value,list):
     for v in value:check(v)
    else:self.assertTrue(value is None or isinstance(value,(int,float,bool)),repr(value))
   check(d[name])
  self.assertIsNone(d['host']['cpu_percent'])
  self.assertIsNone(d['host']['rx_per_second'])
  self.assertNotIn('_counters',d)
  self.assertGreater(d['host']['memory_total'],0)
 def test_source_failure_is_explicit(self):
  with patch.object(m,'usage',side_effect=RuntimeError('PRIVATE DATA MUST NOT ESCAPE')):
   d,_=m.collect()
  self.assertEqual(d['sources']['usage'],'unavailable')
  self.assertIsNone(d['usage'])
  self.assertNotIn('PRIVATE',json.dumps(d))
  self.assertIsNotNone(d['host'])
 def test_history_is_bounded(self):
  now=m.time.time()
  previous={'history':[{'at':now-i,'cpu':None} for i in range(1,700)]}
  d,_=m.collect(previous)
  self.assertEqual(len(d['history']),360)
 def test_live_feed_atomicity_and_watcher_stability(self):
  with tempfile.TemporaryDirectory() as tmp:
   output=Path(tmp)/'data/snapshot.json';private=Path(tmp)/'previous.json'
   with patch.object(m,'OUTPUT',output),patch.object(m,'PRIVATE',private):
    m.main();stamp=output.parent.stat().st_mtime_ns;mtime=output.stat().st_mtime_ns
    m.main()
    self.assertEqual(stamp,output.parent.stat().st_mtime_ns)
    self.assertEqual(mtime,output.stat().st_mtime_ns)
    self.assertEqual(private.stat().st_mode & 0o777,0o600)
    self.assertEqual(len(json.loads(output.read_text())['history']),2)
    self.assertFalse(output.with_name('.snapshot.tmp').exists())
 def test_job_details_are_not_exported(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp);(p/'cron').mkdir();(p/'cron/jobs.json').write_text(json.dumps({'jobs':[{'name':'secret-name','prompt':'secret-prompt','enabled':True,'last_error':'secret-error','next_run_at':10}]}))
   with patch.object(m,'PROFILE',p):d=m.jobs(1000)
   self.assertEqual(d['failing'],1);self.assertEqual(d['overdue'],1)
   self.assertNotIn('secret',json.dumps(d))

if __name__=='__main__':unittest.main()
