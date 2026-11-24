#!/usr/bin/env python3
"""Build Pizza Panic audio packs: trims/normalises/encodes sources to Ogg Vorbis,
concatenates them into one SFX pack and one music pack, and writes audio-pack.js."""
import subprocess, json, os, re, sys, shutil
S = '/workspace/ppaudio/src'; O = '/workspace/ppaudio/out'; T = O + '/tmp'
os.makedirs(T, exist_ok=True)
K = {  # pack dir -> (title, source page, download URL, author, licence)
 'impact':  ('Impact Sounds', 'https://kenney.nl/assets/impact-sounds', 'https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip', 'Kenney', 'CC0'),
 'ui':      ('Interface Sounds', 'https://kenney.nl/assets/interface-sounds', 'https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip', 'Kenney', 'CC0'),
 'digital': ('Digital Audio', 'https://kenney.nl/assets/digital-audio', 'https://kenney.nl/media/pages/assets/digital-audio/216eac4753-1677590265/kenney_digital-audio.zip', 'Kenney', 'CC0'),
 'rpg':     ('RPG Audio', 'https://kenney.nl/assets/rpg-audio', 'https://kenney.nl/media/pages/assets/rpg-audio/8e99002d76-1677590336/kenney_rpg-audio.zip', 'Kenney', 'CC0'),
 'jingles': ('Music Jingles', 'https://kenney.nl/assets/music-jingles', 'https://kenney.nl/media/pages/assets/music-jingles/f37e530b9e-1677590399/kenney_music-jingles.zip', 'Kenney', 'CC0'),
 'scifi':   ('Sci-fi Sounds', 'https://kenney.nl/assets/sci-fi-sounds', 'https://kenney.nl/media/pages/assets/sci-fi-sounds/6b296f9ecf-1677589334/kenney_sci-fi-sounds.zip', 'Kenney', 'CC0'),
 'voice':   ('Voiceover Pack: Fighter', 'https://kenney.nl/assets/voiceover-pack-fighter', 'https://kenney.nl/media/pages/assets/voiceover-pack-fighter/6ceb77c6f1-1677589837/kenney_voiceover-pack-fighter.zip', 'Kenney', 'CC0'),
 'swish':   ('Swishes Sound Pack', 'https://opengameart.org/content/swishes-sound-pack', 'https://opengameart.org/sites/default/files/swishes.zip', 'artisticdude', 'CC0'),
 'rpg80':   ('80 CC0 RPG SFX', 'https://opengameart.org/content/80-cc0-rpg-sfx', 'https://opengameart.org/sites/default/files/80-CC0-RPG-SFX_0.zip', 'rubberduck', 'CC0'),
 'action':  ('5 Chiptunes (Action)', 'https://opengameart.org/content/5-chiptunes-action', 'https://opengameart.org/sites/default/files/5%20Action%20Chiptunes%20By%20Juhani%20Junkala.zip', 'Juhani Junkala (SubspaceAudio)', 'CC0'),
 'adventure': ('4 Chiptunes (Adventure)', 'https://opengameart.org/content/4-chiptunes-adventure', 'https://opengameart.org/sites/default/files/Juhani%20Junkala%20%5BChiptune%20Adventures%5D%20OGG.zip', 'Juhani Junkala (SubspaceAudio)', 'CC0'),
}
D = {'impact': 'impact-sounds/Audio', 'ui': 'interface-sounds/Audio', 'digital': 'digital-audio/Audio', 'rpg': 'rpg-audio/Audio',
     'scifi': 'sci-fi-sounds/Audio', 'voice': 'voiceover-pack-fighter/Audio', 'swish': 'swishes/swishes', 'rpg80': 'rpg80',
     'action': 'action', 'adventure': 'adventure'}
def src(pack, name):
    if pack == 'jingles':
        sub = {'NES': '8-Bit jingles', 'HIT': 'Hit jingles', 'STEEL': 'Steel jingles', 'PIZZI': 'Pizzicato jingles', 'SAX': 'Sax jingles'}[re.match(r'jingles_([A-Z]+)', name).group(1)]
        return f'{S}/music-jingles/Audio/{sub}/{name}'
    return f'{S}/{D[pack]}/{name}'
# key, pack, file, peak dBFS target (loud cues ~-1, soft ones lower)
SFX = [
 # melee whooshes (light / heavy / miss / thrown)
 *[(f'swing{i}', 'swish', f'swish-{n}.wav', -3) for i, n in enumerate([1, 2, 11, 12, 13])],
 *[(f'swingH{i}', 'swish', f'swish-{n}.wav', -2) for i, n in enumerate([7, 9, 3])],
 *[(f'whiff{i}', 'swish', f'swish-{n}.wav', -8) for i, n in enumerate([4, 5])],
 *[(f'throw{i}', 'swish', f'swish-{n}.wav', -4) for i, n in enumerate([6, 8, 10])],
 # contact
 *[(f'punchM{i}', 'impact', f'impactPunch_medium_00{i}.ogg', -1.5) for i in range(5)],
 *[(f'punchH{i}', 'impact', f'impactPunch_heavy_00{i}.ogg', -1) for i in range(5)],
 *[(f'tap{i}', 'impact', f'impactGeneric_light_00{i}.ogg', -6) for i in range(5)],
 *[(f'thud{i}', 'impact', f'impactSoft_heavy_00{i}.ogg', -1) for i in range(5)],
 *[(f'soft{i}', 'impact', f'impactSoft_medium_00{i}.ogg', -3) for i in range(3)],
 *[(f'block{i}', 'impact', f'impactPlate_light_00{i}.ogg', -4) for i in range(3)],
 *[(f'parry{i}', 'impact', f'impactMetal_heavy_00{i}.ogg', -3) for i in range(2)],
 *[(f'wood{i}', 'impact', f'impactWood_medium_00{i}.ogg', -3) for i in range(3)],
 *[(f'woodH{i}', 'impact', f'impactWood_heavy_00{i}.ogg', -2) for i in range(2)],
 *[(f'glass{i}', 'impact', f'impactGlass_heavy_00{i}.ogg', -3) for i in range(3)],
 *[(f'grab{i}', 'rpg', f'cloth{n}.ogg', -4) for i, n in enumerate([1, 3])],
 # explosions / boss
 *[(f'boom{i}', 'scifi', f'explosionCrunch_00{n}.ogg', -1) for i, n in enumerate([0, 1])],
 ('bigBoom', 'scifi', 'explosionCrunch_004.ogg', -1),
 ('rumble', 'scifi', 'lowFrequency_explosion_000.ogg', -1),
 ('rumbleS', 'scifi', 'lowFrequency_explosion_001.ogg', -1),
 ('hiss', 'scifi', 'thrusterFire_000.ogg', -4),
 ('charge', 'scifi', 'forceField_000.ogg', -5),
 *[(f'roar{i}', 'rpg80', f'creature_roar_0{n}.ogg', -1) for i, n in enumerate([2, 3])],
 # pickups / power
 *[(f'coin{i}', 'rpg80', f'item_coins_0{n}.ogg', -4) for i, n in enumerate([1, 3])],
 ('gem', 'rpg80', 'item_gem_01.ogg', -4),
 ('power', 'digital', 'powerUp7.ogg', -5),
 ('special', 'rpg80', 'spell_01.ogg', -3),
 ('special2', 'digital', 'phaserUp3.ogg', -7),
 ('jump0', 'digital', 'phaseJump2.ogg', -9), ('jump1', 'digital', 'phaseJump4.ogg', -9),
 ('ouch', 'digital', 'lowDown.ogg', -10),
 # UI
 *[(f'move{i}', 'ui', f'select_00{n}.ogg', -6) for i, n in enumerate([1, 2])],
 ('confirm', 'ui', 'confirmation_001.ogg', -4),
 ('back', 'ui', 'back_002.ogg', -5),
 ('open', 'ui', 'open_001.ogg', -5), ('close', 'ui', 'close_001.ogg', -5),
 ('error', 'ui', 'error_006.ogg', -5),
 ('tick', 'ui', 'tick_002.ogg', -8), ('blip', 'ui', 'click_002.ogg', -10),
 # stingers (Kenney Music Jingles)
 ('jOver', 'jingles', 'jingles_NES00.ogg', -2),
 ('jWave', 'jingles', 'jingles_NES09.ogg', -4),
 ('jLife', 'jingles', 'jingles_NES03.ogg', -4),
 ('jClear', 'jingles', 'jingles_NES05.ogg', -3),
 ('jVictory', 'jingles', 'jingles_NES12.ogg', -3),
 ('jChime', 'jingles', 'jingles_STEEL10.ogg', -5),
 ('jSting', 'jingles', 'jingles_HIT11.ogg', -1),
 ('jContinue', 'jingles', 'jingles_HIT05.ogg', -2),
 # announcer (Kenney Voiceover Pack: Fighter)
 *[(f'vo{n}', 'voice', f'{n}.ogg', -2) for n in range(1, 11)],
 ('voFight', 'voice', 'fight.ogg', -2), ('voGameOver', 'voice', 'game_over.ogg', -2),
 ('voWin', 'voice', 'you_win.ogg', -2), ('voCombo', 'voice', 'combo.ogg', -3),
]
# theme name, pack, file, gain dB (levels the tracks against each other)
MUSIC = [
 ('intro',    'action',    'Juhani Junkala [Retro Game Music Pack] Title Screen.wav', -6.0),
 ('sewer',    'action',    'Juhani Junkala [Retro Game Music Pack] Level 1.wav', -6.5),
 ('street',   'action',    'Juhani Junkala [Retro Game Music Pack] Level 2.wav', -6.5),
 ('skate',    'action',    'Juhani Junkala [Retro Game Music Pack] Level 3.wav', -6.0),
 ('rooftop',  'adventure', 'Juhani Junkala [Chiptune Adventures] 1. Stage 1.ogg', -1.5),
 ('miniboss', 'adventure', 'Juhani Junkala [Chiptune Adventures] 2. Stage 2.ogg', -1.5),
 ('boss',     'adventure', 'Juhani Junkala [Chiptune Adventures] 3. Boss Fight.ogg', -1.0),
 ('defeat',   'adventure', 'Juhani Junkala [Chiptune Adventures] 4. Stage Select.ogg', 0.0),
 ('ending',   'action',    'Juhani Junkala [Retro Game Music Pack] Ending.wav', -3.0),
]
def run(*a): return subprocess.run(a, capture_output=True, text=True, check=True)
def peak(f):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-i', f, '-af', 'volumedetect', '-f', 'null', '-'], capture_output=True, text=True).stderr
    return float(re.search(r'max_volume: (-?[\d.]+) dB', r).group(1))
def dur(f): return float(run('ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f).stdout)
def build_pack(items, out, enc):
    blob = bytearray(); man = {}
    for key, path, meta in items:
        off = len(blob); data = open(path, 'rb').read(); blob += data
        man[key] = [off, len(data), round(dur(path), 3)]
    open(out, 'wb').write(blob); return man
sfx_items = []; credits = []
for key, pack, name, target in SFX:
    s = src(pack, name); assert os.path.exists(s), s
    trim = f'{T}/{key}.wav'
    # trim leading/trailing silence, mono 44.1k, 4 ms fade-in guard, 15 ms fade-out
    run('ffmpeg', '-y', '-v', 'error', '-i', s, '-af',
        'silenceremove=start_periods=1:start_threshold=-55dB:start_silence=0.004,areverse,silenceremove=start_periods=1:start_threshold=-60dB:start_silence=0.01,afade=t=in:d=0.015,areverse,afade=t=in:d=0.002',
        '-ac', '1', '-ar', '44100', *(['-t', '2.4'] if key == 'hiss' else []), trim)
    g = target - peak(trim)
    o = f'{T}/{key}.ogg'
    run('ffmpeg', '-y', '-v', 'error', '-i', trim, '-af', f'volume={g:.2f}dB', '-c:a', 'libvorbis', '-q:a', '4', o)
    sfx_items.append((key, o, None)); credits.append((key, pack, name))
mus_items = []
for key, pack, name, gain in MUSIC:
    s = src(pack, name); o = f'{T}/m_{key}.ogg'
    run('ffmpeg', '-y', '-v', 'error', '-i', s, '-af', f'volume={gain}dB', '-ar', '44100', '-ac', '2', '-c:a', 'libvorbis', '-b:a', '112k', o)
    mus_items.append((key, o, None)); credits.append((key, pack, name))
sfx = build_pack(sfx_items, f'{O}/sfx-pack.ogg.txt', None)
mus = build_pack(mus_items, f'{O}/music-pack.ogg.txt', None)
json.dump({'sfx': sfx, 'music': mus, 'credits': credits, 'packs': K}, open(f'{O}/manifest.json', 'w'), indent=1)
js = ('// Generated by pizza-panic-dev/tools/build_audio.py -- do not edit by hand.\n'
      '// Byte ranges [offset, length, seconds] of the Ogg Vorbis files concatenated into\n'
      '// assets/audio/*-pack.ogg.txt (.txt only because Orbit\'s static app server has no\n'
      '// audio MIME types; the bytes are plain Ogg Vorbis). All sources are CC0, see CREDITS-AUDIO.md.\n'
      f"export const SFX_PACK = 'assets/audio/sfx-pack.ogg.txt';\nexport const MUSIC_PACK = 'assets/audio/music-pack.ogg.txt';\n"
      f'export const SFX = {json.dumps(sfx, separators=(",", ":"))};\n'
      f'export const MUSIC = {json.dumps(mus, separators=(",", ":"))};\n')
open(f'{O}/audio-pack.js', 'w').write(js)
print('sfx', len(sfx), os.path.getsize(f'{O}/sfx-pack.ogg.txt'), 'music', len(mus), os.path.getsize(f'{O}/music-pack.ogg.txt'))
