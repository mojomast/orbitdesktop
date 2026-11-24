"""Bundle tracked Orbit source plus the exact required portable product files."""
from pathlib import Path
import argparse
from contextlib import ExitStack
import hashlib
import io
import gzip
import json
import os
import re
import stat
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
POLICY_FILE = 'scripts/portable-product.json'
POLICY = json.loads((ROOT / POLICY_FILE).read_bytes())
REQUIRED = frozenset(POLICY['required'])
EXCLUDED = frozenset(POLICY['excluded'])
PREFIXES = ('src/', 'server/', 'scripts/', 'deploy/', 'docs/', 'public/', 'contracts/')
FILES = {'package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.js', 'LICENSE', 'README.md', 'AGENTS.md', 'hermes-plugin/__init__.py', 'hermes-plugin/orbit.py', 'hermes-plugin/transport.py', 'hermes-plugin/resources.py', 'hermes-plugin/normal_resources.py', 'hermes-plugin/plugin.yaml'}
EXTENSIONS = {'.ts', '.mts', '.js', '.mjs', '.css', '.html', '.svg', '.ttf', '.md', '.json', '.py', '.txt', '.sh', '.yaml', '.yml'}
PRIVATE_DIRS = {'runtime', 'node_modules', '__pycache__', 'evidence', 'artifacts', 'private', 'screenshots', 'secrets', 'credentials', 'transcripts'}
PRIVATE_FILENAME = re.compile(r'^(?:credentials?|secrets?|tokens?|passwords?|wallet|transcript|auth|id_rsa|id_ed25519)(?:$|[.-])', re.I)
# An extra publication check, not a substitute for reviewing included source.
CREDENTIAL = re.compile(rb'-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{35,}|\bgithub_pat_[A-Za-z0-9_]{50,}|\bAKIA[A-Z0-9]{16}\b')

def included(name):
    """Single inclusion policy used by publication and reverse-completeness checks."""
    if name == '.dockerignore':
        return True  # Compose uses a build context; carry its reviewed exclusions.
    parts = name.split('/')
    if (any(not p or p.startswith('.') or p.casefold() in PRIVATE_DIRS for p in parts)
            or '\\' in name or not re.fullmatch(r'[A-Za-z0-9_./-]+', name)
            or PRIVATE_FILENAME.match(parts[-1]) or name.startswith('docs/images/') or name in EXCLUDED):
        return False
    if name in REQUIRED or name in FILES:
        return True
    return (name.startswith(PREFIXES) and name != 'scripts/bundle_hermes.py'
            and (Path(name).suffix.lower() in EXTENSIONS or parts[-1] == 'Dockerfile'))


def members(root=ROOT):
    # Never enumerate untracked or ignored files. Expanding an enumerated
    # directory here would also include files created by a running workspace.
    tracked = subprocess.check_output(['git', 'ls-files', '--cached', '-z'], cwd=root).decode().split('\0')
    if len(REQUIRED) != len(POLICY['required']) or not all(map(included, REQUIRED)):
        raise ValueError('Invalid portable product manifest')
    return sorted(REQUIRED.union(name for name in tracked if included(name)))


def member_bytes(root, name):
    # Anchor each relative open in the previous directory fd. Checking just
    # the leaf for symlinks would follow an untracked replacement directory.
    with ExitStack() as stack:
        parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        stack.callback(os.close, parent)
        parts = name.split('/')
        for part in parts[:-1]:
            parent = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            stack.callback(os.close, parent)
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        source = stack.enter_context(os.fdopen(fd, 'rb'))
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size > 32*1024*1024:
            raise ValueError(f'Not a bounded ordinary source file: {name}')
        data = source.read(st.st_size + 1)
        if len(data) != st.st_size or os.fstat(fd).st_mtime_ns != st.st_mtime_ns:
            raise ValueError(f'Source changed during packaging: {name}')
        if CREDENTIAL.search(data):
            raise ValueError(f'Possible credential in portable source: {name}')
        return data


def verify_runtime(manifest, digests):
    entries = manifest['files']
    pins = {entry['path']: (entry['bytes'], entry['sha256']) for entry in entries}
    if len(pins) != len(entries) or pins != digests:
        raise ValueError('Bundled Rails modules do not match the offline vendor manifest')

def build(target=None, *, root=ROOT):
    paths = members(root)
    digests = {}
    manifest = None
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w', format=tarfile.PAX_FORMAT) as archive:
        for name in paths:
            data = member_bytes(root, name)
            if name.startswith('contrib/rizzstack_rails/') and name.endswith('.py'):
                digests[name] = (len(data), hashlib.sha256(data).hexdigest())
            if name == 'contrib/rizzstack_rails/vendor-manifest.json':
                manifest = json.loads(data)
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(data))
    verify_runtime(manifest, digests)
    if target is None:
        target = root / 'hermes-plugin/orbit-source.tar.gz'
    compressed = io.BytesIO()
    # GzipFile keeps the container framing interpreter-independent: it always
    # writes the OS=0xff header byte, unlike gzip.compress(mtime=0) whose
    # Python 3.11+ zlib fast path writes OS=0x03.
    with gzip.GzipFile(fileobj=compressed, mode='wb', mtime=0) as stream:
        stream.write(output.getvalue())
    # A failed build must not leave a partially-written tracked artifact.
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as tmp:
        try:
            tmp.write(compressed.getvalue())
            tmp.flush()
            os.fchmod(tmp.fileno(), 0o644)
            os.replace(tmp.name, target)
        finally:
            Path(tmp.name).unlink(missing_ok=True)
    print(f'Bundled Orbit source: {target.name} ({target.stat().st_size} bytes)')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='Write to a scratch path instead of the tracked tarball.')
    build(parser.parse_args().output)
