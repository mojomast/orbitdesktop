#!/usr/bin/env python3
"""Download and stage a pinned catalog backend. Activation remains a separate trust gate."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import orbit_catalog as catalog


def prepare(entry, runtime):
    catalog.validate(entry)
    catalog.require('backend' in entry, 'This app has no backend')
    slug = entry['repo'].removeprefix('https://github.com/')
    archive = catalog.fetch(f'https://codeload.github.com/{slug}/tar.gz/{entry["sha"]}', 50_000_000)
    with tempfile.TemporaryDirectory(prefix='orbit-backend-') as temp:
        folder = Path(temp)
        catalog.unpack(dict(entry, path=entry['backend']['path']), archive, folder, 'extension.json')
        manifest = catalog.read_json((folder / 'extension.json').read_text())
        catalog.require(manifest == {'apiVersion': 1, 'id': entry['id'], 'version': entry['version'], 'runtime': 'python3', 'entry': 'main.py'}, 'Backend manifest must match catalog id/version and python3 contract')
        catalog.require((folder / 'main.py').is_file(), 'Backend requires main.py')
        # Only the trusted runner is executed. Downloaded Python is never imported here.
        import os
        env = dict(os.environ, ORBIT_EXTENSIONS_DIR=str(runtime.resolve()))
        output = subprocess.check_output([sys.executable, str(catalog.ROOT / 'scripts/extensions.py'), 'stage', str(folder)], env=env, text=True)
        return json.loads(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('id')
    parser.add_argument('--catalog', type=Path, help='Explicit reviewed local checkout; otherwise fetch upstream main')
    parser.add_argument('--runtime', type=Path, default=catalog.ROOT / '.runtime/extensions')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as temp:
        folder = args.catalog
        if folder is None:
            folder = Path(temp)
            catalog.reviewed_catalog(folder)
        entries = catalog.load_catalog(folder)
        entry = next((e for e in entries if e['id'] == args.id), None)
        catalog.require(entry is not None, 'App not found in reviewed catalog')
        staged = prepare(entry, args.runtime)
        print(json.dumps({'staged': staged, 'source': entry['repo'], 'sha': entry['sha'], 'permissions': entry['backend']['permissions'], 'notice': 'NOT activated. Review the staged source and deployment instructions. Activation requires extensions.py activate with --trust-host-code. Host code is not sandboxed; rollback cannot undo external effects.'}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        sys.exit(str(error))
