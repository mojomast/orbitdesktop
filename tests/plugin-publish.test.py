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

    def test_optional_config_schema_is_validated_and_emitted_without_hash_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, runtime, command = self.setup_bundle(root)
            schema_path = root / 'schema.json'
            schema = {'fields': [
                {'key': 'mode', 'type': 'string', 'title': 'Mode', 'description': 'Pick one.', 'enum': ['light', 'dark'], 'default': 'light', 'required': True},
                {'key': 'count', 'type': 'number', 'min': 0, 'max': 10, 'default': 3},
                {'key': 'pinned', 'type': 'boolean', 'default': False},
            ]}
            schema_path.write_text(json.dumps(schema))
            without = json.loads(subprocess.check_output(command))
            with_schema = json.loads(subprocess.check_output(command + ['--config-schema', str(schema_path)]))
            # Schema metadata never changes the content address and is not a bundle file.
            self.assertEqual(without['entry'], with_schema['entry'])
            self.assertNotIn('configSchema', without)
            self.assertEqual(with_schema['configSchema'], schema)
            bundle = runtime / 'apps' / with_schema['entry'].split('/')[2]
            self.assertEqual(sorted(item.name for item in bundle.iterdir()), ['index.html'])
            # The same files with different schema metadata share one bundle folder
            # but each emission carries its own schema.
            other = root / 'other.json'
            other.write_text(json.dumps({'fields': [{'key': 'other', 'type': 'boolean'}]}))
            second = json.loads(subprocess.check_output(command + ['--config-schema', str(other)]))
            self.assertEqual(second['entry'], with_schema['entry'])
            self.assertEqual(second['configSchema'], {'fields': [{'key': 'other', 'type': 'boolean'}]})
            self.assertEqual(sorted(item.name for item in bundle.iterdir()), ['index.html'])

    def test_notes_example_schema_stays_outside_the_served_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runtime = root / 'runtime'
            repo = SCRIPT.parents[1]
            source = repo / 'examples/plugins/notes'
            schema = repo / 'examples/plugin-config/notes.schema.json'
            command = ['python3', str(SCRIPT), str(source), '--id', 'notes', '--version', '1.0.0',
                       '--title', 'Workspace notes', '--runtime', str(runtime), '--config-schema', str(schema)]
            manifest = json.loads(subprocess.check_output(command))
            self.assertEqual(manifest['configSchema'], json.loads(schema.read_text()))
            bundle = runtime / 'apps' / manifest['entry'].split('/')[2]
            # The author schema lives outside the served folder: only the app is hashed.
            self.assertEqual(sorted(item.name for item in bundle.iterdir()), ['index.html'])
            self.assertNotIn('notes.schema.json', [item.name for item in bundle.rglob('*')])

    def test_invalid_config_schema_is_rejected_before_publication(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, runtime, command = self.setup_bundle(root)
            cases = {
                'unknown-type': '{"fields":[{"key":"a","type":"object"}]}',
                'unknown-property': '{"fields":[{"key":"a","type":"string","regex":".*"}]}',
                'default-outside-enum': '{"fields":[{"key":"a","type":"string","enum":["x"],"default":"z"}]}',
                'min-above-max': '{"fields":[{"key":"a","type":"number","min":5,"max":1}]}',
                'duplicate-json-key': '{"fields":[],"fields":[]}',
                'not-json': '{not json',
            }
            for name, text in cases.items():
                with self.subTest(name=name):
                    path = root / (name + '.json')
                    path.write_text(text)
                    result = subprocess.run(command + ['--config-schema', str(path)], capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, '')
                    self.assertFalse((runtime / 'apps').exists())
            schema_path = root / 'ok.json'
            schema_path.write_text(json.dumps({'fields': []}))
            link = root / 'link.json'
            link.symlink_to(schema_path)
            self.assertNotEqual(subprocess.run(command + ['--config-schema', str(link)], capture_output=True).returncode, 0)
            oversized = root / 'oversized.json'
            oversized.write_text('{"fields":[]}' + ' ' * 16_001)
            self.assertNotEqual(subprocess.run(command + ['--config-schema', str(oversized)], capture_output=True).returncode, 0)
            self.assertFalse((runtime / 'apps').exists())



if __name__ == '__main__':
    unittest.main()
