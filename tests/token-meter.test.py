import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location('meter', Path(__file__).resolve().parents[1] / 'scripts/token_widget_export.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class Counters(unittest.TestCase):
    def test_migration_and_model_totals(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'db'
            with sqlite3.connect(path) as db:
                for table in ['session', 'session_v2']:
                    db.execute(f'CREATE TABLE {table} (id TEXT PRIMARY KEY, model TEXT, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, tokens_reasoning INTEGER)')
                row=('same',json.dumps({'id':'model-a','providerID':'provider'}),10,4,20,3,2)
                for table in ['session', 'session_v2']:
                    db.execute(f'INSERT INTO {table} VALUES(?,?,?,?,?,?,?)',row)
                db.execute('INSERT INTO session VALUES(?,?,?,?,?,?,?)',('legacy','model-b',2,1,0,0,0))
                db.execute('INSERT INTO session_v2 VALUES(?,?,?,?,?,?,?)',('new',None,3,1,0,0,0))
            result=m.opencode_snapshot(path)
            self.assertTrue(result['available'])
            self.assertEqual(result['sessions'],3)
            self.assertEqual(result['input'],15)
            self.assertEqual(result['cached'],20)
            self.assertEqual(len(result['models']),3)
            self.assertEqual(sum(x['output'] for x in result['models']),result['output'])
    def test_missing_database(self):
        self.assertFalse(m.opencode_snapshot(Path('/nonexistent/opencode.db'))['available'])
    def test_real_saved_counters(self):
        result=m.snapshot()
        for key in ['profile','orbit','opencode']:
            self.assertIn('models',result[key])
            for field in ['input','output','cached']:
                self.assertEqual(sum(x[field] for x in result[key]['models']),result[key][field])

if __name__=='__main__': unittest.main()
