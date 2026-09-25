"""Generate original resolution-independent eclipse artwork and a 4K PNG."""
from pathlib import Path
import random
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
rng = random.Random(87121)
s = ['''<svg xmlns="http://www.w3.org/2000/svg" width="3840" height="2160" viewBox="0 0 1920 1080">
<title>The Last Light — original generative artwork</title><defs>
<linearGradient id="sky" x2="0" y2="1"><stop stop-color="#020611"/><stop offset=".52" stop-color="#11253c"/><stop offset=".8" stop-color="#5b4252"/><stop offset="1" stop-color="#ef9773"/></linearGradient>
<radialGradient id="aura"><stop stop-color="#fff3b6" stop-opacity=".85"/><stop offset=".39" stop-color="#fa955f" stop-opacity=".52"/><stop offset=".63" stop-color="#c46574" stop-opacity=".13"/><stop offset="1" stop-color="#8e5c9a" stop-opacity="0"/></radialGradient>
<linearGradient id="ring" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#90ddf1"/><stop offset=".42" stop-color="#f3d7c9"/><stop offset=".75" stop-color="#ffb07a"/><stop offset="1" stop-color="#fff7c5"/></linearGradient>
<linearGradient id="planet" x2=".8" y2="1"><stop stop-color="#030913"/><stop offset=".7" stop-color="#0a1322"/><stop offset="1" stop-color="#251d2b"/></linearGradient>
<linearGradient id="sea" x2="0" y2="1"><stop stop-color="#614954"/><stop offset=".12" stop-color="#253447"/><stop offset=".55" stop-color="#0b1b2c"/><stop offset="1" stop-color="#040c19"/></linearGradient>
<radialGradient id="vignette"><stop offset=".36" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#00030b" stop-opacity=".64"/></radialGradient>
<filter id="blur"><feGaussianBlur stdDeviation="22"/></filter><filter id="glow"><feGaussianBlur stdDeviation="7"/></filter>
</defs><path fill="url(#sky)" d="M0 0H1920V730H0z"/>
<ellipse cx="1065" cy="445" rx="690" ry="590" fill="url(#aura)"/>
''']
for i in range(1500):
    x,y=rng.uniform(0,1920),rng.uniform(0,690)
    r=rng.choices([.45,.7,1,1.4],[5,4,2,1])[0]
    s.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{r}" fill="{rng.choice(["#d5e8ff","#8eaccb","#ffe2c6"])}" opacity="{rng.uniform(.12,.75)*(1-y/900):.3f}"/>')
s.append('''<path d="M-100 560 Q650 180 1600 -50" fill="none" stroke="#609dc0" stroke-width="55" opacity=".07" filter="url(#blur)"/>
<circle cx="1065" cy="400" r="265" fill="none" stroke="#ffae83" stroke-width="32" opacity=".6" filter="url(#blur)"/>
<circle cx="1065" cy="400" r="262" fill="none" stroke="url(#ring)" stroke-width="10" filter="url(#glow)"/>
<circle cx="1065" cy="400" r="261" fill="url(#planet)" stroke="url(#ring)" stroke-width="2.6"/>
<path d="M860 562 A261 261 0 0 0 1290 534" fill="none" stroke="#ffe8b0" stroke-width="3"/>
<ellipse cx="1122" cy="655" rx="100" ry="12" fill="#ffd3a0" opacity=".7" filter="url(#glow)"/>
<path d="M0 719 L100 699 164 706 250 666 292 683 369 629 424 662 456 652 517 698 590 710 686 727 0 750Z" fill="#192335"/>
<path d="M1330 727 L1450 695 1500 671 1528 680 1610 615 1674 655 1710 641 1788 689 1865 657 1920 672V752Z" fill="#1b2435"/>
<path d="M0 735 Q500 728 960 735 T1920 730 V1080H0Z" fill="url(#sea)"/>
<path d="M480 737 Q1065 720 1490 737" fill="none" stroke="#ffcda1" opacity=".7"/>
''')
for i in range(2200):
    y=rng.uniform(739,1080); depth=(y-739)/341
    x=rng.uniform(0,1920)
    central=max(0,1-abs(x-1080)/(70+depth*400))
    color=rng.choice(['#f6ba91','#ffc698','#b88680']) if central>.15 else '#749cb4'
    opacity=rng.uniform(.03,.2)*(central+.22)
    width=rng.uniform(2,16)*(1+depth*3)
    s.append(f'<path d="M{x:.1f} {y:.1f}h{width:.1f}" stroke="{color}" stroke-width="{rng.uniform(.4,1.5):.2f}" opacity="{opacity:.3f}"/>')
s.append('''<path d="M0 1024 L158 998 249 1006 365 974 454 991 559 960 657 981 751 954 852 970 912 949 977 966 1023 944 1070 952 1108 945 1138 959 1183 962 1210 977 1280 989 1332 1022 1450 1045 1600 1034 1752 1052 1920 1040V1080H0Z" fill="#030914"/>
<path d="M752 956L852 972 914 950 977 968 1023 946 1070 954 1108 947" stroke="#997c73" stroke-width="1.1" fill="none" opacity=".6"/>
<!-- One small human, looking into something impossibly large. -->
<ellipse cx="1071" cy="951" rx="20" ry="3" fill="#000" opacity=".6"/>
<path d="M1064 920 L1061 950 1067 951 1073 928 1076 950 1082 950 1079 917Z" fill="#030710"/>
<path d="M1063 891 Q1070 886 1077 892 L1082 925 Q1072 931 1058 924Z" fill="#080d18" stroke="#c6a58a" stroke-width=".7"/>
<path d="M1063 895L1058 914 1054 920M1078 895L1083 915" stroke="#090c15" stroke-width="5" stroke-linecap="round"/>
<ellipse cx="1070" cy="882" rx="6.3" ry="8" fill="#060a12" stroke="#dfb895" stroke-width=".65"/>
<path d="M1065 891 Q1078 889 1089 883 Q1106 875 1127 884 Q1104 882 1093 890 Q1078 898 1065 895Z" fill="#ed5d55"/>
<path d="M1069 891Q1096 878 1118 882" fill="none" stroke="#ffb091" stroke-width=".8"/>
<rect width="1920" height="1080" fill="url(#vignette)"/>
</svg>''')
svg=''.join(s)
name='the-last-light-v1'
for folder in ['public','dist']:
    (root/folder/f'{name}.svg').write_text(svg)
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':3840,'height':2160},device_scale_factor=1)
    page.goto((root/'public'/f'{name}.svg').as_uri())
    page.screenshot(path=str(root/'public'/f'{name}-4k.png'))
    browser.close()
print(f'Created {name}.svg and rendered 3840×2160 PNG')
