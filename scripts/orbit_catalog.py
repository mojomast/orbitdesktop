#!/usr/bin/env python3
"""Reviewed GitHub catalog for static Orbit apps. Never executes plugin code."""
import argparse
import datetime
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = 'mojomast/orbitdesktop'
MAX_BYTES = 20_000_000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(text):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'Duplicate JSON key: ' + key)
            result[key] = value
        return result
    return json.loads(text, object_pairs_hook=pairs)


def text(value, limit):
    return isinstance(value, str) and 0 < len(value) <= limit and not any(ord(c) < 32 for c in value)


def repo_valid(value):
    return isinstance(value, str) and re.fullmatch(r'https://github\.com/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+', value) and not value.endswith('.git')


def validate(entry, filename=None):
    fields = {'id', 'title', 'version', 'description', 'category', 'maintainer', 'license', 'repo', 'sha', 'path', 'capabilities'}
    require(isinstance(entry, dict) and set(entry) in (fields, fields | {'backend'}), 'Entry must contain required fields and optional backend')
    if 'backend' in entry:
        backend = entry['backend']
        require(isinstance(backend, dict) and set(backend) == {'path', 'runtime', 'permissions'}, 'Invalid backend declaration')
        require(backend['runtime'] == 'python3', 'Only python3 backends supported')
        require(isinstance(backend['path'], str) and 0 < len(backend['path']) <= 200 and all(re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9_.-]*', p) for p in backend['path'].split('/')), 'Unsafe backend path')
        require(isinstance(backend['permissions'], list) and 0 < len(backend['permissions']) <= 10 and all(text(p, 200) for p in backend['permissions']), 'Declare backend host access')
    require(isinstance(entry['id'], str) and re.fullmatch(r'[a-z][a-z0-9-]{0,25}', entry['id']), 'Invalid id')
    require(filename is None or filename == entry['id'] + '.json', 'Filename must match id')
    require(isinstance(entry['version'], str) and re.fullmatch(r'\d+\.\d+\.\d+', entry['version']), 'Version must be x.y.z')
    for key, limit in [('title', 60), ('description', 400), ('category', 40), ('maintainer', 80), ('license', 80)]:
        require(text(entry[key], limit), 'Invalid ' + key)
    require(repo_valid(entry['repo']), 'Only canonical public HTTPS GitHub repositories are supported')
    require(isinstance(entry['sha'], str) and re.fullmatch(r'[a-f0-9]{40}', entry['sha']), 'Full lowercase 40-character commit SHA required')
    path = entry['path']
    require(isinstance(path, str) and 0 < len(path) <= 200, 'Invalid bundle path')
    require(path == '.' or all(re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9_.-]*', p) for p in path.split('/')), 'Unsafe bundle path')
    require(isinstance(entry['capabilities'], dict) and set(entry['capabilities']) == {'network', 'storage'}, 'Declare network and storage capabilities')
    require(all(type(v) is bool for v in entry['capabilities'].values()), 'Capabilities must be booleans')
    return entry


def load_catalog(folder):
    removed = read_json((folder / 'removed.json').read_text())
    require(isinstance(removed, list), 'removed.json must be an array')
    for item in removed:
        require(isinstance(item, dict) and set(item) == {'id', 'repo', 'reason', 'date'}, 'Invalid removal')
        require(isinstance(item['id'], str) and re.fullmatch(r'[a-z][a-z0-9-]{0,25}', item['id']) and repo_valid(item['repo']) and text(item['reason'], 500), 'Invalid removal fields')
        datetime.date.fromisoformat(item['date'])
    entries = []
    ids = set()
    for file in sorted(folder.glob('*.json')):
        if file.name == 'removed.json':
            continue
        require(not file.is_symlink() and file.stat().st_size <= 16_000, 'Invalid entry file')
        entry = validate(read_json(file.read_text()), file.name)
        require(entry['id'] not in ids, 'Duplicate id')
        require(not any(entry['id'] == r['id'] or entry['repo'].lower() == r['repo'].lower() for r in removed), 'Blocked catalog entry: ' + entry['id'])
        ids.add(entry['id'])
        entries.append(entry)
    return entries


def fetch(url, limit):
    request = urllib.request.Request(url, headers={'User-Agent': 'Orbit-Catalog/1', 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(request, timeout=45) as response:
        require(urlparse(response.url).scheme == 'https', 'Insecure redirect')
        data = response.read(limit + 1)
    require(len(data) <= limit, 'Download exceeds limit')
    return data


def reviewed_catalog(destination):
    commit = read_json(fetch(f'https://api.github.com/repos/{UPSTREAM}/commits/main', 1_000_000))['sha']
    require(re.fullmatch('[a-f0-9]{40}', commit), 'Invalid upstream commit')
    listing = read_json(fetch(f'https://api.github.com/repos/{UPSTREAM}/contents/plugin-catalog?ref={commit}', 2_000_000))
    require(isinstance(listing, list) and len(listing) <= 500, 'Invalid catalog listing')
    for item in listing:
        name = item['name']
        if not name.endswith('.json'):
            continue
        require(re.fullmatch(r'[a-z][a-z0-9-]*\.json', name) and item['type'] == 'file', 'Invalid catalog filename')
        data = fetch(f'https://raw.githubusercontent.com/{UPSTREAM}/{commit}/plugin-catalog/{name}', 16_000)
        (destination / name).write_bytes(data)
    return commit


def unpack(entry, archive, destination, required='index.html'):
    """Copy only regular bundle files; no extractall, links, builds or install hooks."""
    total = 0
    names = set()
    roots = set()
    expanded = 0
    members = 0
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r|gz') as tar:
        for member in tar:
            expanded += member.size
            members += 1
            require(expanded <= 200_000_000 and members <= 100_000, 'Repository archive exceeds safety limits')
            raw = member.name
            parts = PurePosixPath(raw).parts
            require(parts and not raw.startswith('/') and '..' not in parts, 'Unsafe archive path')
            roots.add(parts[0])
            require(len(roots) == 1, 'Unexpected archive roots')
            relative = '/'.join(parts[1:])
            prefix = '' if entry['path'] == '.' else entry['path'] + '/'
            if prefix and not relative.startswith(prefix):
                continue
            relative = relative[len(prefix):]
            if not relative or member.isdir():
                continue
            require(member.isfile(), 'Links and special files are forbidden in bundles')
            require(not any(p.startswith('.') for p in PurePosixPath(relative).parts), 'Hidden bundle files are forbidden')
            require(relative not in names, 'Duplicate archive file')
            names.add(relative)
            total += member.size
            require(total <= MAX_BYTES and len(names) <= 500, 'Bundle exceeds 20 MB / 500 files')
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(tar.extractfile(member).read())
    require(required in names, 'Bundle needs ' + required + ' at the declared path')
    return len(names)


def source(entry, destination, backend=False):
    slug = entry['repo'].removeprefix('https://github.com/')
    archive = fetch(f'https://codeload.github.com/{slug}/tar.gz/{entry["sha"]}', 50_000_000)
    if backend:
        count = unpack(dict(entry, path=entry['backend']['path']), archive, destination, 'extension.json')
        manifest = read_json((destination / 'extension.json').read_text())
        require(manifest == {'apiVersion': 1, 'id': entry['id'], 'version': entry['version'], 'runtime': 'python3', 'entry': 'main.py'}, 'Backend manifest must match catalog')
        require((destination / 'main.py').is_file(), 'Missing backend main.py')
        return count
    return unpack(entry, archive, destination)


def materialize(entries, runtime, output, catalog_commit):
    result = []
    for entry in entries:
        with tempfile.TemporaryDirectory(prefix='orbit-catalog-app-') as temp:
            folder = Path(temp)
            source(entry, folder)
            command = [sys.executable, str(ROOT / 'scripts/plugin_publish.py'), str(folder), '--id', entry['id'], '--version', entry['version'], '--title', entry['title'], '--runtime', str(runtime)]
            manifest = read_json(subprocess.check_output(command, text=True, timeout=60))
            result.append({'manifest': manifest, 'category': entry['category'], 'description': entry['description'], 'provenance': entry})
    output.parent.mkdir(parents=True, exist_ok=True)
    data = {'version': 1, 'source': f'https://github.com/{UPSTREAM}/tree/main/plugin-catalog', 'catalogCommit': catalog_commit, 'entries': result}
    with tempfile.NamedTemporaryFile(mode='w', dir=output.parent, prefix='.catalog-', delete=False) as handle:
        json.dump(data, handle, indent=2)
        temporary = Path(handle.name)
    temporary.replace(output)
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['validate', 'sync'])
    parser.add_argument('--catalog', type=Path, help='Local reviewed catalog checkout; sync otherwise reads upstream main')
    parser.add_argument('--sources', action='store_true', help='Validate pinned static bundles without executing their code')
    parser.add_argument('--runtime', type=Path, default=ROOT / '.runtime')
    parser.add_argument('--output', type=Path, default=ROOT / 'public/orbit-community-catalog.json')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='orbit-catalog-') as temp:
        folder = args.catalog
        commit = None
        if folder is None:
            if args.command == 'validate':
                folder = ROOT / 'plugin-catalog'
            else:
                folder = Path(temp)
                commit = reviewed_catalog(folder)
        entries = load_catalog(folder)
        if args.command == 'sync':
            materialize(entries, args.runtime, args.output, commit)
            print(f'Synced {len(entries)} catalog apps to {args.output}; no workspace changed or app enabled.')
        else:
            if args.sources:
                for entry in entries:
                    with tempfile.TemporaryDirectory() as bundle:
                        count = source(entry, Path(bundle))
                        print(f'Validated {entry["id"]}@{entry["sha"]}: {count} static files')
                    if 'backend' in entry:
                        with tempfile.TemporaryDirectory() as backend:
                            count = source(entry, Path(backend), backend=True)
                            print(f'Validated {entry["id"]}: {count} backend files, NOT executed')
            print(f'PASS: {len(entries)} catalog entries')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, tarfile.TarError, subprocess.SubprocessError) as error:
        print(f'Catalog error: {error}', file=sys.stderr)
        sys.exit(1)
