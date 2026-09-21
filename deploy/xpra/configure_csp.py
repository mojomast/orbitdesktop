"""Build-time exact Orbit origin allowlist. Never permits wildcard embedding."""
import os
from pathlib import Path
from urllib.parse import urlsplit


def policy(origin):
    parsed = urlsplit(origin)
    if (parsed.scheme not in ('http', 'https') or not parsed.hostname
            or parsed.username or parsed.password or parsed.path not in ('', '/')
            or parsed.query or parsed.fragment or any(c.isspace() for c in origin)
            or any(c in origin for c in ";'\"*\\") or not origin.isascii()):
        raise ValueError('ORBIT_ORIGIN must be one exact HTTP(S) origin')
    _ = parsed.port
    origin = origin.rstrip('/')
    return ("Content-Security-Policy: script-src 'self' 'unsafe-inline'; font-src 'self'; "
            "object-src 'none'; child-src 'self'; worker-src 'self'; "
            f"frame-ancestors 'self' {origin}; form-action 'self'; block-all-mixed-content;\n"
            "Cross-Origin-Resource-Policy: cross-origin\nReferrer-Policy: no-referrer\n")


if __name__ == '__main__':
    Path('/etc/xpra/http-headers/10_content_security_policy.txt').write_text(
        policy(os.environ.get('ORBIT_ORIGIN', 'http://127.0.0.1:4318')))
