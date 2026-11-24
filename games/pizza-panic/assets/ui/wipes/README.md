# Claw stage wipe (mr_india, t_96f516de1275486c)
wipe_01.png .. wipe_10.png: 370x255 paletted PNGs (half the 740x510 canvas; draw scaled to W x H), ~91 KB total.
Source art: OpenClaw claw slash (keyed from magenta, claw and slash trails split).
- 01-04: claw sweeps in from top-left, slash trails extend behind it
- 05-07: the slashes widen into black-red; 07 is fully opaque (stage swap point)
- 08-10: tears open along the slashes and reveal the stage, fading out
Played by wipe.js (~0.5 s, 50 ms per frame) when play resumes on a new stage. Overlay only, skipped with
Reduced motion / Reduced flash or ?wipe=0. Rebuild: /workspace/wipe-art/build_frames.py.
