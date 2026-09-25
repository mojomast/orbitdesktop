"""Provision only private configuration for the local catalog service.
Does not install plugins, copy credentials, or change other Hermes profiles.
"""
import json
import os
from pathlib import Path
import shutil
from urllib.parse import urlsplit

root = Path(__file__).resolve().parents[1]
env = dict(line.split('=', 1) for line in (root / '.env.deploy').read_text().splitlines() if '=' in line)
origin = env['ORBIT_PUBLIC_ORIGIN'].strip().strip('"')
u = urlsplit(origin)
hermes = Path(shutil.which('hermes')).resolve()
config = {
    'public_origin': f'{u.scheme}://{u.hostname}:4360',
    'orbit_origin': origin,
    'orbit_auth_url': origin + '/api/auth',
    'hermes_home': os.environ['HERMES_HOME'],
    'hermes_python': str(hermes.parent / 'python'),
    'profile_label': 'default · fresh Hermes instance',
}
path = root / '.runtime/plugin-catalog/config.json'
path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
path.write_text(json.dumps(config, indent=2))
path.chmod(0o600)
print('Private non-secret configuration written:', path)
print('Public origin:', config['public_origin'])
print('Hermes target:', config['hermes_home'])
