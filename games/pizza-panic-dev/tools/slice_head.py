#!/usr/bin/env python3
"""Key a single head drawn on magenta, crop, downscale to a target height, report the chin pivot.
Same magenta key as /workspace/pizza-enemies/slice_parts.py; edges are made fringe-free by
eroding the key mask at source resolution, premultiplied box downscale, then a hard alpha cut.
usage: slice_head.py <src.jpg> <out.png> [--height 64] [--neck-x FRAC]"""
import argparse, numpy as np
from PIL import Image
from scipy import ndimage
ap=argparse.ArgumentParser(); ap.add_argument('src'); ap.add_argument('out'); ap.add_argument('--height',type=int,default=64)
a=ap.parse_args()
px=np.asarray(Image.open(a.src).convert('RGB')).astype(float); r,g,b=px[...,0],px[...,1],px[...,2]
key=np.minimum(r,b*1.6)-g; bgm=(key>70)&(r>150)
fg=~bgm; fg=ndimage.binary_opening(fg,iterations=2); fg=ndimage.binary_fill_holes(ndimage.binary_closing(fg,iterations=2))
lab,n=ndimage.label(fg); fg=lab==(1+int(np.argmax(ndimage.sum(fg,lab,range(1,n+1)))))
fg&=~ndimage.binary_opening(bgm,iterations=1)            # magenta pockets between hair strands are background too
fg=ndimage.binary_erosion(fg,iterations=2)          # drop the JPEG pink halo
# despill anything left near the edge: magenta can't exceed green there
edge=fg&~ndimage.binary_erosion(fg,iterations=6); m=np.clip(np.minimum(r,b)-g,0,None)
out=px.copy(); out[...,0]=np.where(edge,r-m*0.8,r); out[...,2]=np.where(edge,b-m*0.8,b)
ys,xs=np.nonzero(fg); y0,y1,x0,x1=ys.min(),ys.max()+1,xs.min(),xs.max()+1
k=a.height/(y1-y0); W=max(1,round((x1-x0)*k)); H=a.height
al=fg[y0:y1,x0:x1].astype(float); col=np.clip(out[y0:y1,x0:x1],0,255)
pre=np.dstack([col*al[...,None],al*255]).astype(np.float32)
# premultiplied area downscale (no magenta can bleed in: background colour is zero)
chans=[np.asarray(Image.fromarray(pre[...,c]).resize((W,H),Image.BOX)) for c in range(4)]
A=chans[3]/255.0; keep=A>=0.5
rgb=np.dstack([np.where(keep,c/np.maximum(A,1e-6),0) for c in chans[:3]])
img=np.dstack([np.clip(rgb,0,255),keep*255]).astype(np.uint8)
Image.fromarray(img,'RGBA').save(a.out)
# chin: lowest row of skin in the face (excluding hair), reported in output pixels
skin=fg&(r>170)&(g>110)&(r-b>60)&(r-g>25)&(r-g<90); sy,sx=np.nonzero(skin)
cy=np.percentile(sy,99.7); band=sx[(sy>cy-40)&(sy<=cy)]
print(f'{a.out} {W}x{H} scale={k:.4f} chin_y={(cy-y0)*k:.1f} chin_x={(np.median(band)-x0)*k:.1f} face_x={(np.percentile(sx,5)-x0)*k:.1f}..{(np.percentile(sx,95)-x0)*k:.1f}')
