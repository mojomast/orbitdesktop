import { requestConversationContext } from './conversation-transfer';
import { mixAudioToMono, VOICE_MAX_BYTES, VOICE_MAX_SECONDS } from './voice-audio';
import './voice-capture.css';
export { resampleToMono16k } from './voice-audio';

export interface VoiceCaptureOptions { paneId?: string; maxSeconds?: number; }
const REVISION = 'a6da1241cd305dcd64eab1edbd615f2bb9aabb95';
const MODEL_PREFIX = `/vendor/voice/models/onnx-community/moonshine-tiny-ONNX/resolve/${REVISION}/`;
const REQUIRED = ['config.json', 'preprocessor_config.json', 'generation_config.json', 'tokenizer_config.json', 'special_tokens_map.json', 'tokenizer.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'];

/** Reviewed host-only surface. The token is never passed to a worker or URL. */
export function mountVoiceCapture(host: HTMLElement, _token: () => string, options: VoiceCaptureOptions = {}): { dispose(): void } {
  const maxSeconds = Math.min(VOICE_MAX_SECONDS, Math.max(1, Number.isFinite(options.maxSeconds) ? options.maxSeconds! : VOICE_MAX_SECONDS));
  const root = document.createElement('section'); root.className = 'voice-capture';
  root.innerHTML = `<h2>Voice transcript</h2>
    <p>Local audio → Moonshine Tiny int8 → editable draft. English speech; review recognition errors. Long clips use 30-second sections; check words at section boundaries.</p>
    <p class="voice-model-status" role="status">Model not checked. Provision local weights before transcription.</p>
    <button type="button" class="voice-check">Check local model</button>
    <details><summary>Model provisioning</summary><p>Run explicitly on the Orbit host (public MIT weights, ~32 MB):</p><code>node scripts/provision_voice_models.mjs --models-root &lt;configured-model-directory&gt;</code><p>Use ORBIT_VOICE_MODELS_ROOT when configured; otherwise use the models directory inside ORBIT_RUNTIME_DIR (default .runtime/models).</p><p>The browser and server never download remote models. Transformers 4.3.0; single-thread WASM. Model revision ${REVISION}.</p></details>
    <div class="voice-controls"><button type="button" class="voice-hold">Hold to record</button><button type="button" class="voice-record">Start recording</button><button type="button" class="voice-stop" disabled>Stop recording</button><button type="button" class="voice-cancel">Cancel</button></div>
    <label>Audio file (local only)<input class="voice-file" type="file" accept="audio/*"></label>
    <p class="voice-status" role="status" aria-live="polite">Ready. Maximum ${maxSeconds} seconds / 30 MiB encoded or decoded audio.</p>
    <label>Editable transcript<textarea class="voice-transcript" rows="8" placeholder="Your transcript appears here. You can also paste and edit text."></textarea></label>
    <p class="voice-provenance">No audio or transcript is saved by this surface.</p>
    <button type="button" class="voice-insert" disabled>Choose draft…</button>`;
  host.append(root);
  const get = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const status = get('.voice-status'), modelStatus = get('.voice-model-status'), provenance = get('.voice-provenance');
  const transcript = get<HTMLTextAreaElement>('.voice-transcript');
  const record = get<HTMLButtonElement>('.voice-record'), hold = get<HTMLButtonElement>('.voice-hold'), stop = get<HTMLButtonElement>('.voice-stop');
  const insert = get<HTMLButtonElement>('.voice-insert'), file = get<HTMLInputElement>('.voice-file');
  let disposed = false, generation = 0, worker: Worker | undefined, requestId = 0;
  let stream: MediaStream | undefined, recorder: MediaRecorder | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined, pendingMic = false, busy = false;
  let controller: AbortController | undefined, audioContext: AudioContext | undefined;
  let source = 'Edited text in voice surface';
  let transcriptSource = source;
  const live = (g: number) => !disposed && generation === g;
  function controls() { record.disabled = file.disabled = busy || pendingMic || !!recorder; hold.disabled = busy; stop.disabled = !recorder && !pendingMic; insert.disabled = !transcript.value.trim(); }
  function terminateWorker() { clearTimeout(idle); worker?.terminate(); worker = undefined; }
  function releaseMic() {
    clearInterval(timer); timer = undefined;
    stream?.getTracks().forEach(track => track.stop()); stream = undefined;
    const old = recorder; recorder = undefined;
    if (old) { old.ondataavailable = null; old.onstop = null; old.onerror = null; if (old.state !== 'inactive') old.stop(); }
  }
  function cancel(message = 'Cancelled. Your edited transcript is retained.', stopWorker = true) {
    root.classList.remove('is-recording');
    generation++; controller?.abort(); controller = undefined;
    releaseMic(); pendingMic = false; busy = false; if (stopWorker) terminateWorker();
    void audioContext?.close().catch(() => {}); audioContext = undefined;
    if (!disposed) { status.textContent = message; controls(); }
  }
  async function checkModel(g = generation): Promise<boolean> {
    controller?.abort(); const abort = new AbortController(); controller = abort;
    modelStatus.textContent = 'Checking local pinned model files…';
    try {
      const responses = await Promise.all(REQUIRED.map(name => fetch(MODEL_PREFIX + name, { method: 'HEAD', signal: abort.signal })));
      if (!live(g)) return false;
      const available = responses.every(response => response.ok);
      modelStatus.textContent = available ? 'Local model verified by asset server: Moonshine Tiny q8 (MIT).' : 'model_missing or invalid: provision/re-verify local weights using the command below.';
      return available;
    } catch (e) {
      if (live(g)) modelStatus.textContent = `Local model check failed: ${e instanceof Error ? e.message : String(e)}`;
      return false;
    } finally { if (controller === abort) controller = undefined; }
  }
  async function transcribe(blob: Blob, g: number) {
    if (!live(g)) return;
    busy = true; controls(); status.textContent = 'Decoding audio locally…';
    try {
      if (!blob.size || blob.size > VOICE_MAX_BYTES) throw new Error('Audio file exceeds byte limit or is empty');
      const context = new AudioContext(); audioContext = context;
      let pcm: Float32Array, sampleRate: number;
      try {
        const audio = await context.decodeAudioData(await blob.arrayBuffer());
        sampleRate = audio.sampleRate; pcm = mixAudioToMono(audio, maxSeconds);
      }
      finally { await context.close().catch(() => {}); if (audioContext === context) audioContext = undefined; }
      if (!live(g)) return;
      if (!await checkModel(g)) { if (live(g)) { busy = false; controls(); status.textContent = 'model_missing: local model unavailable. See provisioning instructions.'; } return; }
      if (!live(g)) return;
      clearTimeout(idle);
      if (!worker) worker = new Worker(new URL('./voice-transcribe.worker.ts', import.meta.url), { type: 'module' });
      const activeWorker = worker, id = ++requestId;
      activeWorker.onmessage = event => {
        if (!live(g) || worker !== activeWorker || event.data.id !== id) return;
        const data = event.data;
        if (data.type === 'progress') { status.textContent = data.message; return; }
        busy = false;
        if (data.type === 'result') {
          transcript.value = data.text;
          transcriptSource = `${source}; on-device Moonshine Tiny q8 transcript`;
          status.textContent = data.text ? 'Ready for review. Choose a draft to insert; nothing is sent automatically.' : 'no_speech: no transcript returned. Try clearer English speech.';
          provenance.textContent = `${source}; on-device Moonshine Tiny q8 / ${REVISION}; WASM, 1 thread; audio ${(data.durationMs / 1000).toFixed(2)} s; inference ${(data.inferMs / 1000).toFixed(2)} s.`;
          idle = setTimeout(terminateWorker, 60000);
        } else { status.textContent = `${data.code}: ${data.message}`; terminateWorker(); }
        controls();
      };
      activeWorker.onerror = event => { if (live(g) && worker === activeWorker) { busy = false; status.textContent = `load_failed: ${event.message}`; terminateWorker(); controls(); } };
      activeWorker.postMessage({ type: 'transcribe', id, pcm, sampleRate }, [pcm.buffer]);
    } catch (e) { if (live(g)) { busy = false; status.textContent = `Audio/transcription failed: ${e instanceof Error ? e.message : String(e)}`; terminateWorker(); controls(); } }
  }
  async function startRecording() {
    if (disposed || pendingMic || recorder || busy) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { status.textContent = 'Microphone capture unavailable. Use an audio file; microphone needs HTTPS or localhost.'; return; }
    cancel('Requesting microphone permission…', false); const g = generation;
    pendingMic = true; controls();
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!live(g)) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired; pendingMic = false;
      const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(value => MediaRecorder.isTypeSupported(value));
      const recording = new MediaRecorder(acquired, mime ? { mimeType: mime } : undefined);
      recorder = recording; const chunks: Blob[] = []; let bytes = 0;
      recording.ondataavailable = event => {
        if (!live(g)) return;
        bytes += event.data.size;
        if (bytes > VOICE_MAX_BYTES) { cancel('Recording exceeded the 30 MiB byte limit.'); return; }
        chunks.push(event.data);
      };
      recording.onerror = () => { if (live(g)) cancel('Microphone recorder failed. Try an audio file.'); };
      recording.onstop = () => {
        if (!live(g)) return;
        clearInterval(timer); stream?.getTracks().forEach(track => track.stop()); stream = undefined; recorder = undefined;
        source = 'Microphone recording'; void transcribe(new Blob(chunks, { type: recording.mimeType }), g);
      };
      const start = performance.now(); recording.start(250); controls(); root.classList.add('is-recording');
      timer = setInterval(() => {
        const seconds = (performance.now() - start) / 1000;
        status.textContent = `● Recording microphone — ${seconds.toFixed(1)} s / ${maxSeconds} s`;
        if (seconds >= maxSeconds) finishRecording();
      }, 100);
    } catch (e) { if (live(g)) { pendingMic = false; releaseMic(); status.textContent = `Microphone failed: ${e instanceof Error ? e.message : String(e)}`; controls(); } }
  }
  function finishRecording() {
    root.classList.remove('is-recording');
    if (pendingMic) { cancel('Recording cancelled before microphone permission completed.'); return; }
    if (recorder?.state === 'recording') { clearInterval(timer); recorder.stop(); stream?.getTracks().forEach(track => track.stop()); status.textContent = 'Finishing recording…'; }
  }
  const listeners = new AbortController(); const signal = listeners.signal;
  record.addEventListener('click', () => void startRecording(), { signal });
  stop.addEventListener('click', finishRecording, { signal });
  hold.addEventListener('pointerdown', event => { if (event.button !== 0) return; hold.setPointerCapture(event.pointerId); void startRecording(); }, { signal });
  hold.addEventListener('pointerup', finishRecording, { signal });
  hold.addEventListener('pointercancel', () => cancel(), { signal });
  hold.addEventListener('keydown', event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); void startRecording(); } }, { signal });
  hold.addEventListener('keyup', event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); finishRecording(); } }, { signal });
  get('.voice-cancel').addEventListener('click', () => { root.classList.remove('is-recording'); cancel(); }, { signal });
  get('.voice-check').addEventListener('click', () => { if (!busy) void checkModel(); }, { signal });
  file.addEventListener('change', () => {
    const selected = file.files?.[0]; if (!selected) return;
    cancel(undefined, busy); source = 'Audio file'; void transcribe(selected, generation); file.value = '';
  }, { signal });
  transcript.addEventListener('input', controls, { signal });
  insert.addEventListener('click', () => {
    void requestConversationContext({ text: transcript.value, title: 'Voice transcript', source: transcriptSource }).then(result => {
      if (!disposed) status.textContent = result.status === 'delivered' ? 'Inserted into your chosen draft. Review and send there when ready.' : `Draft insertion: ${result.status}. Your transcript is retained.`;
    });
  }, { signal });
  const dispose = () => { if (disposed) return; disposed = true; cancel(); listeners.abort(); root.remove(); };
  window.addEventListener('pagehide', dispose, { signal });
  return { dispose };
}
