"""Package tracked Orbit source only; no runtime, user apps, credentials or dependencies."""
from pathlib import Path
import io
import gzip
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
PREFIXES = ('src/', 'server/', 'scripts/', 'deploy/', 'docs/', 'public/', 'contracts/')
FILES = {'package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.js', 'LICENSE', 'README.md', 'AGENTS.md'}

def build():
    paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w', format=tarfile.PAX_FORMAT) as archive:
        for name in sorted(paths):
            if name not in FILES and not name.startswith(PREFIXES):
                continue
            # The optional, owner-specific mobile proxy has hard-coded private
            # deployment bindings and is not imported by the portable server.
            if name.startswith('docs/images/') or name in ('scripts/bundle_hermes.py', 'server/mobile-proxy.mjs'):
                continue
            path = ROOT / name
            if path.is_symlink() or not path.is_file():
                raise ValueError('Only ordinary tracked files may be bundled')
            data = path.read_bytes()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(data))
    target = ROOT / 'hermes-plugin/orbit-source.tar.gz'
    target.write_bytes(gzip.compress(output.getvalue(), mtime=0))
    print(f'Bundled Orbit source: {target.name} ({target.stat().st_size} bytes)')

if __name__ == '__main__':
    build()
