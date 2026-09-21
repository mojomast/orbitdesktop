"""Add isolated, fixed-app Xpra services. Never replaces running containers."""
import json
import argparse
from pathlib import Path
import socket
import subprocess
import urllib.request
import time
ROOT=Path(__file__).resolve().parents[1]
APPS=['chromium','writer','calc','impress','files','editor','terminal']
def run(*a, **kw): return subprocess.run(a,check=True,**kw)
if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--tailscale',action='store_true',help='Explicitly publish each app using Tailscale Serve HTTPS')
 args=parser.parse_args()
 for i,app in enumerate(APPS):
  port=4350+i
  name='orbit-xpra-'+app
  exists=subprocess.run(['docker','inspect',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
  if exists:
   print(name,'already exists; not modified');continue
  with socket.socket() as s: s.bind(('127.0.0.1',port))
  volume=name+'-home'
  run('docker','volume','create',volume,stdout=subprocess.DEVNULL)
  run('docker','volume','create','orbit-xpra-documents',stdout=subprocess.DEVNULL)
  run('docker','run','--rm','--user','root','--entrypoint','chown','-v',volume+':/home/browser','-v','orbit-xpra-documents:/home/browser/Documents','orbit-xpra-apps:1','1000:1000','/home/browser','/home/browser/Documents')
  run('docker','run','-d','--name',name,'--init','--restart','unless-stopped','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','512','--memory','2g','--cpus','2','--shm-size','256m','-p',f'127.0.0.1:{port}:14500','-e','ORBIT_XPRA_APP='+app,'-v',volume+':/home/browser','-v','orbit-xpra-documents:/home/browser/Documents','-v',str(ROOT/'.runtime/xpra/password')+':/run/secrets/xpra-password:ro','orbit-xpra-apps:1',stdout=subprocess.DEVNULL)
  for attempt in range(60):
   try:
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/',timeout=2) as r: assert r.status==200
    break
   except Exception:
    if attempt==59: raise
    time.sleep(.5)
  if args.tailscale:
   run('tailscale','serve','--bg',f'--https={port}',f'http://127.0.0.1:{port}')
  print(name,'HTTP ready on loopback'+('; private TLS proxy configured' if args.tailscale else ''))
