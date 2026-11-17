"""Package tracked Orbit source only; no runtime, user apps, credentials or dependencies."""
from pathlib import Path
import io
import gzip
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
PREFIXES = ('src/', 'server/', 'scripts/', 'deploy/', 'docs/', 'public/', 'contracts/')
FILES = {'package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.js', 'LICENSE', 'README.md', 'AGENTS.md', 'hermes-plugin/__init__.py', 'hermes-plugin/orbit.py', 'hermes-plugin/workbench.py', 'hermes-plugin/resources.py', 'hermes-plugin/normal_resources.py', 'hermes-plugin/workbench-tool-schema.json', 'hermes-plugin/plugin.yaml'}

def included(name):
    """Single inclusion policy used by publication and reverse-completeness checks."""
    # The optional mobile proxy and historical operator evidence carry private
    # deployment bindings; preserve those in Git, not portable installs.
    return (name in FILES or name.startswith(PREFIXES)) and not name.startswith('docs/images/') and name not in (
        'scripts/bundle_hermes.py', 'server/mobile-proxy.mjs',
        'docs/REAL_PROJECT_EVALUATION.md', 'docs/REAL_PROJECT_EVALUATION_PREFLIGHT.md',
    )

def build(target=None):
    paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w', format=tarfile.PAX_FORMAT) as archive:
        for name in sorted(paths):
            if not included(name):
                continue
            path = ROOT / name
            if path.is_symlink() or not path.is_file():
                raise ValueError('Only ordinary tracked files may be bundled')
            data = path.read_bytes()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(data))
    if target is None:
        target = ROOT / 'hermes-plugin/orbit-source.tar.gz'
    compressed = io.BytesIO()
    # GzipFile keeps the container framing interpreter-independent: it always
    # writes the OS=0xff header byte, unlike gzip.compress(mtime=0) whose
    # Python 3.11+ zlib fast path writes OS=0x03.
    with gzip.GzipFile(fileobj=compressed, mode='wb', mtime=0) as stream:
        stream.write(output.getvalue())
    target.write_bytes(compressed.getvalue())
    print(f'Bundled Orbit source: {target.name} ({target.stat().st_size} bytes)')

if __name__ == '__main__':
    build()
