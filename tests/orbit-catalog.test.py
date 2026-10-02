#!/usr/bin/env python3
import copy
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('catalog', ROOT / 'scripts/orbit_catalog.py')
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)
ENTRY = json.loads((ROOT / 'examples/catalog/notes.json').read_text())


def archive(files):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as tar:
        for name, content, kind in files:
            info = tarfile.TarInfo(name)
            info.type = kind
            info.size = len(content) if kind == tarfile.REGTYPE else 0
            info.linkname = '/etc/passwd' if kind == tarfile.SYMTYPE else ''
            tar.addfile(info, io.BytesIO(content))
    return buffer.getvalue()


class CatalogTests(unittest.TestCase):
    def test_backend_schema(self):
        backend = {'path': 'backend', 'runtime': 'python3', 'permissions': ['Read aggregate host metrics']}
        self.assertEqual(catalog.validate(dict(ENTRY, backend=backend))['backend'], backend)
        for patch in [{'path': '../private'}, {'path': '/tmp'}, {'runtime': 'sh'}, {'permissions': []}, {'permissions': [False]}, {'install': 'curl | sh'}]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                catalog.validate(dict(ENTRY, backend=dict(backend, **patch)))

    def test_backend_bundle_validation_never_executes(self):
        entry = dict(ENTRY, backend={'path':'backend','runtime':'python3','permissions':['host']})
        manifest = {'apiVersion':1,'id':entry['id'],'version':entry['version'],'runtime':'python3','entry':'main.py'}
        files = [('root/backend/extension.json', json.dumps(manifest).encode(), tarfile.REGTYPE), ('root/backend/main.py', b'raise RuntimeError("MUST NOT EXECUTE")', tarfile.REGTYPE)]
        with tempfile.TemporaryDirectory() as temp, patch.object(catalog, 'fetch', return_value=archive(files)):
            self.assertEqual(catalog.source(entry, Path(temp), backend=True), 2)
        manifest['id'] = 'wrong'
        files[0] = ('root/backend/extension.json', json.dumps(manifest).encode(), tarfile.REGTYPE)
        with tempfile.TemporaryDirectory() as temp, patch.object(catalog, 'fetch', return_value=archive(files)), self.assertRaises(ValueError):
            catalog.source(entry, Path(temp), backend=True)

    def test_example(self):
        entry = catalog.validate(copy.deepcopy(ENTRY), 'notes.json')
        self.assertEqual(entry['id'], 'notes')
        # The pinned Notes example declares exactly its supported primitive keys.
        self.assertEqual([field['key'] for field in entry['configSchema']['fields']], ['title', 'message'])

    def test_mutable_pins(self):
        for sha in ['main', 'v1.0.0', '1234567', 'A' * 40, None]:
            with self.subTest(sha=sha), self.assertRaises(ValueError):
                catalog.validate(dict(ENTRY, sha=sha))

    def test_unsafe_repositories(self):
        for repo in ['file:///tmp/repo', 'http://github.com/a/b', 'https://evil.com/a/b', 'https://github.com/a/b?x', 'https://github.com/a/b.git']:
            with self.subTest(repo=repo), self.assertRaises(ValueError):
                catalog.validate(dict(ENTRY, repo=repo))

    def test_unsafe_paths(self):
        for path in ['/tmp', '../app', 'app/../dist', 'app//dist', '.hidden', 'app\\dist', None]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                catalog.validate(dict(ENTRY, path=path))

    def test_unknown_fields_and_bad_capabilities(self):
        for entry in [dict(ENTRY, install='sh x'), dict(ENTRY, capabilities={'network': 'false', 'storage': False}), dict(ENTRY, title='<script>\n')]:
            with self.assertRaises(ValueError):
                catalog.validate(entry)

    def test_duplicate_json_keys(self):
        with self.assertRaises(ValueError):
            catalog.read_json('{"id":"a","id":"b"}')

    def test_filename(self):
        with self.assertRaises(ValueError):
            catalog.validate(ENTRY, 'other.json')

    def test_removed_id_and_repo(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            (folder / 'notes.json').write_text(json.dumps(ENTRY))
            for removed in [dict(id='notes', repo='https://github.com/other/repo'), dict(id='different', repo=ENTRY['repo'].upper().replace('HTTPS://GITHUB.COM/', 'https://github.com/'))]:
                removed.update(reason='Security review', date='2026-01-01')
                (folder / 'removed.json').write_text(json.dumps([removed]))
                with self.assertRaises(ValueError):
                    catalog.load_catalog(folder)

    def unpack(self, files):
        with tempfile.TemporaryDirectory() as temp:
            return catalog.unpack(dict(ENTRY, path='dist'), archive(files), Path(temp))

    def test_static_bundle(self):
        self.assertEqual(self.unpack([('root/dist/index.html', b'<h1>test</h1>', tarfile.REGTYPE), ('root/source/unused', b'x', tarfile.REGTYPE)]), 1)

    def test_missing_entrypoint(self):
        with self.assertRaises(ValueError):
            self.unpack([('root/dist/other.html', b'x', tarfile.REGTYPE)])

    def test_symlink_and_hidden_file(self):
        for name, kind in [('root/dist/link', tarfile.SYMTYPE), ('root/dist/.env', tarfile.REGTYPE), ('root/dist/link', tarfile.LNKTYPE)]:
            with self.subTest(name=name, kind=kind), self.assertRaises(ValueError):
                self.unpack([(name, b'x', kind)])

    def test_traversal_and_multiple_roots(self):
        for files in [[('../evil', b'x', tarfile.REGTYPE)], [('root/dist/index.html', b'x', tarfile.REGTYPE), ('other/dist/a', b'x', tarfile.REGTYPE)]]:
            with self.assertRaises(ValueError):
                self.unpack(files)

    def test_file_and_size_limits(self):
        with self.assertRaises(ValueError):
            self.unpack([(f'root/dist/f{i}', b'x', tarfile.REGTYPE) for i in range(501)])
        with patch.object(catalog, 'MAX_BYTES', 2), self.assertRaises(ValueError):
            self.unpack([('root/dist/index.html', b'abc', tarfile.REGTYPE)])

    def test_duplicate_files(self):
        with self.assertRaises(ValueError):
            self.unpack([('root/dist/index.html', b'x', tarfile.REGTYPE)] * 2)

    def test_materialize_atomic_and_publisher(self):
        def static_source(entry, folder):
            (folder / 'index.html').write_text('<h1>Catalog unit fixture</h1>')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / 'catalog.json'
            with patch.object(catalog, 'source', static_source):
                result = catalog.materialize([ENTRY], root / 'runtime', output, 'f' * 40)
                self.assertTrue((root / 'runtime' / result['entries'][0]['manifest']['entry'].lstrip('/')).is_file())
                original = output.read_bytes()
                catalog.materialize([ENTRY], root / 'runtime', output, 'f' * 40)
                self.assertEqual(original, output.read_bytes())
            with patch.object(catalog, 'source', side_effect=OSError('offline')):
                with self.assertRaises(OSError):
                    catalog.materialize([ENTRY], root / 'runtime', output, None)
            self.assertEqual(original, output.read_bytes())
            catalog.materialize([], root / 'runtime', output, None)
            self.assertEqual(json.loads(output.read_text())['entries'], [])
            self.assertTrue((root / 'runtime' / result['entries'][0]['manifest']['entry'].lstrip('/')).is_file())

    INLINE_SCHEMA = {'fields': [
        {'key': 'mode', 'type': 'string', 'title': 'Mode', 'description': 'Pick one.', 'enum': ['light', 'dark'], 'default': 'light', 'required': True},
        {'key': 'count', 'type': 'number', 'min': 0, 'max': 10, 'default': 3},
    ]}

    def test_inline_config_schema_is_validated_and_normalized(self):
        entry = catalog.validate(copy.deepcopy(dict(ENTRY, configSchema=self.INLINE_SCHEMA)))
        self.assertEqual(entry['configSchema'], self.INLINE_SCHEMA)
        # Validation is a pure metadata check; the bundle fields are untouched.
        self.assertEqual(entry['path'], ENTRY['path'])

    def test_invalid_inline_config_schema_is_rejected(self):
        cases = {
            'enum-type-mismatch': {'fields': [{'key': 'a', 'type': 'string', 'enum': ['x', 2]}]},
            'default-outside-enum': {'fields': [{'key': 'a', 'type': 'string', 'enum': ['x'], 'default': 'z'}]},
            'default-type-mismatch': {'fields': [{'key': 'a', 'type': 'number', 'default': 'x'}]},
            'default-out-of-range': {'fields': [{'key': 'a', 'type': 'number', 'min': 1, 'max': 2, 'default': 5}]},
            'unknown-field-property': {'fields': [{'key': 'a', 'type': 'string', 'regex': '.*'}]},
            'unknown-top-property': {'fields': [], 'url': 'https://evil/schema.json'},
            'required-empty-default': {'fields': [{'key': 'a', 'type': 'string', 'required': True, 'default': ''}]},
            'boolean-enum': {'fields': [{'key': 'a', 'type': 'boolean', 'enum': [True, False]}]},
            'url-string': 'https://evil.example/schema.json',
        }
        for name, schema in cases.items():
            with self.subTest(name=name), self.assertRaises(ValueError):
                catalog.validate(copy.deepcopy(dict(ENTRY, configSchema=schema)))

    def test_materialize_preserves_schema_with_deterministic_identity(self):
        def static_source(entry, folder):
            (folder / 'index.html').write_text('<h1>Catalog schema unit fixture</h1>')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime = root / 'runtime'
            with patch.object(catalog, 'source', static_source):
                entry = catalog.validate(copy.deepcopy(dict(ENTRY, configSchema=self.INLINE_SCHEMA)))
                with_schema = catalog.materialize([entry], runtime, root / 'with.json', 'a' * 40)
                manifest = with_schema['entries'][0]['manifest']
                self.assertEqual(manifest['configSchema'], self.INLINE_SCHEMA)
                self.assertEqual(with_schema['entries'][0]['provenance']['configSchema'], self.INLINE_SCHEMA)
                # Deterministic output and no schema file inside the served bundle.
                first_bytes = (root / 'with.json').read_bytes()
                catalog.materialize([entry], runtime, root / 'with.json', 'a' * 40)
                self.assertEqual(first_bytes, (root / 'with.json').read_bytes())
                bundle = runtime / manifest['entry'].lstrip('/')
                self.assertEqual(sorted(item.name for item in bundle.parent.iterdir()), ['index.html'])
                # The same source without a schema keeps an identical content identity.
                plain_entry = {key: value for key, value in ENTRY.items() if key != 'configSchema'}
                plain = catalog.materialize([catalog.validate(copy.deepcopy(plain_entry))], runtime, root / 'without.json', 'a' * 40)
                self.assertEqual(plain['entries'][0]['manifest']['entry'], manifest['entry'])
                self.assertNotIn('configSchema', plain['entries'][0]['manifest'])
                # An invalid schema can never reach the publisher temp file.
                with self.assertRaises(ValueError):
                    catalog.validate(copy.deepcopy(dict(ENTRY, configSchema={'fields': [{'key': 'a', 'type': 'object'}]})))

    def test_packaged_catalog_schema_is_valid_and_reserved(self):
        schema = json.loads((ROOT / 'plugin-catalog/schema.json').read_text())
        self.assertEqual(schema['$schema'], 'https://json-schema.org/draft/2020-12/schema')
        self.assertEqual(schema['properties']['configSchema']['properties']['fields']['maxItems'], catalog.publish.MAX_SCHEMA_FIELDS)
        self.assertIn('schema.json', catalog.RESERVED_CATALOG_FILES)

    def test_schema_file_is_reserved_not_an_entry(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            (folder / 'notes.json').write_text(json.dumps(ENTRY))
            (folder / 'removed.json').write_text('[]')
            (folder / 'schema.json').write_text('{"title":"catalog entry schema"}')
            self.assertEqual([entry['id'] for entry in catalog.load_catalog(folder)], ['notes'])

    def test_reviewed_catalog_skips_reserved_files(self):
        sha = 'b' * 40
        def fetch(url, limit):
            if '/commits/main' in url:
                return json.dumps({'sha': sha}).encode()
            if '/contents/' in url:
                return json.dumps([
                    {'name': 'notes.json', 'type': 'file'},
                    {'name': 'schema.json', 'type': 'file'},
                    {'name': 'removed.json', 'type': 'file'},
                ]).encode()
            return json.dumps(ENTRY).encode()
        with tempfile.TemporaryDirectory() as temp, patch.object(catalog, 'fetch', fetch):
            destination = Path(temp)
            self.assertEqual(catalog.reviewed_catalog(destination), sha)
            self.assertTrue((destination / 'notes.json').is_file())
            self.assertFalse((destination / 'schema.json').exists())

    def test_catalog_snapshot_pins_all_reads(self):
        sha = 'a' * 40
        urls = []
        def fetch(url, limit):
            urls.append(url)
            if '/commits/main' in url:
                return json.dumps({'sha': sha}).encode()
            if '/contents/' in url:
                return b'[{"name":"removed.json","type":"file"}]'
            return b'[]'
        with tempfile.TemporaryDirectory() as temp, patch.object(catalog, 'fetch', fetch):
            self.assertEqual(catalog.reviewed_catalog(Path(temp)), sha)
            self.assertEqual(catalog.load_catalog(Path(temp)), [])
        self.assertIn('ref=' + sha, urls[1])
        self.assertIn('/' + sha + '/', urls[2])


if __name__ == '__main__':
    unittest.main(verbosity=2)
