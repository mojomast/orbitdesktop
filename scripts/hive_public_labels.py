#!/usr/bin/env python3
"""Publish separately authored Hive titles from two owner-pinned files (Linux)."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys


MODULE = Path(__file__).resolve().parents[1] / 'apps/rizzstack-hive/public-labels.js'
PIN = re.compile(r'[0-9a-f]{64}')
READ_POLICY = """
const {publishLabels, validateLabels} = await import(process.argv[1]);
let text = ''; process.stdin.setEncoding('utf8');
for await (const part of process.stdin) text += part;
const [snapshot, draft, pin] = JSON.parse(text);
const packet = await publishLabels(snapshot, draft, pin);
if (!validateLabels(packet)) throw Error();
process.stdout.write(JSON.stringify(packet) + '\\n');
"""


def require(ok):
    if not ok:
        raise ValueError('refused')


def unique_object(pairs):
    obj = {}
    for k, v in pairs:
        require(k not in obj)
        obj[k] = v
    return obj


@contextmanager
def owner_directory(name):
    """Pin each directory relative to the previous descriptor, never via cwd."""
    require(isinstance(name, str) and name.startswith('/') and len(name) <= 4095)
    parts = name[1:].split('/')
    require(0 < len(parts) <= 32 and all(re.fullmatch(r'[a-zA-Z0-9_. -]{1,255}', p)
            and p not in ('.', '..', '.git', '.runtime', '.hermes') for p in parts))
    flags = os.O_DIRECTORY | os.O_RDONLY | os.O_NOFOLLOW
    fd = os.open('/', flags)
    try:
        for part in [None, *parts]:
            if part is not None:
                child = os.open(part, flags, dir_fd=fd)
                os.close(fd)
                fd = child
            st = os.fstat(fd)
            require(st.st_uid in (0, os.geteuid()) and not st.st_mode & 0o022)
            try:
                os.stat('.git', dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise ValueError('refused')
        require(st.st_uid == os.geteuid() and stat.S_IMODE(st.st_mode) == 0o700)
        yield fd
    finally:
        os.close(fd)


def private_file(st):
    return (stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_uid == os.geteuid()
            and stat.S_IMODE(st.st_mode) in (0o400, 0o600))


def pinned(fd, pin, limit):
    require(isinstance(pin, str) and PIN.fullmatch(pin))
    entry = os.open(pin + '.json', os.O_PATH | os.O_NOFOLLOW, dir_fd=fd)
    try:
        st = os.fstat(entry)
        require(private_file(st) and 0 < st.st_size <= limit)
        # After confirming regular file type, read that inode, not the name again.
        with open(f'/proc/self/fd/{entry}', 'rb') as stream:
            data = stream.read(limit + 1)
        require(len(data) == st.st_size and hashlib.sha256(data).hexdigest() == pin)
        return json.loads(data.decode('utf-8'), object_pairs_hook=unique_object, parse_constant=lambda _: require(False))
    finally:
        os.close(entry)


def replace(fd, data):
    name = 'labels.json'
    try:
        require(private_file(os.stat(name, dir_fd=fd, follow_symlinks=False)))
    except FileNotFoundError:
        pass
    tmp = '.labels-' + secrets.token_hex(16)
    out = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    try:
        with os.fdopen(out, 'wb') as f:
            os.fchmod(f.fileno(), 0o600)
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, name, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        try:
            os.unlink(tmp, dir_fd=fd)
        except FileNotFoundError:
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inputs-dir', required=True, help='private directory of reviewed SHA256.json files')
    parser.add_argument('--draft-sha256', required=True, help='independently reviewed alias-draft content address')
    parser.add_argument('--staging-dir', required=True, help='existing operator-controlled reports directory')
    args = parser.parse_args()
    try:
        with owner_directory(args.inputs_dir) as inputs, owner_directory(args.staging_dir) as stage:
            require(not os.path.samestat(os.fstat(inputs), os.fstat(stage)))
            draft = pinned(inputs, args.draft_sha256, 64 * 1024)
            require(isinstance(draft, dict) and set(draft) == {'version', 'snapshotSha256', 'rows'})
            pin = draft['snapshotSha256']
            snapshot = pinned(inputs, pin, 2 * 1024 * 1024)
            # One policy implementation and the same frozen snapshot validator
            # as the host. No files or credentials in the child's environment;
            # no user-chosen script/module, eval data, URLs, shell or subprocess logs.
            packet = subprocess.run(['node', '--input-type=module', '--eval', READ_POLICY, MODULE.as_uri()],
                                    input=json.dumps([snapshot, draft, pin], allow_nan=False).encode('ascii'),
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10, check=True,
                                    env={'PATH': os.environ['PATH']}).stdout
            require(0 < len(packet) <= 64 * 1024)
            replace(stage, packet)
    except (KeyError, ValueError, TypeError, OverflowError, RecursionError, OSError, subprocess.SubprocessError):
        sys.exit('Public label publication refused')


if __name__ == '__main__':
    main()
