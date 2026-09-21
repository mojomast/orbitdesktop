"""Configure optional Devplan interview; no proxies or services started automatically."""
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]

def origin(value):
    u = urlsplit(value)
    if u.scheme not in ('http', 'https') or not u.hostname or u.username or u.password or u.path not in ('', '/') or u.query or u.fragment:
        raise argparse.ArgumentTypeError('Expected an HTTP(S) origin without credentials or path')
    return value.rstrip('/')

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--orbit-origin', type=origin, required=True)
    p.add_argument('--public-origin', type=origin, required=True)
    p.add_argument('--orbit-auth-url', default='http://127.0.0.1:4318/api/auth')
    p.add_argument('--hermes-home', type=Path, required=True)
    p.add_argument('--hermes-source', type=Path, required=True)
    p.add_argument('--hermes-python', type=Path, required=True)
    a = p.parse_args()
    u = urlsplit(a.orbit_auth_url)
    if u.scheme != 'http' or u.hostname not in ('127.0.0.1', 'localhost', '::1') or u.username or u.password:
        p.error('--orbit-auth-url must be a loopback HTTP endpoint')
    for field in ('hermes_home', 'hermes_source', 'hermes_python'):
        if not getattr(a, field).exists():
            p.error(field + ' must exist')
    target = ROOT / '.runtime/devplan-interview/config.json'
    target.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    if target.exists():
        p.error('Configuration already exists; edit deliberately rather than overwrite')
    config = {k: str(v.resolve()) if isinstance(v, Path) else v for k, v in vars(a).items()}
    with target.open('x') as f:
        target.chmod(0o600)
        json.dump(config, f)
    print('Configuration saved. Review docs/DEVPLAN_STUDIO.md before staging and activation.')

if __name__ == '__main__':
    main()
