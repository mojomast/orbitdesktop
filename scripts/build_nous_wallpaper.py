"""Original Comet composition with attributed Nous seal. No external image requests."""
from pathlib import Path
import base64, math
R = Path(__file__).resolve().parents[1]
seal = base64.b64encode((R/'public/art/nous/nous-girl.svg').read_bytes()).decode()
rays = ''.join(f'<path d="M{1500+math.cos(a)*r:.2f} {590+math.sin(a)*r:.2f}L{1500+math.cos(a)*(r+length):.2f} {590+math.sin(a)*(r+length):.2f}"/>' for i in range(180) for a,r,length in [(i*math.pi/90,365,85 if i%5==0 else 35)])
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="2560" height="1440" viewBox="0 0 2560 1440">
<title>Nous Atelier — Comet celestial research atlas</title><desc>Original radial engraving composition with Nous Research's girl seal, sourced from the official Hermes website. See docs/NOUS_THEME.md for attribution.</desc>
<defs><radialGradient id="glow" cx="65%" cy="40%" r="70%"><stop stop-color="#29249a"/><stop offset=".6" stop-color="#151539"/><stop offset="1" stop-color="#11112b"/></radialGradient><pattern id="dots" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".7" fill="#aaa8ff" opacity=".14"/></pattern><linearGradient id="ink"><stop stop-color="#6560ee"/><stop offset="1" stop-color="#c4bfff"/></linearGradient></defs>
<path fill="url(#glow)" d="M0 0H2560V1440H0Z"/><path fill="url(#dots)" d="M0 0H2560V1440H0Z"/>
<g fill="none" stroke="#a5a0ff" opacity=".3">{rays}<circle cx="1500" cy="590" r="360"/><circle cx="1500" cy="590" r="354"/><circle cx="1500" cy="590" r="470" stroke-dasharray="1 11"/><ellipse cx="1500" cy="590" rx="740" ry="235" transform="rotate(-24 1500 590)"/><ellipse cx="1500" cy="590" rx="810" ry="280" transform="rotate(32 1500 590)"/></g>
<image href="data:image/svg+xml;base64,{seal}" x="1286" y="285" width="428" height="599" opacity=".9"/>
<g fill="none" stroke="#a6a0ff" opacity=".5"><path d="M120 100H2440M120 1290H2440M120 90V115M2440 90V115M120 1275V1300M2440 1275V1300"/><path d="M2150 340v64m-32-32h64m-48-16 32 32m0-32-32 32M820 910v40m-20-20h40"/></g>
<g fill="#dfdcff" font-family="sans-serif"><text x="145" y="170" font-size="15" letter-spacing="7">COMET / NOUS ATELIER</text><text x="145" y="1160" font-size="108" font-weight="200" letter-spacing="12">OPEN INTELLIGENCE.</text><text x="150" y="1210" font-size="16" letter-spacing="6" opacity=".65">A WORKSPACE FOR THE CURIOUS // HERMES</text><text x="2250" y="1340" font-size="13" letter-spacing="3" opacity=".6">PLATE / 001</text></g>
</svg>'''
(R/'public/wallpapers/nous.svg').write_text(svg)
print('Built self-contained Nous wallpaper', len(svg.encode()), 'bytes')
