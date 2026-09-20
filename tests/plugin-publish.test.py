import json, subprocess, tempfile, unittest
from pathlib import Path
SCRIPT=Path(__file__).resolve().parents[1]/'scripts/plugin_publish.py'
class Publication(unittest.TestCase):
 def test_versioned_bundles_and_rejected_symlinks(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);source=root/'source';source.mkdir();(source/'index.html').write_text('version one')
   cmd=['python3',str(SCRIPT),str(source),'--id','test','--version','1.0.0','--title','Test','--runtime',str(root/'runtime')]
   first=json.loads(subprocess.check_output(cmd));again=json.loads(subprocess.check_output(cmd));self.assertEqual(first,again)
   (source/'index.html').write_text('version two');second=json.loads(subprocess.check_output(cmd));self.assertNotEqual(first['entry'],second['entry'])
   self.assertEqual((root/'runtime'/first['entry'].lstrip('/')).read_text(),'version one')
   (source/'secret').symlink_to('/etc/passwd');self.assertNotEqual(subprocess.run(cmd,capture_output=True).returncode,0)
if __name__=='__main__':unittest.main()
