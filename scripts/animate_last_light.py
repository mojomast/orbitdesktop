"""Create a non-destructive animated edition of the original SVG wallpaper."""
from pathlib import Path
import xml.etree.ElementTree as E
root=Path(__file__).resolve().parents[1]
ns='http://www.w3.org/2000/svg'
E.register_namespace('',ns)
def tag(n): return '{'+ns+'}'+n
svg=E.parse(root/'public/the-last-light-v1.svg').getroot()
style=E.SubElement(svg,tag('style'))
style.text='''
@keyframes breathe { 0%,100% {opacity:.45;transform:scale(.99)} 50% {opacity:.88;transform:scale(1.035)} }
.halo {transform-origin:1065px 400px;animation:breathe 7s ease-in-out infinite}
@keyframes water {0%,100% {transform:translate(-3px,0);opacity:.65} 50% {transform:translate(5px,2px);opacity:1}}
.wave {animation:water 5s ease-in-out infinite}
@keyframes meteor {0%,78%,100% {opacity:0;transform:translate(0,0)} 80% {opacity:.9} 88% {opacity:0;transform:translate(350px,175px)}}
.meteor {opacity:0;animation:meteor 13s linear infinite}
@keyframes scarf {0%,100% {d:path('M1065 891 Q1078 889 1089 883 Q1106 875 1127 884 Q1104 882 1093 890 Q1078 898 1065 895Z')} 50% {d:path('M1065 891 Q1078 889 1089 892 Q1106 901 1127 887 Q1104 897 1093 898 Q1078 893 1065 895Z')}}
.scarf {animation:scarf 2.8s ease-in-out infinite}
@media(prefers-reduced-motion:reduce) {* {animation:none!important}}
'''
children=list(svg)
water=[e for e in children if e.tag==tag('path') and e.get('stroke') in ['#f6ba91','#ffc698','#b88680','#749cb4']]
index=list(svg).index(water[0])
groups=[]
for i in range(8):
    g=E.Element(tag('g'),{'class':'wave','style':f'animation-delay:-{i*.67}s;animation-duration:{4+i*.3}s'})
    svg.insert(index+i,g);groups.append(g)
for i,e in enumerate(water):svg.remove(e);groups[i%8].append(e)
for e in children:
    if e.tag==tag('circle') and e.get('r') in ['265','262']:e.set('class','halo')
    if e.get('fill')=='#ed5d55':e.set('class','scarf')
    if e.get('d')=='M1069 891Q1096 878 1118 882':svg.remove(e)
# Meteors are behind the black hole and mountains, never across the water.
idx=next(i for i,e in enumerate(svg) if e.get('r')=='265')
for i,(x,y) in enumerate([(180,110),(1320,95),(510,240),(90,370)]):
    g=E.Element(tag('g'),{'class':'meteor','style':f'animation-delay:-{i*3.1}s;animation-duration:{13+i*2}s'})
    E.SubElement(g,tag('path'),{'d':f'M{x} {y}l95 47','stroke':'#c3dfff','stroke-width':'1.2','opacity':'.6'})
    E.SubElement(g,tag('circle'),{'cx':str(x+95),'cy':str(y+47),'r':'1.8','fill':'#fff5dd'})
    svg.insert(idx+i,g)
svg.find(tag('title')).text='The Last Light — living sky, breathing halo, tides and wind'
for folder in ['public','dist']:
    E.ElementTree(svg).write(root/folder/'the-last-light-animated-v1.svg',encoding='unicode')
print('Created animated wallpaper; original preserved. 8 wave layers, 4 meteors, halo and scarf; reduced-motion support.')
