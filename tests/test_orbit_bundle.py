import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import tarfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('orbit_launcher', ROOT / 'hermes-plugin/orbit.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)

bundle_spec = importlib.util.spec_from_file_location('bundle_hermes', ROOT / 'scripts/bundle_hermes.py')
bundler = importlib.util.module_from_spec(bundle_spec)
bundle_spec.loader.exec_module(bundler)

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
            for name in ['server/workspace-arrangements.mjs', 'server/workspace-arrangement-control.mjs', 'server/workspace-description.mjs', 'contracts/workbench-workflow-v1.mjs']:
                self.assertTrue((target / name).is_file(), name)
            for name in ['server/workbench-setup.mjs', 'contracts/workbench-setup-v1.mjs', 'src/workbench-setup.ts', 'src/workbench-setup.css', 'docs/WORKBENCH_SETUP.md']:
                self.assertTrue((target / name).is_file(), name)
            self.assertEqual(target.stat().st_mode & 0o777, 0o700)
            # Exercise the service's actual import chain from the extracted
            # Orbit root, without a sibling checkout or a running service.
            subprocess.run([sys.executable, '-B', '-E', '-s', '-c',
                'from contrib.rails_server.http import RailsLedger, query_events, query_view_page; '
                'assert callable(query_events) and callable(query_view_page)'], cwd=target, check=True)
            for name in ('src/rails-shell.ts', 'server/rails-proxy.mjs', 'src/onboarding-steps.ts',
                         'server/onboarding-github.mjs', 'skills/setup-agent/SKILL.md',
                         'compose.router.yml', 'docker-compose.yml', '.dockerignore',
                         'public/worker-join.js', 'scripts/worker-join/client.mjs',
                         'server/worker-join-route.mjs', 'contrib/rails_server/rails.service',
                         'contrib/rizzstack_rails/LICENSE', 'contrib/vibeline/LICENSE'):
                self.assertTrue((target/name).is_file(), name)
            with self.assertRaises(ValueError):
                launcher.unpack(target)

    def test_bundle_matches_reviewable_source_and_excludes_private_data(self):
        with tarfile.open(ROOT / 'hermes-plugin/orbit-source.tar.gz') as archive:
            for member in archive.getmembers():
                self.assertTrue(member.isfile())
                if member.name != '.dockerignore':
                    self.assertFalse(any(part.startswith('.') for part in Path(member.name).parts))
                self.assertNotIn('node_modules', member.name)
                if member.name.startswith('apps/'):
                    rails = {'apps/rizzstack-rails/'+n for n in ('app.js','index.html','inspector.js','rails.js','styles.css','feedback.js')}
                    hive = {'apps/rizzstack-hive/'+n for n in ('fixtures.js','host-client.js','index.html','main.js',
                            'queue-data.js','queue-desk.js','release.js','scene.css','scene.js','snapshot-adapter.js',
                            'store.js','styles.css','trace-data.js','trace.js','transitions.js','validate-snapshot.js')}
                    hive.update('apps/rizzstack-hive/'+n for n in ('console.css','inbox.js','inspector.js','operations.css',
                                'operations.js','recorder.js','workbench.css','workbench.js','public-labels.js',
                                'queue-provider.js','release-provider.js','triage.css'))
                    self.assertIn(member.name, rails | hive)
                self.assertEqual(archive.extractfile(member).read(), (ROOT / member.name).read_bytes(), member.name)

    def test_bundle_contains_every_policy_member(self):
        # Reverse completeness against the authoritative bundler policy: every
        # tracked file scripts/bundle_hermes.py would include must be in the
        # archive, and the archive must not carry anything the policy excludes.
        tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
        product = json.loads((ROOT / 'scripts/portable-product.json').read_text())['required']
        expected = {name for name in tracked if name and bundler.included(name)} | set(product)
        with tarfile.open(ROOT / 'hermes-plugin/orbit-source.tar.gz') as archive:
            actual = {member.name for member in archive.getmembers() if member.isfile()}
        self.assertEqual(sorted(expected - actual), [], 'policy files missing from the bundle')
        self.assertEqual(sorted(actual - expected), [], 'bundle members outside the inclusion policy')
        self.assertEqual(len(actual), len(expected), 'bundle member count must match the policy')

    def test_local_module_imports_are_packaged(self):
        # A new untracked TS component can otherwise disappear while BOTH
        # inventory comparisons pass. Resolve relative imports only; npm
        # packages are installed separately and ambient files are never added.
        parts = re.compile(r'''(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\(\s*)['"](\.[^'"]+)['"]''')
        with tarfile.open(ROOT / 'hermes-plugin/orbit-source.tar.gz') as archive:
            names = set(archive.getnames())
            for name in sorted(names):
                path = ROOT/name
                if path.suffix not in {'.ts', '.js', '.mjs'}: continue
                for ref in parts.findall(archive.extractfile(name).read().decode()):
                    source = (path.parent/ref).resolve()
                    if not source.is_file(): source = Path(str(source) + '.ts')
                    if source.is_file() and source.is_relative_to(ROOT):
                        self.assertIn(source.relative_to(ROOT).as_posix(), names, f'{name} imports {ref}')

    def test_only_exact_untracked_members_and_stable_after_indexing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'source'
            root.mkdir()
            subprocess.run(['git','init','-q'], cwd=root, check=True)
            for name in bundler.REQUIRED:
                path = root/name
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT/name, path)
            for name in ('src/private-debug.ts','apps/rizzstack-rails/user.js',
                         'contrib/rizzstack_rails/credentials.py','server/unreviewed.mjs',
                         'public/.env','src/__pycache__/state.pyc','src/private/local.ts',
                         'docs/images/private.svg','scripts/worker-join/private.key', 'public/worker.sqlite'):
                path = root/name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('PRIVATE-CANARY')
            # Only stage synthetic inputs in this temporary fixture. Private
            # files in standard source dirs also stay excluded when tracked.
            subprocess.run(['git','add','public/.env','src/__pycache__','src/private',
                            'docs/images','scripts/worker-join/private.key','public/worker.sqlite'],cwd=root,check=True)
            first,second = Path(tmp)/'first.tgz',Path(tmp)/'second.tgz'
            bundler.build(first,root=root)
            subprocess.run(['git','add','--',*sorted(bundler.REQUIRED)],cwd=root,check=True)
            bundler.build(second,root=root)
            self.assertEqual(first.read_bytes(),second.read_bytes())
            with tarfile.open(first) as archive:
                self.assertEqual(set(archive.getnames()),bundler.REQUIRED)

    def test_cannot_publish_symlinks_hardlinks_or_key_material_at_curated_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)/'repo'; root.mkdir()
            secret = Path(tmp)/'secret'; secret.write_bytes(b'private')
            (root/'src').mkdir(); member = root/'src/rails-shell.ts'
            member.symlink_to(secret)
            with self.assertRaises(OSError): bundler.member_bytes(root,'src/rails-shell.ts')
            member.unlink(); os.link(secret, member)
            with self.assertRaises(ValueError): bundler.member_bytes(root,'src/rails-shell.ts')
            member.unlink(); member.write_bytes(b'-----BEGIN '+b'PRIVATE KEY-----')
            with self.assertRaises(ValueError): bundler.member_bytes(root,'src/rails-shell.ts')
            member.unlink(); member.parent.rmdir(); (root/'src').symlink_to(Path(tmp),target_is_directory=True)
            with self.assertRaises(OSError): bundler.member_bytes(root,'src/secret')

    def test_rebuilt_bundle_reproduces_committed_tarball_bytes(self):
        # DEFECT-1 regression (PR #42 review): the gzip container framing must
        # be interpreter-independent, so a rebuild on any supported Python
        # reproduces the committed artifact byte-for-byte, not merely its
        # gunzipped inner payload.
        committed = (ROOT / 'hermes-plugin/orbit-source.tar.gz').read_bytes()
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'orbit-source.tar.gz'
            bundler.build(target)
            rebuilt = target.read_bytes()
        self.assertEqual(rebuilt, committed, 'rebuilt bundle bytes must equal the committed hermes-plugin/orbit-source.tar.gz')

if __name__ == '__main__':
    unittest.main()
