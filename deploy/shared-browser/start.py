import subprocess,time,os,signal
from pathlib import Path
processes=[]
def launch(args):
 p=subprocess.Popen(args);processes.append(p);return p
def stop(*_):
 for p in processes:
  if p.poll() is None:p.terminate()
 raise SystemExit()
signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
launch(['Xvfb',':99','-screen','0','1440x900x24','-nolisten','tcp'])
for _ in range(100):
 if Path('/tmp/.X11-unix/X99').exists():break
 time.sleep(.05)
else:raise RuntimeError('Display failed')
launch(['openbox'])
launch(['chromium','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--user-data-dir=/home/browser/profile','--remote-debugging-port=9222','--remote-debugging-address=127.0.0.1','--window-size=1440,900','--start-maximized','about:blank'])
launch(['x11vnc','-display',':99','-rfbauth','/run/secrets/vnc-password','-forever','-shared','-rfbport','5900','-localhost'])
launch(['websockify','--web=/usr/share/novnc/','6080','127.0.0.1:5900'])
launch(['socat','TCP-LISTEN:9223,bind=0.0.0.0,reuseaddr,fork','TCP:127.0.0.1:9222'])
while all(p.poll() is None for p in processes):time.sleep(1)
stop()
