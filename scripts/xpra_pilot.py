"""Deploy/status/stop isolated Xpra pilot; never changes existing desktop containers."""
import argparse
import json
from pathlib import Path
import secrets
import subprocess
ROOT = Path(__file__).resolve().parents[1]
NAME = 'orbit-xpra-pilot'
def run(*args, **kw):
    return subprocess.run(args, check=True, **kw)
def start():
    private = ROOT / '.runtime/xpra'
    private.mkdir(parents=True, exist_ok=True, mode=0o700)
    password = private / 'password'
    if not password.exists():
        password.write_text(secrets.token_urlsafe(32))
    # Parent is 0700 on host; read-only mount must be readable by container UID 1000.
    private.chmod(0o700)
    password.chmod(0o444)
    run('docker', 'volume', 'create', 'orbit-xpra-home', stdout=subprocess.DEVNULL)
    run('docker', 'run', '--rm', '--user', 'root', '--entrypoint', 'chown', '-v',
        'orbit-xpra-home:/home/browser', 'orbit-xpra:pilot', '1000:1000', '/home/browser')
    run('docker', 'run', '-d', '--name', NAME, '--init', '--restart', 'unless-stopped',
        '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--pids-limit', '512', '--memory', '2g', '--cpus', '2', '--shm-size', '256m',
        '-p', '127.0.0.1:4348:14500', '-v', 'orbit-xpra-home:/home/browser',
        '-v', f'{password}:/run/secrets/xpra-password:ro', 'orbit-xpra:pilot')
    welcome = private / 'Welcome.txt'
    welcome.write_text('Orbit Xpra Pilot\n\nThis Linux editor is delivered using Xpra, not VNC.\nClose the viewer and reconnect: the application stays running.\n\nThis is an isolated pilot, not the existing shared desktop.\nClipboard, file transfer, audio and remote command launch are disabled.\n')
    run('docker','run','--rm','--user','root','--entrypoint','chown',
        '-v','orbit-xpra-home:/home/browser','orbit-xpra:pilot','-R','1000:1000','/home/browser')
    run('docker','exec','-i',NAME,'python3','-c',
        'import sys; from pathlib import Path; Path("/home/browser/Welcome.txt").write_text(sys.stdin.read())',
        input=welcome.read_text(),text=True)
    print('Pilot started on loopback port 4348. Password stored privately, not printed.')
def status():
    r = run('docker','inspect',NAME, capture_output=True, text=True)
    data=json.loads(r.stdout)[0]
    print(json.dumps({'state':data['State']['Status'],'restart_count':data['RestartCount'],
        'ports':data['NetworkSettings']['Ports']},indent=2))
if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['start','status','stop'])
    action=p.parse_args().action
    if action=='start': start()
    elif action=='status': status()
    else: run('docker','stop',NAME)
