import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch
import tempfile

spec = importlib.util.spec_from_file_location('update', Path(__file__).resolve().parents[1] / 'scripts/check_cocs_update.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)

class UpdateTests(unittest.TestCase):
    def review(self):
        return {'schema':'cocs.sdk-update-review/v1','baseline':{'commit':'a'*40,'repository':'mojomast/cocs'},'target':{'commit':'b'*40}}

    def test_valid(self):
        u.validate(self.review())

    def test_reject_ref_injection(self):
        r = self.review()
        r['target']['commit'] = '--upload-pack=evil'
        with self.assertRaises(ValueError): u.validate(r)

    def test_reject_foreign_repo(self):
        r = self.review()
        r['baseline']['repository'] = 'other/repo'
        with self.assertRaises(ValueError): u.validate(r)

    def test_no_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(u, 'run') as run:
            with self.assertRaises(FileExistsError): u.check(tmp, self.review(), tmp)
            run.assert_not_called()

    def test_invalid_review_no_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'candidate'
            with self.assertRaises(ValueError): u.check(tmp, {}, out)
            self.assertFalse(out.exists())

if __name__ == '__main__': unittest.main()
