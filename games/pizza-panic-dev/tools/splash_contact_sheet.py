from PIL import Image, ImageDraw
import sys
G='/home/box/orbitdesktop/games/pizza-panic/assets/bosses/splash/'
IDS=['enforcer','bruiser','rider','skytalon','shredclaw','conductor','hookclaw','highscore','mech']
cw,ch=540,430; s=Image.new('RGB',(cw*3,ch*3)); d=ImageDraw.Draw(s)
bgs=[(40,44,56),(120,124,130),(230,230,230)]
for k,i in enumerate(IDS):
    im=Image.open(G+i+'.png').convert('RGBA')
    cell=Image.new('RGBA',(cw,ch),bgs[k%3]+(255,))
    for y in range(0,ch,16):
        for x in range(0,cw,16):
            if (x//16+y//16)%2: ImageDraw.Draw(cell).rectangle([x,y,x+15,y+15],fill=tuple(min(255,c+18) for c in bgs[k%3]))
    cell.alpha_composite(im,((cw-im.width)//2,ch-im.height-4))
    s.paste(cell.convert('RGB'),((k%3)*cw,(k//3)*ch)); d.text(((k%3)*cw+6,(k//3)*ch+4),f'{i} {im.width}x{im.height}',fill=(255,230,90))
s.save(sys.argv[1] if len(sys.argv)>1 else 'splash-contact-sheet.png')
