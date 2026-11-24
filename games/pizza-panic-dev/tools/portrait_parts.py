# Find the cutout parts on each hero sheet.jpg (magenta background) and report bboxes.
import numpy as np, sys
from PIL import Image
from scipy import ndimage
ROOT='/home/box/orbitdesktop/games/pizza-panic/assets/heroes/'
HEROES=['turtle_purple','turtle_blue','turtle_red','turtle_orange','nous_girl','teknium','turbofit']
def alpha_of(a):
    a=a.astype(np.float32); r,g,b=a[...,0],a[...,1],a[...,2]
    # magenta-ness: high r and b, low g
    m=np.minimum(r,b)-g
    bg=np.clip((m-60)/80,0,1)  # 1 = background
    return 1-bg
def parts(h):
    im=np.array(Image.open(ROOT+h+'/sheet.jpg').convert('RGB'))
    al=alpha_of(im); mask=al>0.5
    mask=ndimage.binary_opening(mask,iterations=1)
    lab,n=ndimage.label(ndimage.binary_dilation(mask,iterations=6))
    objs=ndimage.find_objects(lab); out=[]
    for i,sl in enumerate(objs):
        area=(lab[sl]==i+1).sum()
        if area>1500: out.append((sl[1].start,sl[0].start,sl[1].stop,sl[0].stop,int(area)))
    out.sort(); return im,al,out
if __name__=='__main__':
    for h in HEROES:
        _,_,o=parts(h); print(h,len(o),o)
