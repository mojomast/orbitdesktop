"""Hermetic producer exercise; no owner configuration or collector connection."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'scripts/hive_public_labels.py'


class PublisherTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.stage = self.root / 'reports'
        self.inputs = self.root / 'reviewed'
        self.stage.mkdir(mode=0o700)
        self.inputs.mkdir(mode=0o700)
        raw = subprocess.check_output(['node', '--input-type=module', '-e',
            "import {fixtures} from './apps/rizzstack-hive/fixtures.js'; console.log(JSON.stringify(fixtures.shift))"], cwd=ROOT)
        # Rebase sampling clocks only. Source event times remain historical.
        stamp = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        self.snapshot = json.loads(raw.replace(b'2026-11-17T20:00:00Z',stamp.encode()))
        job = self.snapshot['pipeline']['jobs'][0]
        job.update(job_id='new-prism', title='Reserve a cottage at the lake', summary='An unpublished note')
        self.draft = {'version':'hive.public-aliases/1', 'snapshotSha256':self.pin(self.snapshot),
                      'rows':[{'kind':'job', 'id':'new-prism', 'repo':job['repo'], 'jobId':'new-prism', 'title':'Prism relay'}]}

    def pin(self, value):
        data = value if isinstance(value, bytes) else json.dumps(value).encode()
        digest = hashlib.sha256(data).hexdigest()
        path = self.inputs / (digest + '.json')
        path.write_bytes(data)
        path.chmod(0o600)
        return digest

    def publish(self, pin):
        # Model only the root descriptor as the disposable private root. A
        # normal TMPDIR has shared ancestors; no insecure production bypass.
        runner = """
import os, runpy, sys
root, cli = sys.argv[1:3]; sys.argv = [cli, *sys.argv[3:]]
real_open = os.open
os.open = lambda path, *a, **kw: real_open(root if path=='/' else path, *a, **kw)
runpy.run_path(cli,run_name='__main__')
"""
        return subprocess.run([sys.executable, '-I', '-c', runner, str(self.root), str(CLI), '--inputs-dir','/reviewed',
                               '--staging-dir','/reports','--draft-sha256',pin], capture_output=True)

    def test_exact_pinned_files_to_private_atomic_replacement(self):
        pin = self.pin(self.draft)
        first = self.publish(pin)
        self.assertEqual(first.returncode, 0, first.stderr)
        path = self.stage / 'labels.json'
        old = path.read_bytes()
        self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o600)
        item = json.loads(old)['rows'][0]
        self.assertEqual(item['title'],'Prism relay')
        self.assertRegex(item['revision'], r'^[0-9a-f]{64}$')
        self.assertNotIn(b'at the lake',old)
        self.assertNotIn(self.draft['snapshotSha256'].encode(),old) # no digest of private contents
        self.draft['rows'][0]['title'] = 'Copper relay'
        with path.open('rb') as opened:
            self.assertEqual(self.publish(self.pin(self.draft)).returncode,0)
            self.assertIn(b'Copper relay',path.read_bytes())
            self.assertEqual(opened.read(),old)
        self.assertEqual([p.name for p in self.stage.iterdir()], ['labels.json'])

    def test_rejects_wide_draft_duplicate_keys_mismatch_or_unsafe_alias_without_disclosing_or_clobbering(self):
        self.assertEqual(self.publish(self.pin(self.draft)).returncode,0)
        out = self.stage / 'labels.json'
        old = out.read_bytes()
        bad = '/home/owner/private/session'
        for change in [{'title':bad}, {'title':'private note'}, {'question':bad}, {'jobId':'missing'}, {'repo':'other/repo'}]:
            item = dict(self.draft['rows'][0],**change)
            result = self.publish(self.pin(dict(self.draft, rows=[item])))
            self.assertNotEqual(result.returncode,0)
            self.assertNotIn(b'/home/owner',result.stdout+result.stderr)
            self.assertEqual(out.read_bytes(),old)
        duplicate = json.dumps(self.draft).replace('"version":', '"version":"ignored", "version":')
        self.assertNotEqual(self.publish(self.pin(duplicate.encode())).returncode,0)
        pin = self.pin(self.draft)
        source = self.inputs / (self.draft['snapshotSha256']+'.json')
        source.write_bytes(source.read_bytes()+b'\n')
        self.assertNotEqual(self.publish(pin).returncode,0)
        self.assertEqual(out.read_bytes(),old)

    def test_stale_source_is_not_enrollable(self):
        self.snapshot['generated_at'] = '2020-01-01T12:00:00Z'
        self.draft['snapshotSha256'] = self.pin(self.snapshot)
        self.assertNotEqual(self.publish(self.pin(self.draft)).returncode,0)
        self.assertFalse((self.stage/'labels.json').exists())

    def test_rejects_nonprivate_dirs_symlinked_inputs_and_output(self):
        pin = self.pin(self.draft)
        self.stage.chmod(0o777)
        self.assertNotEqual(self.publish(pin).returncode,0)
        self.stage.chmod(0o700)
        path = self.inputs/(pin+'.json')
        path.chmod(0o644)
        self.assertNotEqual(self.publish(pin).returncode,0)
        path.chmod(0o600)
        temp = self.root/'copy'
        path.rename(temp)
        path.symlink_to(temp)
        self.assertNotEqual(self.publish(pin).returncode,0)
        path.unlink(); temp.rename(path)
        destination = self.stage/'labels.json'
        destination.symlink_to(path)
        self.assertNotEqual(self.publish(pin).returncode,0)
        self.assertTrue(destination.is_symlink())


if __name__ == '__main__':
    unittest.main()
