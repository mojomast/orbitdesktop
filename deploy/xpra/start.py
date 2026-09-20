"""Isolated seamless pilot. No VNC, host mounts, or implicit data bridges."""
import os
from pathlib import Path
runtime = Path('/tmp/orbit-xpra')
runtime.mkdir(mode=0o700, exist_ok=True)
os.environ['XDG_RUNTIME_DIR'] = str(runtime)
# Upstream 6.5.3 Bookworm xkb extension misses an explicit libX11 link.
# Preload only the system X11 library so its XDefaultRootWindow symbol resolves.
os.environ['LD_PRELOAD'] = '/usr/lib/x86_64-linux-gnu/libX11.so.6'
os.execvp('xpra', ['xpra', 'start', ':100', '--daemon=no',
    '--bind-tcp=0.0.0.0:14500,auth=file:filename=/run/secrets/xpra-password',
    '--html=on', '--mdns=no', '--sharing=yes', '--exit-with-client=no',
    '--clipboard=no', '--file-transfer=no', '--printing=no', '--open-files=no',
    '--open-url=no', '--start-new-commands=no', '--webcam=no',
    '--speaker=off', '--microphone=off', '--pulseaudio=no',
    '--notifications=no', '--system-tray=no', '--session-name=Orbit Xpra Pilot',
    '--start=mousepad /home/browser/Welcome.txt'])
