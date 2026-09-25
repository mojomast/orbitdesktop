#!/usr/bin/env python3
"""Owner-only vault CLI. Set through hidden prompt/stdin; run with selected secrets."""
import argparse, getpass, json, os, sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'extensions/orbit-secrets'))
from vault import Vault
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('action',choices=['list','set','delete','run'])
p.add_argument('names',nargs='*')
p.add_argument('--replace',action='store_true')
p.add_argument('--stdin',action='store_true')
argv=sys.argv[1:];command=[]
if '--' in argv:
    i=argv.index('--');command=argv[i+1:];argv=argv[:i]
a=p.parse_args(argv);v=Vault()
try:
    if a.action=='list': print(json.dumps(v.list(),indent=2))
    elif a.action=='set':
        if len(a.names)!=1: p.error('set needs one name')
        value=sys.stdin.read().rstrip('\n') if a.stdin else getpass.getpass('Secret value: ')
        v.put(a.names[0],value,a.replace);print('Secret saved (value not displayed).')
    elif a.action=='delete':
        if len(a.names)!=1: p.error('delete needs one name')
        v.delete(a.names[0]);print('Secret deleted.')
    else:
        if not a.names or not command: p.error('run NAME [NAME ...] -- COMMAND [ARG ...]')
        env=os.environ.copy()
        for name in a.names: env[name]=v.get(name)
        os.execvpe(command[0],command,env)
except Exception:
    print('Vault operation failed; no secret values logged.',file=sys.stderr);sys.exit(1)
