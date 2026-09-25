import json
from pathlib import Path
import subprocess
import sys
import time
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'extensions/supra2-studio'))
from warm import WarmWorker

# Deliberately synthetic protocol peer: lifecycle tests, NOT inference benchmarks.
PEER = "import sys,json,time; exec(\"for line in sys.stdin:\\n d=json.loads(line)\\n time.sleep(d.get('delay',0))\\n print(json.dumps({'ok':True,'generation_seconds':0}),flush=True)\")"

class Lifecycle(unittest.TestCase):
    def worker(self, **kwargs):
        w = WarmWorker(command=[sys.executable, '-u', '-c', PEER], **kwargs)
        self.addCleanup(w.close)
        return w

    def test_reuse_and_close(self):
        w = self.worker()
        self.assertFalse(w.generate({})['warm'])
        p = w.process
        self.assertTrue(w.generate({})['warm'])
        self.assertIs(p, w.process)
        w.close()
        self.assertIsNotNone(p.poll())
        self.assertFalse(w.status()['loaded'])

    def test_timeout_recovery(self):
        w = self.worker(timeout=.2)
        with self.assertRaises(subprocess.TimeoutExpired):
            w.generate({'delay':1})
        self.assertIsNone(w.process)
        self.assertFalse(w.generate({})['warm'])

    def test_crash_recovery(self):
        w = self.worker()
        w.generate({})
        w.process.kill()
        w.process.wait()
        self.assertFalse(w.generate({})['warm'])

    def test_idle_unload_and_reload(self):
        w = self.worker(idle_seconds=.1)
        w.generate({})
        p = w.process
        deadline = time.monotonic()+3
        while p.poll() is None and time.monotonic()<deadline:
            time.sleep(.05)
        self.assertIsNotNone(p.poll())
        self.assertFalse(w.generate({})['warm'])

    def test_no_unload_during_generation(self):
        w = self.worker(idle_seconds=.1)
        w.generate({'delay':1.2})
        self.assertTrue(w.status()['loaded'])
        self.assertTrue(w.generate({})['warm'])

    def test_bad_protocol(self):
        w = WarmWorker(command=[sys.executable,'-c','print("not json",flush=True)'])
        self.addCleanup(w.close)
        with self.assertRaises((ValueError, BrokenPipeError)):
            w.generate({})
        self.assertIsNone(w.process)

if __name__ == '__main__':
    unittest.main()
