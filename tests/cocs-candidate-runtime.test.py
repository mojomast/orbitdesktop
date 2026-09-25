import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('runtime',Path(__file__).resolve().parents[1]/'scripts/test_cocs_candidate.py')
u=importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)

class IntegrityTests(unittest.TestCase):
    def fixture(self, root):
        report={'schema':'cocs.sdk-candidate/v1','buildCompatible':True,'baseline':'a'*40,'target':'b'*40,'builds':[]}
        for label, key in [('baseline','baseline'),('candidate','target')]:
            (root/(label+'.html')).write_text('test artifact')
            report['builds'].append({'label':label,'passed':True,'commit':report[key],'sha256':hashlib.sha256(b'test artifact').hexdigest()})
        return report

    def test_valid(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);r=self.fixture(root)
            self.assertEqual(len(u.verified_artifacts(root,r)),2)

    def test_tampering(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);r=self.fixture(root)
            (root/'candidate.html').write_text('changed')
            with self.assertRaises(ValueError):u.verified_artifacts(root,r)

    def test_commit_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);r=self.fixture(root);r['target']='c'*40
            with self.assertRaises(ValueError):u.verified_artifacts(root,r)

    def test_failed_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);r=self.fixture(root);r['buildCompatible']=False
            with self.assertRaises(ValueError):u.verified_artifacts(root,r)

    def test_duplicate_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);r=self.fixture(root);r['builds'].append(r['builds'][0])
            with self.assertRaises(ValueError):u.verified_artifacts(root,r)

if __name__=='__main__':unittest.main()
