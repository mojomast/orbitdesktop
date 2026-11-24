# Builds the character-select portraits (240x300, no baked text) from each hero's
# sheet.jpg: magenta keyed out, weapon on a diagonal behind a head-and-torso bust.
# Output: ../pizza-panic/assets/heroes/portraits/<id>.png
import numpy as np, math, os
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage
from portrait_parts import parts, ROOT, HEROES, alpha_of
W,H=240,300
COL={'turtle_purple':((88,52,140),(30,14,58)),'turtle_blue':((40,86,170),(10,22,60)),'turtle_red':((168,40,40),(56,10,14)),
     'turtle_orange':((214,120,30),(80,34,6)),'nous_girl':((60,110,220),(14,24,70)),'teknium':((24,140,120),(6,40,36)),'turbofit':((210,96,40),(70,18,10))}
def cut(im,al,b):
    x0,y0,x1,y1,_=b; pad=4
    x0,y0=max(0,x0-pad),max(0,y0-pad); x1,y1=min(im.shape[1],x1+pad),min(im.shape[0],y1+pad)
    rgb=im[y0:y1,x0:x1].astype(np.float32); a=al[y0:y1,x0:x1].copy()
    # keep only the largest blob (drops sparkles of neighbours)
    lab,n=ndimage.label(ndimage.binary_dilation(a>0.5,iterations=8))
    if n>1:
        sizes=ndimage.sum(np.ones_like(a),lab,range(1,n+1)); keep=lab==(1+int(np.argmax(sizes))); a=a*keep
    a=ndimage.grey_erosion(a,size=(2,2))
    a=ndimage.gaussian_filter(a,0.6)
    edge=(a<0.98)
    r,g,bb=rgb[...,0],rgb[...,1],rgb[...,2]
    lim=np.maximum(g, np.minimum(r,bb)*0.0+g)  # despill: magenta never exceeds green on the fringe
    rgb[...,0]=np.where(edge,np.minimum(r,np.maximum(g+40,r*0.75)),r)
    rgb[...,2]=np.where(edge,np.minimum(bb,np.maximum(g+40,bb*0.6)),bb)
    out=np.dstack([np.clip(rgb,0,255),np.clip(a*255,0,255)]).astype(np.uint8)
    return Image.fromarray(out,'RGBA')
def axis_angle(img):
    a=np.array(img)[...,3]>128; ys,xs=np.nonzero(a)
    c=np.cov(np.vstack([xs-xs.mean(),ys-ys.mean()])); w,v=np.linalg.eigh(c); vx,vy=v[:,1]
    return math.degrees(math.atan2(vy,vx))
def bg(h):
    c1,c2=COL[h]; y,x=np.mgrid[0:H,0:W]; d=np.sqrt(((x-W/2)/W)**2+((y-H*0.38)/H)**2)/0.62
    d=np.clip(d,0,1)[...,None]; img=np.array(c1)*(1-d)+np.array(c2)*d
    stripes=((x+y)//10)%2==0; img=img*np.where(stripes[...,None],1.0,0.9)
    return Image.fromarray(np.dstack([img.astype(np.uint8),np.full((H,W),255,np.uint8)]),'RGBA')
def build(h):
    im,al,b=parts(h); head,torso,weapon=cut(im,al,b[0]),cut(im,al,b[1]),cut(im,al,b[-1])
    src=ROOT+h+'/'+h+'_head_src.jpg'; override=os.path.exists(src)
    if override:  # replacement head drawn on its own magenta sheet (e.g. turbofit head v2)
        sim=np.array(Image.open(src).convert('RGB')); sal=alpha_of(sim)
        sal=sal*~ndimage.binary_opening(sal<0.5,iterations=1)  # hair pockets stay transparent
        ys,xs=np.nonzero(sal>0.5); head=cut(sim,sal,(xs.min(),ys.min(),xs.max()+1,ys.max()+1,0))
    card=bg(h)
    # weapon: rotate the long axis to a rising diagonal, behind the bust
    ang=axis_angle(weapon); target=-62.0
    wr=weapon.rotate(-(target-ang),expand=True,resample=Image.BICUBIC)
    L=max(wr.size); k=min(250/L,1.3); wr=wr.resize((int(wr.width*k),int(wr.height*k)),Image.LANCZOS)
    card.alpha_composite(wr,(int(W*0.78)-wr.width//2,int(H*0.5)-wr.height//2))
    s=min(178/head.width,(205 if h=='turbofit' and not override else 165)/head.height)
    hd=head.resize((int(head.width*s),int(head.height*s)),Image.LANCZOS)
    ts=torso.resize((int(torso.width*s),int(torso.height*s)),Image.LANCZOS)
    if override:
        # match the rig: torso is 68/64 of the head height, chin (pivot 54/64) sits 6/68 into the torso
        ts=torso.resize((int(torso.width*hd.height*68/64/torso.height),int(hd.height*68/64)),Image.LANCZOS)
        hy=26; ty=hy+int(hd.height*54/64)-int(ts.height*6/68)
    else:
        hy=max(8,min(40,H-int(ts.height*0.55)-hd.height+int(hd.height*0.12)))
        ty=hy+hd.height-int(hd.height*0.14)
    shadow=Image.new('RGBA',card.size,(0,0,0,0)); sa=Image.new('RGBA',card.size,(0,0,0,0))
    sa.alpha_composite(ts,(W//2-ts.width//2,ty)); sa.alpha_composite(hd,(W//2-hd.width//2,hy))
    sh=np.array(sa); sh[...,:3]=0; sh[...,3]=(sh[...,3]*0.45).astype(np.uint8)
    card.alpha_composite(Image.fromarray(sh).filter(ImageFilter.GaussianBlur(5)),(5,6))
    card.alpha_composite(sa)
    # bottom vignette so the cropped torso fades into the card
    v=np.zeros((H,W,4),np.uint8); ramp=np.clip((np.arange(H)-(H-60))/60,0,1)*170; v[...,3]=ramp[:,None].astype(np.uint8)
    card.alpha_composite(Image.fromarray(v,'RGBA'))
    return card.convert('RGB')
if __name__=='__main__':
    import sys
    out=sys.argv[1] if len(sys.argv)>1 else ROOT+'portraits/'
    for h in HEROES: build(h).save(out+h+'.png',optimize=True); print('wrote',out+h+'.png')
