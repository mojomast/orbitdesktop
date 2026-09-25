"""Explicit local deployment, no changes to Orbit's core service or terminals."""
from pathlib import Path
import json
import socket
import subprocess
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
def run(*args):
    return json.loads(subprocess.check_output(['python3', str(ROOT / 'scripts/extensions.py'), *args], text=True))
release = run('stage', str(ROOT / 'extensions/plugin-catalog'))
for port in range(4420, 4430):
    with socket.socket() as s:
        try:
            s.bind(('127.0.0.1', port))
        except OSError:
            continue
        break
else:
    raise SystemExit('No available candidate port')
active = run('activate', release['id'], release['release'], '--port', str(port), '--trust-host-code')
config = json.loads((ROOT / '.runtime/plugin-catalog/config.json').read_text())
public_port = urlsplit(config['public_origin']).port
subprocess.run(['tailscale', 'serve', '--bg', '--https=' + str(public_port), f'http://127.0.0.1:{port}'], check=True)
print(json.dumps({'active': active, 'health': run('health', 'plugin-catalog')}, indent=2))
