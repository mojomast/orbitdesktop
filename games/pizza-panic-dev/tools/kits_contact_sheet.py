from PIL import Image, ImageDraw
G='/home/box/orbitdesktop/games/pizza-panic/assets/enemies/'
N=['head','torso','uarm','farm','thigh','shin','weapon']; Z=3; cw,ch=300,240
s=Image.new('RGB',(cw*7,ch*2+10),(0,0,0)); d=ImageDraw.Draw(s)
for r,k in enumerate(['sniper','heavy']):
    for i,n in enumerate(N):
        im=Image.open(f'{G}{k}/{k}_{n}.png').convert('RGBA'); im=im.resize((im.width*Z,im.height*Z),Image.NEAREST)
        cell=Image.new('RGBA',(cw,ch),(60,64,76,255))
        for y in range(0,ch,10):
            for x in range(0,cw,10):
                if (x//10+y//10)%2: ImageDraw.Draw(cell).rectangle([x,y,x+9,y+9],fill=(90,94,106,255))
        if im.width>cw-10: im.thumbnail((cw-10,ch-25))
        cell.alpha_composite(im,((cw-im.width)//2,(ch-im.height)//2+8)); s.paste(cell.convert('RGB'),(i*cw,r*(ch+10)))
        d.text((i*cw+5,r*(ch+10)+3),f'{k}_{n}',fill=(255,230,100))
s.save('kits-contact-sheet.png')
