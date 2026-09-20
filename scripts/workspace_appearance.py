#!/usr/bin/env python3
"""Apply trusted owner-requested workspace CSS through the existing live stylesheet watcher."""
import argparse
import fcntl
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--css-file', required=True, help='UTF-8 CSS file; shared workspace appearance, not app iframe CSS')
    args = parser.parse_args()
    css = Path(args.css_file).read_text()
    if len(css.encode()) > 100000:
        parser.error('Appearance CSS exceeds 100KB')
    runtime = ROOT / '.runtime'
    runtime.mkdir(exist_ok=True, mode=0o700)
    target = ROOT / 'src/workspace-theme.css'
    with (runtime / 'appearance.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        before = target.read_text() if target.exists() else ''
        try:
            target.write_text(css)
            build = subprocess.run(['npm', 'run', 'build'], cwd=ROOT, capture_output=True, text=True)
            if build.returncode:
                raise RuntimeError('Appearance build failed: ' + (build.stdout + build.stderr)[-4000:])
        except Exception:
            target.write_text(before)
            subprocess.run(['npm', 'run', 'build'], cwd=ROOT, capture_output=True)
            raise
    print(json.dumps({'saved': True, 'built': True, 'scope': 'all workspace pages on this deployment',
        'delivery': 'automatic stylesheet swap in open pages, normally within 1.5 seconds',
        'requires_page_reload': False, 'browser_applied': None,
        'note': 'Delivery requires a page with the live stylesheet watcher. This command does not claim browser acknowledgement. No shell or service restart performed.'}))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error)}))
        raise SystemExit(1)
