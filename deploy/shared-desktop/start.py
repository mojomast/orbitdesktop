"""Dedicated X desktop. Viewer failures never terminate the X session."""
import os
import signal
import subprocess
import time
from pathlib import Path

children = {}
stopping = False

def stop(*_):
    global stopping
    stopping = True

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
os.environ['XDG_RUNTIME_DIR'] = '/tmp/runtime-browser'
Path(os.environ['XDG_RUNTIME_DIR']).mkdir(mode=0o700, exist_ok=True)
for stale in ['/tmp/.X99-lock', '/tmp/.X11-unix/X99']:
    Path(stale).unlink(missing_ok=True)
x = subprocess.Popen(['Xvfb', ':99', '-screen', '0', '1440x900x24', '-nolisten', 'tcp'])
children['X'] = x
for _ in range(100):
    if subprocess.run(['xdpyinfo'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        break
    if x.poll() is not None:
        raise RuntimeError('X server failed')
    time.sleep(.1)
else:
    raise RuntimeError('X server readiness timed out')
commands = {
    'desktop': ['dbus-run-session', '--', 'startxfce4'],
    'vnc': ['x11vnc', '-display', ':99', '-rfbauth', '/run/secrets/vnc-password', '-forever', '-shared', '-rfbport', '5900', '-localhost'],
    'viewer': ['websockify', '--web=/usr/share/novnc/', '6080', '127.0.0.1:5900'],
}
next_start = {}
try:
    while not stopping and x.poll() is None:
        for name, command in commands.items():
            child = children.get(name)
            if (child is None or child.poll() is not None) and time.monotonic() >= next_start.get(name, 0):
                children[name] = subprocess.Popen(command)
                next_start[name] = time.monotonic() + 5
                print('Started ' + name, flush=True)
        time.sleep(.5)
finally:
    for child in children.values():
        if child.poll() is None:
            child.terminate()
    for child in children.values():
        try:
            child.wait(timeout=4)
        except subprocess.TimeoutExpired:
            child.kill()
