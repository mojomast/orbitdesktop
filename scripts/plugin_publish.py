#!/usr/bin/env python3
"""Publish a content-addressed static plugin bundle."""

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path


def collect(root, parser):
    files = []
    directories = set()
    size = 0

    def visit(directory):
        nonlocal size
        for item in sorted(directory.iterdir()):
            relative = item.relative_to(root)
            if any(part.startswith('.') for part in relative.parts):
                parser.error('Hidden files are not allowed')
            mode = item.lstat().st_mode
            if stat.S_ISLNK(mode):
                parser.error('Symlinks are not allowed')
            if stat.S_ISDIR(mode):
                directories.add(relative)
                visit(item)
            elif stat.S_ISREG(mode):
                fd = os.open(item, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
                with os.fdopen(fd, 'rb') as stream:
                    info = os.fstat(stream.fileno())
                    if not stat.S_ISREG(info.st_mode) or size + info.st_size > 20_000_000:
                        parser.error('Bundle limit or non-regular file')
                    content = stream.read(20_000_000 - size + 1)
                size += len(content)
                if size > 20_000_000 or len(files) >= 500:
                    parser.error('Bundle limit: 20 MB / 500 files')
                files.append((relative, content))
            else:
                parser.error('Only regular files and directories are allowed')

    mode = root.lstat().st_mode
    if not stat.S_ISDIR(mode) or stat.S_ISLNK(mode):
        parser.error('Bundle root must be a directory, not a symlink')
    visit(root)
    # Preserve the original publisher's sorted(Path) ordering across the
    # entire tree, including similarly named nested and sibling files.
    files.sort(key=lambda entry: entry[0])
    digest = hashlib.sha256()
    for relative, content in files:
        name = relative.as_posix().encode()
        digest.update(len(name).to_bytes(8, 'big') + name + len(content).to_bytes(8, 'big') + content)
    return files, directories, digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    parser.add_argument('--id', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--title', required=True)
    parser.add_argument('--runtime', type=Path, default=Path(__file__).resolve().parents[1] / '.runtime')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,25}', args.id) or not re.fullmatch(r'\d+\.\d+\.\d+', args.version) or not 1 <= len(args.title) <= 60:
        parser.error('Invalid id/version/title')

    files, directories, digest = collect(args.folder, parser)
    if not any(name == Path('index.html') for name, _ in files):
        parser.error('index.html is required')
    slug = args.id + '-' + digest[:24]
    apps = args.runtime / 'apps'
    if apps.is_symlink(): parser.error('Published apps root must not be a symlink')
    apps.mkdir(parents=True, exist_ok=True)
    dest = apps / slug

    if not os.path.lexists(dest):
        staging = Path(tempfile.mkdtemp(prefix='.plugin-stage-', dir=apps))
        try:
            for relative in directories:
                (staging / relative).mkdir(parents=True, exist_ok=True)
            for relative, content in files:
                (staging / relative).write_bytes(content)
            os.rename(staging, dest)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    else:
        existing_files, existing_directories, existing_digest = collect(dest, parser)
        if (existing_directories != directories or existing_digest != digest or
                existing_files != files):
            parser.error('Existing bundle was modified; refusing reuse')

    # The Node CLI owns SQLite writes. A standalone fresh publisher has no DB to register.
    if os.path.lexists(args.runtime / 'workspace.sqlite'):
        cli = Path(__file__).resolve().with_name('workspace_bundles.mjs')
        try:
            subprocess.run(['node', '--experimental-strip-types', str(cli), 'refresh', '--root',
                            str(args.runtime.resolve())], check=True, stdout=subprocess.PIPE, timeout=120)
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            parser.error(f'Bundle published but workspace registration failed: {error}')

    print(json.dumps({'apiVersion': 1, 'id': args.id, 'version': args.version,
                      'title': args.title, 'entry': '/apps/' + slug + '/index.html'}))


if __name__ == '__main__':
    main()
