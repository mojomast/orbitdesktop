"""Offline, byte-identical Orbit read-runtime vendor/check; never used by the server."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess


PACKAGE = Path('contrib/rizzstack_rails')
DEST = Path(__file__).resolve().parents[2] / PACKAGE
MODULES = tuple(sorted(name + '.py' for name in (
    '__init__', 'ledger', 'contracts', 'privacy', 'source', 'importer', 'query',
    'projection', 'markdown', 'shell_labels', 'feedback', 'export')))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True, help='local BundleBees checkout')
    pins = parser.add_mutually_exclusive_group(required=True)
    pins.add_argument('--rev', help='full reviewed BundleBees Git commit; ignores working-tree edits')
    pins.add_argument('--working-tree', action='store_true', help='unreviewed integration candidate only')
    parser.add_argument('--check', action='store_true', help='compare without writing')
    args = parser.parse_args()
    if args.rev and not re.fullmatch('[0-9a-f]{40}', args.rev):
        parser.error('--rev requires a full commit id')
    if args.rev and subprocess.check_output(['git', 'cat-file', '-t', args.rev], cwd=args.source) != b'commit\n':
        parser.error('--rev must name a commit')
    files = {}
    for name in MODULES:
        path = PACKAGE / name
        if args.working_tree:
            files[name] = (args.source / path).read_bytes()
        else:
            files[name] = subprocess.check_output(['git', 'show', f'{args.rev}:{path.as_posix()}'], cwd=args.source)
    entries = [{'path': (PACKAGE / name).as_posix(), 'bytes': len(data),
                'sha256': hashlib.sha256(data).hexdigest()} for name, data in files.items()]
    if args.rev:
        source_manifest = json.loads(subprocess.check_output(
            ['git', 'show', f'{args.rev}:{PACKAGE.as_posix()}/vendor-manifest.json'], cwd=args.source))
        if source_manifest.get('schema') != 'rizzstack.vendor-manifest/1':
            parser.error('invalid canonical manifest at revision')
        pins = {e['path']:e for e in source_manifest['files']}
        if any(pins.get(e['path']) != e for e in entries):
            parser.error('reviewed revision does not pin all Orbit read-runtime bytes')
    manifest = {'schema': 'rizzstack.vendor-manifest/1', 'source_package': PACKAGE.as_posix(),
                'pin_label': args.rev or 'unreviewed-working-tree', 'files': entries}
    files['vendor-manifest.json'] = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
    if set(f.name for f in DEST.glob('*.py')) - set(files):
        parser.error('unexpected destination modules (not removed)')
    if DEST.is_symlink() or any((DEST / name).is_symlink() for name in files):
        parser.error('refusing symlinked vendor destination')
    if not args.check:
        DEST.mkdir(exist_ok=True)
    for name, data in files.items():
        target = DEST / name
        if target.is_file() and target.read_bytes() == data:
            continue
        if args.check:
            parser.error('destination mismatch: ' + name)
        target.write_bytes(data)
    print(f'{len(entries)} byte-pinned modules; {manifest["pin_label"]}')


if __name__ == '__main__':
    main()
