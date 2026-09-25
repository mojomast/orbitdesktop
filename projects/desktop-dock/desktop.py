"""Fixed RPC helper executed only in the dedicated desktop container as browser."""
import base64, json, os, re, stat, subprocess, sys
from pathlib import Path
ROOT = '/home/browser/Orbit Inbox'
LIMIT = 8 * 1024 * 1024

def name(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9 ._()-]{0,119}', value) or '..' in value:
        raise ValueError('Use a simple filename, not a path')
    return value

def execute(q):
    os.makedirs(ROOT, mode=0o700, exist_ok=True)
    d = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        action = q['action']
        if action == 'files':
            out = []
            for n in sorted(os.listdir(d))[:1000]:
                s = os.stat(n, dir_fd=d, follow_symlinks=False)
                if stat.S_ISREG(s.st_mode) and s.st_nlink == 1:
                    out.append({'name':n,'size':s.st_size,'modified':s.st_mtime})
            return out
        if action in ('upload','read'):
            n = name(q.get('name'))
            if action == 'upload':
                data = base64.b64decode(q['data'], validate=True)
                if len(data) > LIMIT: raise ValueError('Maximum file size is 8 MiB')
                if len(os.listdir(d)) >= 1000: raise ValueError('Inbox has too many files')
                used = sum(os.stat(f,dir_fd=d,follow_symlinks=False).st_size for f in os.listdir(d))
                if used + len(data) > 128*1024*1024: raise ValueError('Inbox transfer quota is 128 MiB')
                fd = os.open(n,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=d)
                with os.fdopen(fd,'wb') as f: f.write(data)
                return {'name':n,'bytes':len(data),'status':'saved'}
            fd = os.open(n,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=d)
            with os.fdopen(fd,'rb') as f:
                s = os.fstat(f.fileno())
                if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_size > LIMIT:
                    raise ValueError('Not a regular single-link file within size limit')
                data = f.read(LIMIT+1)
                if len(data)>LIMIT: raise ValueError('File too large')
            return {'name':n,'data':base64.b64encode(data).decode()}
        if action == 'windows':
            result = subprocess.run(['wmctrl','-l'],capture_output=True,text=True,check=True,timeout=4)
            rows=[]
            for line in result.stdout.splitlines():
                p=line.split(None,3)
                if len(p)==4: rows.append({'id':p[0],'title':p[3][:240]})
            return rows
        if action == 'focus':
            wid=q.get('id')
            if wid not in [w['id'] for w in execute({'action':'windows'})]: raise ValueError('Window no longer exists')
            subprocess.run(['wmctrl','-ia',wid],check=True,timeout=4)
            active=subprocess.check_output(['xdotool','getactivewindow'],text=True,timeout=4).strip()
            return {'status':'focused' if int(active)==int(wid,16) else 'requested','id':wid}
        if action == 'launch':
            apps={'files':['thunar',ROOT], 'editor':['mousepad'], 'writer':['/home/browser/.local/opt/opt/openoffice4/program/soffice','-nofirststartwizard','-writer'], 'calc':['/home/browser/.local/opt/opt/openoffice4/program/soffice','-nofirststartwizard','-calc'], 'impress':['/home/browser/.local/opt/opt/openoffice4/program/soffice','-nofirststartwizard','-impress']}
            if q.get('app') not in apps: raise ValueError('Application not allowed')
            subprocess.Popen(apps[q['app']],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
            return {'status':'launch requested','app':q['app']}
        raise ValueError('Operation not allowed')
    finally: os.close(d)

if __name__=='__main__':
    try: print(json.dumps({'ok':True,'result':execute(json.load(sys.stdin))}))
    except Exception as e: print(json.dumps({'ok':False,'error':str(e)[:200]})); sys.exit(1)
