"""Offline producer tests. Never consult a checkout, network or gh config."""

import importlib.util
import io
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('release_read', Path(__file__).resolve().parents[1] / 'scripts/hive_release_read.py')
reader = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reader)

A, B, C, PREDICTED = [s * 40 for s in 'abcd']
REPOS = {'workflow': (1455472841, 91), 'bundlebees': (1454339884, 82),
         'hyvv': (1455851481, 26), 'orbitdesktop': (1377703993, 46)}


def api(path):
    _, prefix, owner, repo, *tail = path.split('/')
    assert (prefix, owner) == ('repos', 'mojomast')
    rid, number = REPOS[repo]
    slug = 'mojomast/' + repo
    url = 'https://api.github.com/repos/' + slug
    meta = dict(id=rid, full_name=slug, private=False, visibility='public', url=url, default_branch='main')
    if not tail:
        data = meta
    elif tail == ['git', 'ref', 'heads', 'main']:
        data = dict(ref='refs/heads/main', url=url + '/git/refs/heads/main',
                    object=dict(type='commit', sha=A, url=url + '/git/commits/' + A))
    elif len(tail) == 2 and tail[0] == 'pulls':
        n = int(tail[1]); assert n == number or (repo, n) == ('orbitdesktop', 48)
        data = dict(number=n, url=url + '/pulls/' + str(n), draft=False, state='open', merged=False,
                    merged_at=None, merge_commit_sha=PREDICTED, head=dict(repo=meta, sha=B),
                    base=dict(repo=meta.copy(), ref='main', sha=C), title='PRIVATE_TEST_MESSAGE')
    else:
        # No branch names, predicted merge SHAs, GitHub-supplied endpoints or follow-up pages.
        assert tail in [['commits', s, 'check-runs?filter=latest&per_page=50&page=1'] for s in [A, B]]
        data = dict(total_count=1, check_runs=[dict(id=42, url=url + '/check-runs/42', head_sha=tail[1],
            status='completed', conclusion='skipped', output={'text': 'PRIVATE_TEST_MESSAGE'})])
    return data, False


class ReleaseReaderTest(unittest.TestCase):
    def test_bounded_capture_drops_prose_urls_and_predicted_sha(self):
        with patch.object(reader, '_get', side_effect=api) as transport:
            out = reader.collect(include_hive=True)
        self.assertEqual(transport.call_count, 22)
        self.assertEqual([r['repo'] for r in out['repos']], ['mojomast/' + r for r in REPOS])
        self.assertEqual([p['number'] for p in out['repos'][-1]['prs']], [46, 48])
        pin = out['repos'][0]['prs'][0]
        self.assertEqual((pin['head'], pin['base'], pin['mergedSha'], pin['mergedAt']), (B, C, None, None))
        self.assertEqual((pin['checks']['sha'], pin['checks']['skipped'], pin['checks']['success']), (B, 1, 0))
        for secret in [PREDICTED, 'PRIVATE_TEST_MESSAGE', 'https://']:
            self.assertNotIn(secret, json.dumps(out))

    def mutated(self, suffix, change):
        def get(path):
            data, more = api(path)
            if path.endswith(suffix):
                change(data)
            return data, more
        with patch.object(reader, '_get', side_effect=get):
            return reader.collect()

    def test_wrong_repo_sha_or_incoherent_merge_is_rejected(self):
        matrix = [('/workflow', lambda x: x.update(private=True)), ('/workflow', lambda x: x.update(id=1)),
            ('/main', lambda x: x.update(ref='refs/heads/next')), ('/main', lambda x: x['object'].update(type='tag')),
            ('/main', lambda x: x['object'].update(sha='main')), ('/91', lambda x: x.update(number=82)),
            ('/91', lambda x: x.update(number=91.0)), ('/91', lambda x: x['base'].update(sha='0' * 40)),
            ('/91', lambda x: x['head']['repo'].update(full_name='another-owner/workflow')),
            ('/91', lambda x: x['base'].update(ref='next')), ('/91', lambda x: x.update(draft=1)),
            ('/91', lambda x: x.update(merged=True, merged_at='2026-01-01T00:00:00Z')),
            ('/91', lambda x: x.update(state='closed', merged=True)),
            ('/91', lambda x: x.update(state='closed', merged=True, merged_at='2025-02-30T00:00:00Z')),
            ('/91', lambda x: x.update(merged_at='2026-01-01T00:00:00Z')),
            ('page=1', lambda x: x['check_runs'][0].update(head_sha=C)),
            ('page=1', lambda x: x['check_runs'][0].update(url='https://example.invalid/')),
            ('page=1', lambda x: x['check_runs'][0].update(status='queued', conclusion='success')),
            ('page=1', lambda x: x.update(total_count=True)),
            ('page=1', lambda x: x.update(total_count=2, check_runs=x['check_runs'] * 2))]
        for suffix, change in matrix:
            with self.subTest(suffix=suffix, change=change), self.assertRaises(ValueError):
                self.mutated(suffix, change)

    def test_merged_receipt_partial_sample_and_zero_are_distinct(self):
        out = self.mutated('/91', lambda x: x.update(state='closed', merged=True, merged_at='2020-01-01T00:00:00Z', merge_commit_sha=C))
        pr = out['repos'][0]['prs'][0]
        self.assertEqual((pr['state'], pr['mergedAt'], pr['mergedSha']), ('merged', '2020-01-01T00:00:00.000Z', C))
        self.assertEqual(len(out['repos'][-1]['prs']), 1)
        out = self.mutated('page=1', lambda x: x.update(total_count=99))
        self.assertTrue(out['repos'][0]['main']['checks']['truncated'])
        out = self.mutated('page=1', lambda x: x.update(total_count=0, check_runs=[]))
        self.assertEqual(out['repos'][0]['main']['checks']['sampled'], 0)
        self.assertFalse(out['repos'][0]['main']['checks']['truncated'])

    def test_private_atomic_publish_preserves_previous_on_failure(self):
        with tempfile.TemporaryDirectory() as d, patch.object(reader, '_get', side_effect=api):
            dest = Path(d) / 'release.json'
            reader.publish(d, include_hive=False)
            old_inode = dest.stat().st_ino
            self.assertEqual(stat.S_IMODE(dest.stat().st_mode), 0o600)
            reader.publish(d, include_hive=True)
            self.assertNotEqual(old_inode, dest.stat().st_ino)
            old = dest.read_bytes()
            with patch.object(reader, '_get', side_effect=TimeoutError), self.assertRaises(TimeoutError):
                reader.publish(d, include_hive=False)
            self.assertEqual(dest.read_bytes(), old)
            self.assertEqual(os.listdir(d), ['release.json'])
            os.chmod(d, 0o755)
            with self.assertRaises(ValueError):
                reader.publish(d, include_hive=False)

    def test_transport_rejects_unenrolled_paths_before_connection(self):
        with patch.object(reader.http.client, 'HTTPSConnection', side_effect=AssertionError('must not dial')):
            for path in ['https://example.invalid/', '/repos/mojomast/workflow/pulls/92',
                         '/repos/mojomast/other/git/ref/heads/main', '/repos/mojomast/workflow/commits/main/check-runs']:
                with self.subTest(path=path), self.assertRaises(ValueError):
                    reader._get(path)

    def test_transport_bounds_and_rejects_redirects_without_forwarding_credentials(self):
        class Response(io.BytesIO):
            status = 200

            def getheader(self, key, default=None):
                return {'Content-Type': 'application/json', 'Location': 'https://example.invalid/'}.get(key, default)

        path = '/repos/mojomast/workflow'
        for status, raw in [(302, b'{}'), (200, b'{"repo":1,"repo":2}'), (200, b' ' * (reader.MAX_INPUT + 1))]:
            with self.subTest(status=status, size=len(raw)), patch.object(reader.http.client, 'HTTPSConnection') as dial:
                response = Response(raw)
                response.status = status
                conn = dial.return_value
                conn.getresponse.return_value = response
                with self.assertRaises(ValueError):
                    reader._get(path)
                dial.assert_called_once_with('api.github.com', timeout=6)
                conn.request.assert_called_once()
                self.assertEqual(conn.request.call_args.args, ('GET', path))
                self.assertFalse({'Authorization', 'Cookie'} & conn.request.call_args.kwargs['headers'].keys())
                conn.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
