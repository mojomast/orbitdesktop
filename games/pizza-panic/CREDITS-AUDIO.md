# AGENT ARMEGEDDON: CLAWPOCALYPSE NOW audio credits

All music and sound effects are free assets released under **CC0 1.0** (public domain dedication,
https://creativecommons.org/publicdomain/zero/1.0/). No attribution is legally required; credit is given anyway.
Nothing here is CC-BY, NC or ND.

Files: `assets/audio/sfx-pack.ogg.txt` and `assets/audio/music-pack.ogg.txt` are plain Ogg Vorbis files laid end to end
(byte ranges in `audio-pack.js`; the `.txt` suffix only exists because Orbit's static app server has no audio MIME types).
Rebuild with `python3 ../pizza-panic-dev/tools/build_audio.py` (sources downloaded with curl from the URLs below).
Music: 112 kbps stereo Vorbis, loudness-matched, sample-exact seamless loops. SFX: mono, silence-trimmed, peak-normalised, Vorbis q4.

## Source packs

| Pack | Author | Licence | Page | Download |
|---|---|---|---|---|
| 5 Chiptunes (Action) | Juhani Junkala (SubspaceAudio) | CC0 | https://opengameart.org/content/5-chiptunes-action | https://opengameart.org/sites/default/files/5%20Action%20Chiptunes%20By%20Juhani%20Junkala.zip |
| 4 Chiptunes (Adventure) | Juhani Junkala (SubspaceAudio) | CC0 | https://opengameart.org/content/4-chiptunes-adventure | https://opengameart.org/sites/default/files/Juhani%20Junkala%20%5BChiptune%20Adventures%5D%20OGG.zip |
| Digital Audio | Kenney | CC0 | https://kenney.nl/assets/digital-audio | https://kenney.nl/media/pages/assets/digital-audio/216eac4753-1677590265/kenney_digital-audio.zip |
| Impact Sounds | Kenney | CC0 | https://kenney.nl/assets/impact-sounds | https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip |
| Music Jingles | Kenney | CC0 | https://kenney.nl/assets/music-jingles | https://kenney.nl/media/pages/assets/music-jingles/f37e530b9e-1677590399/kenney_music-jingles.zip |
| RPG Audio | Kenney | CC0 | https://kenney.nl/assets/rpg-audio | https://kenney.nl/media/pages/assets/rpg-audio/8e99002d76-1677590336/kenney_rpg-audio.zip |
| 80 CC0 RPG SFX | rubberduck | CC0 | https://opengameart.org/content/80-cc0-rpg-sfx | https://opengameart.org/sites/default/files/80-CC0-RPG-SFX_0.zip |
| Sci-fi Sounds | Kenney | CC0 | https://kenney.nl/assets/sci-fi-sounds | https://kenney.nl/media/pages/assets/sci-fi-sounds/6b296f9ecf-1677589334/kenney_sci-fi-sounds.zip |
| Swishes Sound Pack | artisticdude | CC0 | https://opengameart.org/content/swishes-sound-pack | https://opengameart.org/sites/default/files/swishes.zip |
| Interface Sounds | Kenney | CC0 | https://kenney.nl/assets/interface-sounds | https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip |
| Voiceover Pack: Fighter | Kenney | CC0 | https://kenney.nl/assets/voiceover-pack-fighter | https://kenney.nl/media/pages/assets/voiceover-pack-fighter/6ceb77c6f1-1677589837/kenney_voiceover-pack-fighter.zip |

## Cue -> asset

| Cue | Used for | Asset file(s) | Pack |
|---|---|---|---|
| `music: intro` | title / attract / intro cutscene | Juhani Junkala [Retro Game Music Pack] Title Screen.wav | 5 Chiptunes (Action) |
| `music: sewer` | level 1 (sewer) | Juhani Junkala [Retro Game Music Pack] Level 1.wav | 5 Chiptunes (Action) |
| `music: street` | level 2 (street) | Juhani Junkala [Retro Game Music Pack] Level 2.wav | 5 Chiptunes (Action) |
| `music: skate` | skate run + bonus stage | Juhani Junkala [Retro Game Music Pack] Level 3.wav | 5 Chiptunes (Action) |
| `music: rooftop` | rooftop level | Juhani Junkala [Chiptune Adventures] 1. Stage 1.ogg | 4 Chiptunes (Adventure) |
| `music: miniboss` | mini-boss gate | Juhani Junkala [Chiptune Adventures] 2. Stage 2.ogg | 4 Chiptunes (Adventure) |
| `music: boss / entrance` | boss fights + boss entrance cutscene | Juhani Junkala [Chiptune Adventures] 3. Boss Fight.ogg | 4 Chiptunes (Adventure) |
| `music: defeat` | boss defeated cutscene | Juhani Junkala [Chiptune Adventures] 4. Stage Select.ogg | 4 Chiptunes (Adventure) |
| `music: ending` | ending + credits / results roll | Juhani Junkala [Retro Game Music Pack] Ending.wav | 5 Chiptunes (Action) |
| `swing` | light punch whoosh | swish-1.wav, swish-2.wav, swish-11.wav, swish-12.wav, swish-13.wav | Swishes Sound Pack |
| `kick` | kick / jump kick | swish-7.wav, swish-9.wav, swish-3.wav | Swishes Sound Pack |
| `swingHeavy` | finishers, boss swipes | swish-7.wav, swish-9.wav, swish-3.wav | Swishes Sound Pack |
| `whiff` | missed attack | swish-4.wav, swish-5.wav | Swishes Sound Pack |
| `throw` | pizza / shuriken throw, enemy projectiles | swish-6.wav, swish-8.wav, swish-10.wav | Swishes Sound Pack |
| `melee` | light hit connects | impactPunch_medium_000.ogg, impactPunch_medium_001.ogg, impactPunch_medium_002.ogg, impactPunch_medium_003.ogg, impactPunch_medium_004.ogg | Impact Sounds |
| `heavy` | heavy hit connects | impactPunch_heavy_000.ogg, impactPunch_heavy_001.ogg, impactPunch_heavy_002.ogg, impactPunch_heavy_003.ogg, impactPunch_heavy_004.ogg | Impact Sounds |
| `hit` | score accent, pitch climbs with combo; "Combo!" every 10th | impactGeneric_light_000.ogg, impactGeneric_light_001.ogg, impactGeneric_light_002.ogg, impactGeneric_light_003.ogg, impactGeneric_light_004.ogg, combo.ogg | Impact Sounds, Voiceover Pack: Fighter |
| `ko` | enemy knocked out | impactPunch_heavy_000.ogg, impactPunch_heavy_001.ogg, impactPunch_heavy_002.ogg, impactPunch_heavy_003.ogg, impactPunch_heavy_004.ogg, impactSoft_heavy_000.ogg, impactSoft_heavy_001.ogg, impactSoft_heavy_002.ogg, impactSoft_heavy_003.ogg, impactSoft_heavy_004.ogg | Impact Sounds |
| `grab` | grab | cloth1.ogg, cloth3.ogg, impactSoft_medium_000.ogg | RPG Audio, Impact Sounds |
| `block` | block | impactPlate_light_000.ogg, impactPlate_light_001.ogg, impactPlate_light_002.ogg | Impact Sounds |
| `parry` | parry | impactMetal_heavy_000.ogg, impactMetal_heavy_001.ogg | Impact Sounds |
| `special` | health-cost special move | spell_01.ogg, phaserUp3.ogg | 80 CC0 RPG SFX, Digital Audio |
| `jump` | jump | phaseJump2.ogg, phaseJump4.ogg | Digital Audio |
| `hurt` | player hurt | impactSoft_heavy_000.ogg, impactSoft_heavy_001.ogg, impactSoft_heavy_002.ogg, impactSoft_heavy_003.ogg, impactSoft_heavy_004.ogg, lowDown.ogg | Impact Sounds, Digital Audio |
| `impact` | landings, slams, throws, banner slam | impactSoft_heavy_000.ogg, impactSoft_heavy_001.ogg, impactSoft_heavy_002.ogg, impactSoft_heavy_003.ogg, impactSoft_heavy_004.ogg, lowFrequency_explosion_001.ogg | Impact Sounds, Sci-fi Sounds |
| `crunch` | breakable damaged | impactWood_medium_000.ogg, impactWood_medium_001.ogg, impactWood_medium_002.ogg | Impact Sounds |
| `smash` | breakable destroyed, rank stamp | impactGlass_heavy_000.ogg, impactGlass_heavy_001.ogg, impactGlass_heavy_002.ogg, impactWood_heavy_000.ogg, impactWood_heavy_001.ogg | Impact Sounds |
| `pickup / coin` | score items, coins, tips | item_coins_01.ogg, item_coins_03.ogg | 80 CC0 RPG SFX |
| `power` | weapon / shield power-up | powerUp7.ogg, item_gem_01.ogg | Digital Audio, 80 CC0 RPG SFX |
| `life` | extra life / heal | jingles_NES03.ogg | Music Jingles |
| `warn` | life lost, shop refusal, boss gatling | error_006.ogg | Interface Sounds |
| `wave` | new wave | jingles_NES09.ogg | Music Jingles |
| `victory` | victory fanfare | jingles_NES12.ogg | Music Jingles |
| `clear` | stage clear results card ("You win!") | jingles_NES05.ogg, you_win.ogg | Music Jingles, Voiceover Pack: Fighter |
| `heart` | low-health heartbeat | impactSoft_medium_000.ogg, impactSoft_medium_001.ogg, impactSoft_medium_002.ogg | Impact Sounds |
| `boss` | boss arrival roar | creature_roar_02.ogg, creature_roar_03.ogg, lowFrequency_explosion_001.ogg | 80 CC0 RPG SFX, Sci-fi Sounds |
| `bossdie` | boss defeated | explosionCrunch_004.ogg, lowFrequency_explosion_000.ogg, creature_roar_02.ogg, creature_roar_03.ogg | Sci-fi Sounds, 80 CC0 RPG SFX |
| `explode` | drone explodes | explosionCrunch_000.ogg, explosionCrunch_001.ogg | Sci-fi Sounds |
| `charge` | drone telegraph | forceField_000.ogg | Sci-fi Sounds |
| `sting` | mini-boss / assist / S-rank stinger | jingles_HIT11.ogg | Music Jingles |
| `continue` | CONTINUE? screen opens | jingles_HIT05.ogg | Music Jingles |
| `count` | continue countdown announcer | 1.ogg, 2.ogg, 3.ogg, 4.ogg, 5.ogg, 6.ogg, 7.ogg, 8.ogg, 9.ogg, 10.ogg | Voiceover Pack: Fighter |
| `over` | game over ("Game over") | jingles_NES00.ogg, game_over.ogg | Music Jingles, Voiceover Pack: Fighter |
| `fight` | run start ("Fight!") | fight.ogg | Voiceover Pack: Fighter |
| `chime` | scene-out, shop, world map, set pieces | jingles_STEEL10.ogg | Music Jingles |
| `pause / unpause` | pause menu open / close | open_001.ogg, close_001.ogg | Interface Sounds |
| `start / menuConfirm` | confirm | confirmation_001.ogg | Interface Sounds |
| `menuMove` | select screen, shop, initials navigation | select_001.ogg, select_002.ogg | Interface Sounds |
| `menuBack` | back | back_002.ogg | Interface Sounds |
| `tick` | results count-up, countdown skip | tick_002.ogg | Interface Sounds |
| `blip` | typewriter text | click_002.ogg | Interface Sounds |
| `whoosh` | camera pans, dashes, drone dives | swish-7.wav, swish-9.wav, swish-3.wav, thrusterFire_000.ogg | Swishes Sound Pack, Sci-fi Sounds |
| `riser` | tension riser | thrusterFire_000.ogg, forceField_000.ogg | Sci-fi Sounds |
| `thunder` | thunder, flame attacks, ambush | lowFrequency_explosion_000.ogg, lowFrequency_explosion_001.ogg | Sci-fi Sounds |
