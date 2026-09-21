import importlib.util
from pathlib import Path
import tarfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('csp', ROOT / 'deploy/xpra/configure_csp.py')
csp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(csp)

class PortableEndpoints(unittest.TestCase):
    def test_exact_origin(self):
        for origin in ('http://127.0.0.1:4318', 'https://desktop.example.org:8443', 'http://[::1]:4318'):
            self.assertIn("frame-ancestors 'self' " + origin + ';', csp.policy(origin))
        self.assertEqual(csp.policy('http://127.0.0.1:4318'), (ROOT / 'deploy/xpra/10_content_security_policy.txt').read_text())

    def test_reject_injection(self):
        for origin in ('https://*', 'https://example.org;foo', 'https://example.org\nX-Test:yes', 'https://user:secret@example.org', 'https://example.org/path', 'https://example.org?x=y', 'javascript:alert(1)', 'https://example.org:bad'):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                csp.policy(origin)

    def test_bundle_contains_no_author_hostname(self):
        with tarfile.open(ROOT / 'hermes-plugin/orbit-source.tar.gz') as archive:
            for member in archive.getmembers():
                if member.isfile():
                    self.assertNotIn(b'kimi.tailec998.ts.net', archive.extractfile(member).read(), member.name)
            self.assertIn('src/linux-app-url.ts', archive.getnames())
            self.assertIn('deploy/xpra/configure_csp.py', archive.getnames())

if __name__ == '__main__':
    unittest.main()
