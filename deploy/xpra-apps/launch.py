"""Fixed app launcher, invoked only by Xpra after authenticated connection.
A lock spans the child lifetime, so reconnect never spawns duplicate apps.
"""
import fcntl
import os
from pathlib import Path
import subprocess
APPS = {
 'chromium': ['chromium', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--password-store=basic', '--disable-gpu', 'about:blank'],
 'writer': ['/opt/openoffice4/program/soffice', '-writer', '-nofirststartwizard'],
 'calc': ['/opt/openoffice4/program/soffice', '-calc', '-nofirststartwizard'],
 'impress': ['/opt/openoffice4/program/soffice', '-impress', '-nofirststartwizard'],
 'files': ['thunar', '/home/browser/Documents'],
 'editor': ['mousepad', '--disable-server'],
 'terminal': ['xterm', '-title', 'Linux terminal · isolated Xpra container'],
}
if __name__ == '__main__':
 app = os.environ['ORBIT_XPRA_APP']
 if app not in APPS: raise SystemExit('Unknown app')
 Path('/home/browser/Documents').mkdir(exist_ok=True)
 with open('/tmp/orbit-app.lock', 'w') as lock:
  try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
  except BlockingIOError: raise SystemExit(0)
  raise SystemExit(subprocess.call(APPS[app]))
