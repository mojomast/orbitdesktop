# Local voice dictation

Voice transcript is a **reviewed host surface**: choose an audio file or explicitly
record a microphone clip, review/edit the transcript, then choose an existing
conversation draft. Draft insertion uses `requestConversationContext`; it never
submits a message or invokes Hermes. Generated plugin frames receive no bridge.

## Provisioning

The server never downloads models. Run this deliberately on the Orbit host:

```sh
node scripts/provision_voice_models.mjs --models-root .runtime/models
```

This downloads eight public MIT artifacts (~32 MB) from
`onnx-community/moonshine-tiny-ONNX`, revision
`a6da1241cd305dcd64eab1edbd615f2bb9aabb95`. Every file, including JSON/tokenizer
metadata, has a reviewed byte-length and SHA-256 pin in
`server/voice-model-assets.mjs`. The script checks bytes **after download**, writes
private temporary files, fsyncs and atomically publishes them. Existing files are
reverified without network; corrupt files and symlink paths fail closed. The
script requires an explicit destination. Never commit weights or include them in
plugin bundles/source archives. Disposable test models may live outside the repo.
The directory must match the server's configured model root: when Orbit uses a
custom runtime directory, use `<runtimeRoot>/models`, or the exact directory in
`ORBIT_VOICE_MODELS_ROOT`, instead of the repository's `.runtime/models`.

The panel's **Check local model** only makes local HEAD requests. Missing or
checksum-invalid files show provisioning instructions; there is no fallback to a
remote service and no fabricated transcript.

## Controls and lifecycle

- **Hold to record** supports pointer hold and Space/Enter hold; releasing stops.
  **Start recording / Stop recording** provide an accessible click alternative.
  A visible recording indicator and elapsed timer remain present while recording.
- Microphone acquisition happens only after the explicit action. Stop, Cancel,
  disposal and `pagehide` stop every track. A late permission response after Cancel
  or hold release is stopped immediately.
- Files are decoded through the browser's AudioContext. Channels are averaged to
  mono; windowed-sinc low-pass resampling to 16 kHz happens in the inference worker.
  Encoded audio and decoded channel buffers are independently bounded to 30 MiB;
  duration is bounded to 300 seconds (the caller may lower it).
- Long clips are recognized in independent 30-second sections. Section boundaries
  can split words; review the combined transcript carefully.
- The lazily created dedicated worker runs real Transformers **4.3.0**, Moonshine
  q8 and CPU WASM. Remote models, browser model cache and Transformers' blob-import
  WASM cache are disabled. Model fetches are confined to the pinned local prefix.
- One worker is reused for completed requests. Cancel/error/disposal terminates it;
  an idle completed worker is terminated after 60 seconds. Worker/request identity
  checks reject late results. Cancel/failures retain the existing edited transcript.
- Provenance shows input source, model revision, WASM/one thread, audio duration
  and measured inference time. Transcript text is editable and inserted only into
  one explicitly chosen registered draft. This surface saves neither audio nor text.

Microphone capture requires a secure context (HTTPS or localhost) and browser
MediaRecorder support. File decoding support depends on browser codecs. Encoded
byte checks precede decoding; the browser decoder can allocate buffers before the
decoded-byte/duration checks run. The bounds are application limits, not a decoder
memory sandbox. English recognition quality is model-dependent, including possible
hallucinations on silence/noise. No read-aloud control is offered: a permissively
licensed G2P path for local TTS has not been resolved.

## Parent integration contract

```ts
import { mountVoiceCapture } from './voice-capture';
const view = mountVoiceCapture(host, token, { paneId });
// On pane disposal:
view.dispose();
```

`token` is the existing host callback; it is not sent to the worker or asset URLs.
`paneId` is accepted for the shared surface contract; this feature has no persistent
draft storage. The parent should lazily import the host module.

```js
import { createVoiceModelAssets } from './voice-model-assets.mjs';
const voiceAssets = createVoiceModelAssets({
  root: applicationRoot,
  modelsRoot: env.ORBIT_VOICE_MODELS_ROOT ?? path.join(runtimeRoot, 'models'),
});
// Exact dedicated namespace, before static/SPA fallback:
if (url.pathname.startsWith('/vendor/voice/')) {
  return voiceAssets.handle(req, res, url.pathname);
}
```

`root` means the trusted **application installation**, never the runtime directory.
Factory construction does no IO. `modelsRoot` selects the explicitly provisioned
runtime model directory; the standalone default is `<root>/.runtime/models`.
The first ORT request resolves `onnxruntime-web` through the application package's
Node dependency resolution and canonicalizes its installed root once. External or
symlinked `node_modules` is supported for immutable release installations. Package
name/version and the exact canonical ORT file byte lengths/hashes must still match.
Model paths retain strict no-follow checks, including their parent directories;
canonical ORT files also reject symlinks after trusted package resolution.
GET/HEAD only; exact allowlisted paths; every request verifies bytes. Pinned file
sizes are checked before reading, and descriptor reads stay bounded even if a file
grows. Missing files return 404 and invalid files 503. These are public model/library assets,
not private audio or owner records. The route has no authentication token requirement.

ORT paths are versioned by the **actual installed version**:

```text
/vendor/voice/ort/1.31.0-dev.20260914-8d85527a0/ort-wasm-simd-threaded.mjs
/vendor/voice/ort/1.31.0-dev.20260914-8d85527a0/ort-wasm-simd-threaded.wasm
/vendor/voice/models/onnx-community/moonshine-tiny-ONNX/resolve/a6da1241cd305dcd64eab1edbd615f2bb9aabb95/<allowlisted-file>
```

Both ORT files have SHA-256 pins. The CPU WASM is 14,264,838 bytes, not the larger
JSEP/WebGPU binary. `numThreads=1` and `proxy=false`; no COOP, COEP or
SharedArrayBuffer is required. Parent document and worker responses need
`script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'`.
`script-src blob:` and general `unsafe-eval` are unnecessary. Keep existing other
CSP directives. The ORT transitive package is a pinned dev release; changing it
requires re-reviewing pins and rerunning real inference.

## Verification

```sh
node --test tests/voice-*.test.mjs
PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python \
  tests/voice-capture.browser.py \
  --models-root /tmp/opencode/orbit-voice-models \
  --audio-file /tmp/opencode/orbit-voice-jfk.wav
```

The browser test requires an explicitly provided real speech WAV and provisioned
models; absent prerequisites report **UNRUN**, exit 2. The fixture uses its own
temporary Vite server, source copy, host page and real asset factory; it does not
boot an owner workspace, create terminals or contact an inference provider.

For the reviewed public US-government JFK speech fixture, explicitly download
`https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav`
into disposable scratch. Observed SHA-256:
`aa81c2552465568567e670f3823117e633900d16bd6202346a72f3c8464c74c8`.
It is 11 seconds, stereo PCM 44.1 kHz; no audio/model bytes are committed here.
The browser test also creates a 33-second repetition locally for multi-section
recognition and uses the original WAV as Chromium's fake microphone source.

Measured in headless Chromium on this implementation host (2026-09-30), a real
11-second transcription took **1.874 s cold decode/load/infer** and **0.729 s warm**;
model inference alone was **0.43 s cold / 0.40 s warm**. The 33-second multi-section
fixture required **1.64 s of model inference**. These are fixture samples,
not a median/SLA or measurements on the owner's hardware. The recognized text was:

> And so, my fellow Americans, ask not what your country can do for you, ask what
> you can do for your country.

Tests assert the real CPU WASM URL/MIME, no cross-origin isolation, zero external
requests under WASM-only CSP, editable chosen-draft insertion, no API/model send,
real MediaRecorder track cleanup, late permission cleanup, missing-model retention
and worker disposal. Idle cleanup uses the real worker with an accelerated test
clock and asserts the production schedule is 60,000 ms. Late-result races use
mocked workers **in addition to**, not instead of, real inference. No heap/RSS
memory-release measurement or full 300-second recognition benchmark is claimed.

Focused voice TypeScript and Node checks pass. The parent owns the integrated
build, shared dependency/CSP/route wiring, full check and source-archive exclusions.
