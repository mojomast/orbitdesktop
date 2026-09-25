# MiMo Voice Lab (release 1.2.0)

Deployed within the existing Performance Lab at https://kimi.tailec998.ts.net:4366/ through trusted extension mimo-bench, loopback 4470. Refresh the app to load Voice Lab. No Orbit core restart or workspace layout edits.

Four audio models: mimo-v2.5-tts (built-in voice ID, default Chloe), mimo-v2.5-tts-voicedesign (natural-language description), mimo-v2.5-tts-voiceclone (authorized WAV/MP3 reference), mimo-v2.5-asr (WAV/MP3 transcription, auto/en/zh). Each click sends one non-streaming request. Voice comparison is manual using successive result cards, separate from Compare all text models. No microphone capture or first-audio streaming metric.

Text/style bounded to 1500 characters each. Uploads bounded to 6 MB, WAV validated and limited to 120 seconds; MP3 header checked but duration not parsed (UI asks for short clips). One concurrent voice request, 120-second socket timeout, bounded response size, fixed provider endpoint, no redirects. API key stays in server vault. Owner identity, exact Origin, content type, paid-call consent and cloning rights required. Raw input/reference audio and voice results are never persisted by the service. Browser holds results until clear/reload; downloads create local files. Provider processing/retention remains subject to Xiaomi policy. Closing browser does not cancel charges.

Results include full-response latency, generated WAV duration and real-time factor (request seconds / audio seconds), usage when returned, browser playback and WAV download. Download from top-level tab if Orbit sandbox blocks downloads. ASR transcript is selectable text.

Verification: four audio payload/validation unit tests and six existing benchmark tests passed. Full npm run check: build plus 75 tests passed. Real browser integration tests/mimo-voice.browser.py exercised all four models, consent, upload, synthesis playback, download, ASR content, clone permission, clearing, invalid request/Origin and no JS errors. Used only synthetic text and generated voice-design audio, not a human voice. Final measured samples: TTS 5889.43ms/5.28s audio; design 4739.84ms/4.32s; ASR 10106.8ms with correct transcript; clone 6777.38ms/4.96s. One earlier TTS call also succeeded before a CSP-incompatible test wait was fixed; no application CSP relaxation. Small smoke samples, not statistically reliable performance estimates.

Prior 1.1.0 extension retained for code rollback. Workspace checkpoints do not restore code, voice downloads, benchmark history, or API charges. Extension needs startup after reboot; update only Tailscale 4366 route if changing backend port.

API reference checked via SearXNG and Xiaomi documentation:
https://mimo.mi.com/docs/en-US/quick-start/usage-guide/audio/speech-synthesis-v2.5
https://mimo.mi.com/docs/en-US/quick-start/usage-guide/audio/Speech-Recognition
