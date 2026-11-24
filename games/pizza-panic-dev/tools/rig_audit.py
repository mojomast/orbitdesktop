import re,os,sys,json
import numpy as np
from PIL import Image
A=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','..','pizza-panic','assets')+'/'
def parse(man):
  types={};cur=None
  for ln in open(A+man):
    m=re.match(r'^## (\w+)',ln)
    if m: cur=m.group(1);types[cur]={};continue
    m=re.match(r'^\|\s*(\w+)\s*\|\s*([\w.]+)\s*\|\s*(\d+)x(\d+)\s*\|\s*(\d+),(\d+)\s*\|\s*([\w-]+)\s*\|\s*(?:(\d+),(\d+)|-)\s*\|',ln)
    if m and cur: types[cur][m.group(1)]=dict(file=m.group(2),w=int(m.group(3)),h=int(m.group(4)),px=int(m.group(5)),py=int(m.group(6)),parent=None if m.group(7)=='-' else m.group(7),ax=int(m.group(8) or 0),ay=int(m.group(9) or 0))
  return types
def alpha(d,f):
  return np.asarray(Image.open(d+f).convert('RGBA'))[...,3]
def near(a,x,y,r=3,th=96):
  h,w=a.shape;y0,y1,x0,x1=max(0,y-r),min(h,y+r+1),max(0,x-r),min(w,x+r+1)
  return a[y0:y1,x0:x1].size>0 and a[y0:y1,x0:x1].max()>=th
def audit(man,root):
  out={}
  for k,t in parse(man).items():
    d=f'{A}{root}/{k}/';issues=[]
    if not os.path.isdir(d): continue
    for n,p in t.items():
      if not os.path.exists(d+p['file']): issues.append(f'{n}: missing {p["file"]}');continue
      a=alpha(d,p['file'])
      if a.shape!=(p['h'],p['w']): issues.append(f'{n}: size {a.shape[::-1]} != {p["w"]}x{p["h"]}')
      if not near(a,p['px'],p['py']): issues.append(f'{n}: pivot {p["px"]},{p["py"]} off the art')
      if p['parent'] and p['parent'] in t:
        pa=alpha(d,t[p['parent']]['file'])
        if not near(pa,p['ax'],p['ay']): issues.append(f'{n}: attach {p["ax"]},{p["ay"]} off {p["parent"]}')
    out[k]=issues
  return out
if __name__=='__main__':
  r={**audit('enemies/MANIFEST.md','enemies'),**audit('heroes/MANIFEST.md','heroes')}
  for k,v in r.items(): print(k, len(v), '; '.join(v))
