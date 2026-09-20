#!/usr/bin/env python3
"""Publish an immutable, content-addressed static plugin bundle. No workspace mutation."""
import argparse, hashlib, json, os, re, shutil, tempfile
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__);p.add_argument('folder',type=Path);p.add_argument('--id',required=True);p.add_argument('--version',required=True);p.add_argument('--title',required=True);p.add_argument('--runtime',type=Path,default=Path(__file__).resolve().parents[1]/'.runtime');a=p.parse_args()
if not re.fullmatch(r'[a-z][a-z0-9-]{0,25}',a.id) or not re.fullmatch(r'\d+\.\d+\.\d+',a.version) or not 1<=len(a.title)<=60:p.error('Invalid id/version/title')
source=a.folder.resolve();files=[];size=0;digest=hashlib.sha256()
for f in sorted(source.rglob('*')):
 if f.is_symlink():p.error('Symlinks are not allowed')
 if not f.is_file():continue
 relative=f.relative_to(source)
 if any(x.startswith('.') for x in relative.parts):p.error('Hidden files are not allowed')
 content=f.read_bytes();size+=len(content)
 if size>20_000_000 or len(files)>=500:p.error('Bundle limit: 20 MB / 500 files')
 name=relative.as_posix().encode();digest.update(len(name).to_bytes(8,'big')+name+len(content).to_bytes(8,'big')+content);files.append((relative,content))
if not any(str(name)=='index.html' for name,_ in files):p.error('index.html is required')
slug=a.id+'-'+digest.hexdigest()[:24];apps=a.runtime/'apps';apps.mkdir(parents=True,exist_ok=True);dest=apps/slug
if not dest.exists():
 staging=Path(tempfile.mkdtemp(prefix='.plugin-stage-',dir=apps))
 try:
  for relative,content in files:
   target=staging/relative;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
  os.rename(staging,dest)
 finally:
  if staging.exists():shutil.rmtree(staging)
else:
 if any(not (dest/name).is_file() or (dest/name).read_bytes()!=content for name,content in files):p.error('Existing bundle was modified; refusing reuse')
print(json.dumps({'apiVersion':1,'id':a.id,'version':a.version,'title':a.title,'entry':'/apps/'+slug+'/index.html'}))
