import os
from pathlib import Path
from launch import APPS
app = os.environ['ORBIT_XPRA_APP']
if app not in APPS: raise SystemExit('Unknown app')
Path('/tmp/orbit-xpra').mkdir(mode=0o700, exist_ok=True)
os.environ['XDG_RUNTIME_DIR'] = '/tmp/orbit-xpra'
os.environ['LD_PRELOAD'] = '/usr/lib/x86_64-linux-gnu/libX11.so.6'
os.execvp('xpra', ['xpra', 'start', ':100', '--daemon=no',
 '--bind-tcp=0.0.0.0:14500,auth=file:filename=/run/secrets/xpra-password',
 '--html=on', '--mdns=no', '--sharing=yes', '--exit-with-client=no',
 '--clipboard=no', '--file-transfer=no', '--printing=no', '--open-files=no',
 '--open-url=no', '--start-new-commands=no', '--webcam=no', '--shell=no',
 '--speaker=off', '--microphone=off', '--pulseaudio=no',
 '--notifications=no', '--system-tray=no', '--session-name=Orbit '+app,
 '--start-on-connect=python3 /opt/orbit-apps/launch.py'])
