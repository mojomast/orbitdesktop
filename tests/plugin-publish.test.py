import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/plugin_publish.py'


class Publication(unittest.TestCase):
    def setup_bundle(self, root, script=SCRIPT):
        source = root / 'source'
        source.mkdir()
        (source / 'index.html').write_text('version one')
        runtime = root / 'runtime'
        command = ['python3', str(script), str(source), '--id', 'test',
                   '--version', '1.0.0', '--title', 'Test', '--runtime', str(runtime)]
        return source, runtime, command

    def test_versioned_bundles_and_rejected_source_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, runtime, command = self.setup_bundle(root)
            first = json.loads(subprocess.check_output(command))
            again = json.loads(subprocess.check_output(command))
            self.assertEqual(first, again)
            (source / 'index.html').write_text('version two')
            second = json.loads(subprocess.check_output(command))
            self.assertNotEqual(first['entry'], second['entry'])
            self.assertEqual((runtime / first['entry'].lstrip('/')).read_text(), 'version one')
            (source / 'secret').symlink_to('/etc/passwd')
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_nested_path_digest_preserves_historical_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, _, command = self.setup_bundle(root)
            (source / 'a').mkdir()
            (source / 'a' / 'x').write_text('nested')
            (source / 'a.html').write_text('sibling')
            digest = hashlib.sha256()
            for file in sorted(source.rglob('*')):
                if not file.is_file():
                    continue
                name = file.relative_to(source).as_posix().encode()
                content = file.read_bytes()
                digest.update(len(name).to_bytes(8, 'big') + name +
                              len(content).to_bytes(8, 'big') + content)
            manifest = json.loads(subprocess.check_output(command))
            self.assertEqual(manifest['entry'],
                             '/apps/test-' + digest.hexdigest()[:24] + '/index.html')

    def test_reuse_rejects_extra_entries_and_changed_content(self):
        for kind in ('extra_file', 'hidden_file', 'hidden_directory', 'empty_directory',
                     'symlink', 'dangling_symlink', 'replaced_file_symlink',
                     'changed_content', 'root_symlink'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                _, runtime, command = self.setup_bundle(root)
                manifest = json.loads(subprocess.check_output(command))
                bundle = runtime / 'apps' / manifest['entry'].split('/')[2]
                if kind == 'extra_file':
                    (bundle / 'extra.js').write_text('extra')
                elif kind == 'hidden_file':
                    (bundle / '.hidden').write_text('hidden')
                elif kind == 'hidden_directory':
                    (bundle / '.hidden').mkdir()
                elif kind == 'empty_directory':
                    (bundle / 'extra').mkdir()
                elif kind == 'symlink':
                    (bundle / 'link').symlink_to(bundle / 'index.html')
                elif kind == 'dangling_symlink':
                    (bundle / 'link').symlink_to(bundle / 'missing')
                elif kind == 'replaced_file_symlink':
                    (bundle / 'index.html').unlink()
                    (bundle / 'index.html').symlink_to(root / 'source' / 'index.html')
                elif kind == 'changed_content':
                    (bundle / 'index.html').write_text('changed')
                else:
                    bundle.rename(bundle.with_name('original'))
                    bundle.symlink_to(bundle.with_name('original'), target_is_directory=True)
                self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_registration_with_initialized_db_and_absent_db(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            scripts = root / 'scripts'
            scripts.mkdir()
            publisher = scripts / 'plugin_publish.py'
            publisher.write_bytes(SCRIPT.read_bytes())
            marker = root / 'registered.json'
            cli = scripts / 'workspace_bundles.mjs'
            source, runtime, command = self.setup_bundle(root, publisher)
            # A standalone publish works without a workspace DB or a usable CLI.
            first = json.loads(subprocess.check_output(command))
            self.assertFalse(marker.exists())
            runtime.joinpath('workspace.sqlite').write_bytes(b'CLI stub owns this')
            cli.write_text('import fs from "node:fs";\n'
                           f'fs.writeFileSync({json.dumps(str(marker))}, JSON.stringify(process.argv.slice(2)));\n')
            self.assertEqual(json.loads(subprocess.check_output(command)), first)
            self.assertEqual(json.loads(marker.read_text()),
                             ['refresh', '--root', str(runtime.resolve())])
            marker.unlink()
            (source / 'index.html').write_text('version two')
            json.loads(subprocess.check_output(command))
            self.assertEqual(json.loads(marker.read_text()),
                             ['refresh', '--root', str(runtime.resolve())])

    def test_registration_failure_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            scripts = root / 'scripts'
            scripts.mkdir()
            publisher = scripts / 'plugin_publish.py'
            publisher.write_bytes(SCRIPT.read_bytes())
            (scripts / 'workspace_bundles.mjs').write_text('process.exit(7);\n')
            _, runtime, command = self.setup_bundle(root, publisher)
            runtime.mkdir()
            (runtime / 'workspace.sqlite').write_bytes(b'stub')
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('registration failed', result.stderr)
            self.assertEqual(result.stdout, '')

    def test_oversized_file_and_linked_apps_root_fail_before_publication(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, runtime, command = self.setup_bundle(root)
            with (source / 'large.bin').open('wb') as stream:
                stream.truncate(20_000_001)
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            self.assertFalse((runtime / 'apps').exists())
            (source / 'large.bin').unlink()
            outside = root / 'outside'
            outside.mkdir()
            runtime.mkdir()
            (runtime / 'apps').symlink_to(outside, target_is_directory=True)
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            self.assertEqual(list(outside.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
