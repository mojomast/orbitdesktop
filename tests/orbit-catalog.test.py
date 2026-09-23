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
    def test_example(self):
        self.assertEqual(catalog.validate(copy.deepcopy(ENTRY), 'notes.json')['id'], 'notes')

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
