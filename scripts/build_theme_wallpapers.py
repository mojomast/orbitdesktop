"""Generate original, local SVG wallpaper art; no remote assets."""
from pathlib import Path
from math import sin
ROOT=Path(__file__).resolve().parents[1]
palettes={
'midnight':('#0b1020','#53658e','#b5f268'),'xp':('#428adb','#ddf5ff','#65a636'),
'classic':('#008080','#00aaaa','#004f59'),'paper':('#e9e1d2','#c9b99d','#93432d'),
'cyberpunk':('#090b16','#40e6ee','#ff58cf'),'aurora':('#102c40','#83eddd','#9174e9'),
'phosphor':('#06130c','#163d24','#78ffa2'),'blueprint':('#12345a','#386287','#a9dcff'),
'pop':('#f6d84b','#ff92c1','#201b35'),'ocean':('#092535','#145b79','#63d8ef'),
'forest':('#12271f','#315440','#97dfaa'),'plum':('#291b32','#633779','#dbacf4'),
'ember':('#302019','#854224','#ffbd80')}
for name,(bg,mid,fg) in palettes.items():
 art=''
 if name=='midnight':
  art=''.join(f'<circle cx="{(i*379)%1920}" cy="{(i*137)%1080}" r="{1+i%3}" fill="{fg}" opacity=".45"/>' for i in range(95))+f'<circle cx="1450" cy="350" r="230" fill="none" stroke="{mid}" stroke-width="2"/><ellipse cx="1450" cy="350" rx="410" ry="95" fill="none" stroke="{mid}" transform="rotate(-25 1450 350)"/>'
 elif name=='xp':
  art='<ellipse cx="420" cy="210" rx="330" ry="70" fill="#fff" opacity=".5"/><path d="M0 730 Q500 380 1100 780 T1920 640 V1080 H0Z" fill="#79b948"/><path d="M0 910 Q900 580 1920 820 V1080 H0Z" fill="#438e36"/>'
 elif name=='classic':
  art=''.join(f'<path d="M{x} 0V1080 M0 {x}H1920" stroke="{mid}" opacity=".18"/>' for x in range(0,1920,32))+f'<path d="M1200 250h400v400h-400z m50 50h300v300h-300z" fill="none" stroke="{fg}" stroke-width="8"/><text x="1200" y="735" fill="{mid}" font-family="monospace" font-size="64">ORBIT 95</text>'
 elif name=='paper':
  art=''.join(f'<path d="M0 {y}H1920" stroke="{mid}"/>' for y in range(0,1080,32))+f'<path d="M170 0V1080" stroke="{fg}" opacity=".4"/><circle cx="1550" cy="310" r="170" fill="none" stroke="{fg}" stroke-width="3"/><text x="1450" y="320" fill="{fg}" font-family="serif" font-size="40">STUDIO</text>'
 elif name=='cyberpunk':
  art=''.join(f'<path d="M960 440L{x} 1080" stroke="{mid}" opacity=".35"/>' for x in range(-1920,3840,160))+''.join(f'<path d="M0 {y}H1920" stroke="{fg}" opacity=".3"/>' for y in [490,540,610,710,850,1050])+f'<circle cx="960" cy="370" r="170" fill="{fg}" opacity=".35"/>'
 elif name=='aurora':
  art=''.join(f'<path d="M-100 {400+i*45} C400 -150 900 1000 2050 {120+i*48}" fill="none" stroke="{fg if i%2 else mid}" stroke-width="65" opacity=".13"/>' for i in range(9))
 elif name=='phosphor':
  art=''.join(f'<path d="M0 {y}H1920" stroke="{mid}"/>' for y in range(0,1080,6))+f'<path d="M100 540h300l40 -130 65 260 60 -190 60 60h900" fill="none" stroke="{fg}" opacity=".35" stroke-width="3"/><text x="100" y="160" fill="{fg}" opacity=".35" font-family="monospace" font-size="28">ORBIT SYSTEMS // READY_</text>'
 elif name=='blueprint':
  art=''.join(f'<path d="M{x} 0V1080 M0 {x}H1920" stroke="{mid}"/>' for x in range(0,1920,40))+f'<g fill="none" stroke="{fg}" opacity=".55"><circle cx="1440" cy="440" r="240"/><circle cx="1440" cy="440" r="180"/><path d="M1100 440h680 M1440 100v680 M1200 760h480 M1200 740v40 M1680 740v40"/></g>'
 elif name=='pop':
  art=f'<path d="M1100 0H1920V1080L550 1080Z" fill="{mid}"/><circle cx="1550" cy="290" r="220" fill="#c6b0ff" stroke="{fg}" stroke-width="12"/>'+''.join(f'<circle cx="{x}" cy="{y}" r="4" fill="{fg}" opacity=".2"/>' for x in range(0,1920,32) for y in range(0,1080,32))
 elif name=='ocean':
  art=''.join(f'<path d="M-100 {y} Q400 {y-190} 1000 {y} T2100 {y}" fill="none" stroke="{mid if i%2 else fg}" stroke-width="45" opacity=".16"/>' for i,y in enumerate(range(250,1400,100)))
 elif name=='forest':
  art=''.join(f'<path d="M{x} 1080V{y} M{x-180} {y+400}L{x} {y}l180 400Z M{x-140} {y+240}L{x} {y-80}l140 320Z" fill="{mid if i%2 else fg}" opacity=".22"/>' for i,(x,y) in enumerate([(80,450),(360,250),(680,500),(1030,320),(1400,200),(1760,420)]))
 elif name=='plum':
  art=''.join(f'<ellipse cx="1450" cy="450" rx="{120+i*75}" ry="{80+i*45}" transform="rotate({i*18} 1450 450)" fill="none" stroke="{fg if i%2 else mid}" stroke-width="18" opacity=".25"/>' for i in range(10))
 else:
  art=''.join(f'<path d="M0 {y} '+ ' '.join(f'L{x} {y+sin(x/190+i)*65}' for x in range(0,2000,40))+f'" fill="none" stroke="{fg if i%3==0 else mid}" opacity=".3" stroke-width="2"/>' for i,y in enumerate(range(160,1200,30)))
 out=ROOT/'public'/'wallpapers'/f'{name}.svg';out.parent.mkdir(exist_ok=True)
 out.write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><rect width="1920" height="1080" fill="{bg}"/>{art}</svg>')
print('Generated',len(palettes),'distinct local wallpapers')
