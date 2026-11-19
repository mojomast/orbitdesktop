import './voice-capture.css';
import { el } from './dom';
import { requestConversationContext } from './conversation-transfer';
import {
  MAX_SECONDS,
  MIN_SECONDS,
  SAMPLE_RATE,
  downsample,
  limitDuration,
  mergeChunks,
  rootMeanSquare,
} from './voice-audio';

const TRANSFER_LIMIT = 20000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

type MountOptions = { paneId?: string; surfaceUrl?: string };
type WorkerReply = { id: number; type: 'progress' | 'result' | 'error'; progress?: number; text?: string };

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Dictation is unavailable.';
}

/**
 * Grok Bots dictation. The only entry point is the app's 🎤 button, which opens
 * this ordinary host surface. Capture and transcription stay on this device;
 * the transcript is inserted into an already selected conversation draft and is
 * never sent automatically.
 */
export function mountVoiceCapture(host: HTMLElement, _token: () => string, _options: MountOptions = {}): { dispose(): void } {
  const root = el('section', 'voice-capture');
  root.setAttribute('aria-label', 'Dictation');
  host.replaceChildren(root);

  const title = el('h2', '', 'Dictation');
  const notice = el(
    'p',
    'voice-notice',
    'Speak or choose an audio file. Recognition runs locally with the separately provisioned Moonshine model; audio is not uploaded and there is no remote fallback. Review the text, then insert it into a selected draft.',
  );
  const status = el('p', 'voice-status', 'Checking the local dictation model…');
  status.setAttribute('role', 'status');
  const error = el('p', 'voice-error');
  error.setAttribute('role', 'alert');

  const controls = el('div', 'voice-controls');
  const record = el('button', 'voice-record', 'Start recording');
  record.type = 'button';
  record.setAttribute('aria-pressed', 'false');
  const level = el('div', 'voice-level');
  const levelBar = el('div', 'voice-level-bar');
  level.append(levelBar);
  level.setAttribute('aria-hidden', 'true');

  const fileLabel = el('label', 'voice-file', 'Audio file ');
  const file = el('input', 'voice-file-input');
  file.type = 'file';
  file.accept = 'audio/*,.wav,.mp3,.m4a,.ogg,.webm';
  fileLabel.append(file);
  controls.append(record, level, fileLabel);

  const textLabel = el('label', 'voice-text-label', 'Text');
  const textArea = el('textarea', 'voice-text');
  textArea.rows = 10;
  textArea.maxLength = TRANSFER_LIMIT;
  textArea.placeholder = 'Your words appear here after local recognition. Edit before inserting.';
  textArea.setAttribute('aria-label', 'Dictation text');
  textLabel.append(textArea);

  const actions = el('div', 'voice-actions');
  const insert = el('button', 'voice-insert', 'Insert into selected draft');
  insert.type = 'button';
  const clear = el('button', 'voice-clear', 'Clear');
  clear.type = 'button';
  actions.append(insert, clear);

  root.append(title, notice, status, error, controls, textLabel, actions);

  let disposed = false;
  let recording = false;
  let busy = false;
  let modelReady = false;
  let context: AudioContext | null = null;
  let captureRate = SAMPLE_RATE;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let sink: GainNode | null = null;
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let started = 0;
  let captured = 0;
  let chunks: Float32Array[] = [];
  let worker: Worker | null = null;
  let requestId = 0;
  const pending = new Map<number, { resolve(text: string): void; reject(error: Error): void }>();

  function setStatus(text: string) {
    if (!disposed) status.textContent = text;
  }

  function setError(text: string) {
    if (!disposed) error.textContent = text;
  }

  function updateControls() {
    record.disabled = busy;
    insert.disabled = busy;
    file.disabled = busy;
    record.textContent = recording ? 'Stop recording' : 'Start recording';
    record.setAttribute('aria-pressed', recording ? 'true' : 'false');
  }

  function cleanupCapture() {
    if (timer !== null) clearInterval(timer);
    timer = null;
    try { processor?.disconnect(); } catch { /* already disconnected */ }
    try { source?.disconnect(); } catch { /* already disconnected */ }
    try { sink?.disconnect(); } catch { /* already disconnected */ }
    processor = null;
    source = null;
    sink = null;
    for (const track of stream?.getTracks() ?? []) { try { track.stop(); } catch { /* already stopped */ } }
    stream = null;
    const closing = context;
    context = null;
    if (closing) void closing.close().catch(() => {});
    levelBar.style.width = '0%';
  }

  function rejectPending(reason: string) {
    for (const entry of pending.values()) entry.reject(Error(reason));
    pending.clear();
  }

  function ensureWorker(): Worker {
    if (worker) return worker;
    if (typeof Worker !== 'function') throw Error('Local dictation is unavailable in this window.');
    let created: Worker;
    try {
      created = new Worker(new URL('./voice-transcribe.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      throw Error('Local dictation worker could not start.');
    }
    worker = created;
    created.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (!reply || typeof reply.id !== 'number') return;
      if (reply.type === 'progress') {
        const percent = Math.round(Math.max(0, Math.min(1, reply.progress ?? 0)) * 100);
        setStatus(`Loading the local dictation model… ${percent}%`);
        return;
      }
      const entry = pending.get(reply.id);
      if (!entry) return;
      pending.delete(reply.id);
      if (reply.type === 'result') entry.resolve(reply.text ?? '');
      else entry.reject(Error(reply.text || 'Local dictation failed.'));
    };
    created.onerror = () => {
      created.terminate();
      if (worker === created) worker = null;
      rejectPending('Local dictation worker stopped. Reload this window to try again.');
    };
    return created;
  }

  async function transcribe(samples: Float32Array): Promise<string> {
    const active = ensureWorker();
    const id = ++requestId;
    setStatus('Transcribing on this device…');
    return await new Promise<string>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { active.postMessage({ id, audio: samples }); }
      catch {
        pending.delete(id);
        reject(Error('Audio could not be sent to the local worker.'));
      }
    });
  }

  function appendText(text: string) {
    const value = text.trim();
    if (!value) {
      setError('No words were recognized. Try a longer or clearer recording.');
      return;
    }
    const current = textArea.value;
    const next = current.trim() ? current.replace(/\s+$/, '') + '\n\n' + value : value;
    if (next.length > TRANSFER_LIMIT) {
      setError('The dictation would exceed the 20,000-character transfer limit. Shorten the text first.');
      return;
    }
    textArea.value = next;
    textArea.selectionStart = textArea.selectionEnd = next.length;
    setError('');
    setStatus('Review the text, then insert it into a selected draft.');
  }

  async function stopRecording(cancel: boolean) {
    if (!recording) return;
    recording = false;
    const rate = captureRate;
    const collected = cancel ? new Float32Array(0) : downsample(mergeChunks(chunks), rate);
    chunks = [];
    captured = 0;
    cleanupCapture();
    updateControls();
    if (cancel) {
      setStatus('Recording cancelled. Nothing was transcribed.');
      return;
    }
    if (collected.length < SAMPLE_RATE * MIN_SECONDS) {
      setStatus('Ready.');
      setError('That recording was too short. Hold the button while you speak, then stop.');
      return;
    }
    busy = true;
    updateControls();
    try {
      appendText(await transcribe(collected));
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      busy = false;
      updateControls();
    }
  }

  async function startRecording() {
    if (disposed || recording || busy) return;
    setError('');
    if (!window.isSecureContext) {
      setError('Microphone capture needs a secure Orbit window.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This window cannot open the microphone.');
      return;
    }
    busy = true;
    updateControls();
    try {
      const audio = new AudioContext();
      context = audio;
      captureRate = audio.sampleRate;
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      stream = media;
      if (audio.state === 'suspended') await audio.resume();
      const input = audio.createMediaStreamSource(media);
      source = input;
      const script = audio.createScriptProcessor(4096, 1, 1);
      processor = script;
      const gain = audio.createGain();
      sink = gain;
      gain.gain.value = 0;
      script.onaudioprocess = event => {
        if (!recording || disposed) return;
        const data = event.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(data));
        captured += data.length;
        levelBar.style.width = `${Math.min(100, Math.round(rootMeanSquare(data) * 400))}%`;
        if (captured >= captureRate * MAX_SECONDS) void stopRecording(false);
      };
      input.connect(script);
      script.connect(gain);
      gain.connect(audio.destination);
      started = Date.now();
      recording = true;
      busy = false;
      updateControls();
      setStatus('Recording… 0s (up to 5 minutes).');
      timer = setInterval(() => {
        if (!recording) return;
        const seconds = Math.floor((Date.now() - started) / 1000);
        setStatus(`Recording… ${seconds}s (up to 5 minutes).`);
      }, 250);
    } catch (failure) {
      cleanupCapture();
      recording = false;
      busy = false;
      updateControls();
      setError(messageOf(failure));
      setStatus(modelReady ? 'Ready.' : 'Local dictation model is not provisioned.');
    }
  }

  async function decodeFile(fileValue: File) {
    if (fileValue.size > MAX_FILE_BYTES) throw Error('Choose an audio file smaller than 25 MB.');
    busy = true;
    updateControls();
    setStatus('Reading the audio file on this device…');
    const decoding = new AudioContext();
    try {
      const buffer = await decoding.decodeAudioData(await fileValue.arrayBuffer());
      const mono = new Float32Array(buffer.length);
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
      }
      const samples = limitDuration(downsample(mono, buffer.sampleRate), SAMPLE_RATE, MAX_SECONDS);
      if (samples.length < SAMPLE_RATE * MIN_SECONDS) throw Error('That audio file is too short to transcribe.');
      appendText(await transcribe(samples));
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      await decoding.close().catch(() => {});
      busy = false;
      updateControls();
    }
  }

  async function checkModel() {
    try {
      const response = await fetch('/vendor/voice/config.json', { method: 'HEAD', cache: 'no-store' });
      if (disposed) return;
      modelReady = response.ok;
      setStatus(modelReady
        ? 'Local dictation model is ready. Nothing is uploaded.'
        : 'Local dictation model is not provisioned. Recording opens, but recognition needs the pinned Moonshine assets.');
    } catch {
      if (!disposed) {
        modelReady = false;
        setStatus('Local dictation model status is unknown. Recognition needs the pinned Moonshine assets.');
      }
    }
  }

  record.onclick = () => {
    if (recording) void stopRecording(false);
    else void startRecording();
  };

  file.onchange = () => {
    const selected = file.files?.[0] ?? null;
    file.value = '';
    if (!selected || disposed || busy || recording) return;
    void decodeFile(selected);
  };

  insert.onclick = () => {
    const text = textArea.value.trim();
    if (!text) {
      setError('Record or type some dictation first.');
      return;
    }
    setError('');
    setStatus('Choosing a draft…');
    void requestConversationContext({ title: 'Dictation', source: 'Local dictation', text }).then(outcome => {
      if (disposed) return;
      const messages: Record<string, string> = {
        delivered: 'Added to the selected draft; nothing was sent.',
        cancelled: 'Draft selection was cancelled. The text is still here.',
        'no-recipient': 'Open a conversation pane or Grok Bots window, then choose its draft.',
        empty: 'There is no text to insert.',
        busy: 'Another transfer is open. Finish it before inserting this dictation.',
      };
      setStatus(messages[outcome.status] ?? ('reason' in outcome ? outcome.reason : outcome.status) + '.');
    }).catch(failure => setError(messageOf(failure)));
  };

  clear.onclick = () => {
    if (busy || disposed) return;
    textArea.value = '';
    setError('');
    setStatus(modelReady ? 'Ready.' : 'Local dictation model is not provisioned.');
  };

  updateControls();
  void checkModel();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      recording = false;
      cleanupCapture();
      rejectPending('This dictation window closed.');
      worker?.terminate();
      worker = null;
      chunks = [];
      host.replaceChildren();
    },
  };
}
