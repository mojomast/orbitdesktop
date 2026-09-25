import importlib.util
from pathlib import Path
import tempfile
import tarfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('orbit_launcher', ROOT / 'hermes-plugin/orbit.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)

class BundleTest(unittest.TestCase):
    def test_unpack_complete_and_private(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'orbit'
            launcher.unpack(target)
            for name in ['server/index.mjs', 'src/main.ts', 'package-lock.json', 'scripts/workspace_control.py', 'docs/XPRA_APPS.md', 'src/connection-passwords.ts', 'contracts/workspace-v1.mjs', 'contracts/workspace-v1.json', 'server/workspace-contract.mjs', 'server/workspace-store.mjs', 'public/recovery.html', 'public/recovery.js', 'scripts/generate-workspace-contract.mjs']:
                self.assertTrue((target / name).is_file(), name)
            self.assertFalse((target / 'server/mobile-proxy.mjs').exists())
            for name in ['server/sqlite-workspace-store.mjs', 'server/bundle-registry.mjs', 'server/workspace-events.mjs', 'src/workspace-events.ts', 'scripts/workspace_bundles.mjs']:
                self.assertTrue((target / name).is_file(), name)
            self.assertEqual(target.stat().st_mode & 0o777, 0o700)
            with self.assertRaises(ValueError):
                launcher.unpack(target)

    def test_bundle_matches_reviewable_source_and_excludes_private_data(self):
        with tarfile.open(ROOT / 'hermes-plugin/orbit-source.tar.gz') as archive:
            for member in archive.getmembers():
                self.assertTrue(member.isfile())
                self.assertFalse(any(part.startswith('.') for part in Path(member.name).parts))
                self.assertNotIn('node_modules', member.name)
                self.assertNotIn('apps/', member.name[:5])
                self.assertEqual(archive.extractfile(member).read(), (ROOT / member.name).read_bytes(), member.name)

if __name__ == '__main__':
    unittest.main()
