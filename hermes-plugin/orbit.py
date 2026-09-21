"""Explicit local setup/start CLI. Importing/enabling the plugin never runs this."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tarfile


def unpack(destination):
    if destination.exists():
        raise ValueError('Destination already exists; choose a new directory. Existing deployments are never overwritten.')
    with tarfile.open(Path(__file__).with_name('orbit-source.tar.gz'), 'r:gz') as archive:
        members = archive.getmembers()
        for member in members:
            path = Path(member.name)
            if not member.isfile() or path.is_absolute() or '..' in path.parts:
                raise ValueError('Unsafe bundled archive member')
        destination.mkdir(parents=True, mode=0o700)
        archive.extractall(destination, members=members, filter='data')


def main():
    parser = argparse.ArgumentParser(description='Set up or run the Orbit source included in this plugin. No self-updates.')
    parser.add_argument('action', choices=['setup', 'start'])
    parser.add_argument('--directory', required=True, type=Path, help='Dedicated deployment directory outside the installed plugin')
    parser.add_argument('--approve-dependencies', action='store_true', help='Approve npm network downloads and native dependency install scripts')
    parser.add_argument('--port', type=int, default=4318)
    args = parser.parse_args()
    destination = args.directory.expanduser().resolve()
    plugin_dir = Path(__file__).resolve().parent
    if destination == plugin_dir or plugin_dir in destination.parents:
        parser.error('Use a deployment directory outside the immutable plugin installation')
    if not 1024 <= args.port <= 65535:
        parser.error('Choose a port from 1024 to 65535')
    if not shutil.which('node') or not shutil.which('npm'):
        parser.error('Install Node.js >=22.12 and npm first; see README')
    version = subprocess.check_output(['node', '--version'], text=True).strip().lstrip('v').split('.')
    if tuple(map(int, version[:2])) < (22, 12):
        parser.error('Node.js >=22.12 is required')
    os.umask(0o077)
    if args.action == 'setup':
        if not args.approve_dependencies:
            parser.error('Setup requires --approve-dependencies: npm ci downloads locked dependencies and executes native build scripts')
        unpack(destination)
        subprocess.run(['npm', 'ci', '--cache', str(destination / '.npm-cache')], cwd=destination, check=True)
        subprocess.run(['npm', 'run', 'build'], cwd=destination, check=True)
        print(f'Orbit is built in {destination}. Run this command again with start instead of setup.')
    else:
        if not (destination / 'dist/index.html').is_file():
            parser.error('Run setup successfully first')
        print(f'Opening Orbit server on http://127.0.0.1:{args.port}. Ctrl+C stops this server, not other Orbit deployments.', flush=True)
        os.chdir(destination)
        os.environ['PORT'] = str(args.port)
        os.execvp('node', ['node', '--experimental-strip-types', 'server/index.mjs'])


if __name__ == '__main__':
    main()
