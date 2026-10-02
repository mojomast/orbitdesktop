import { pipeline, env } from '@huggingface/transformers';
import { resampleToMono16k, VOICE_MAX_BYTES } from './voice-audio';

const MODEL = 'onnx-community/moonshine-tiny-ONNX';
const REVISION = 'a6da1241cd305dcd64eab1edbd615f2bb9aabb95';
const ORT = '/vendor/voice/ort/1.31.0-dev.20260914-8d85527a0/';
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/vendor/voice/models/';
env.useBrowserCache = false;
// 4.3.0's WASM cache blob-imports the factory; direct self-hosted imports work
// under script-src 'self' 'wasm-unsafe-eval' without script-src blob:.
env.useWasmCache = false;
env.backends.onnx.wasm!.numThreads = 1;
env.backends.onnx.wasm!.proxy = false;
env.backends.onnx.wasm!.wasmPaths = { mjs: ORT + 'ort-wasm-simd-threaded.mjs', wasm: ORT + 'ort-wasm-simd-threaded.wasm' };
// Transformers local paths omit revisions. Rewrite only our finite local prefix
// to the pinned asset route; reject every other network destination.
const fetchLocal = globalThis.fetch.bind(globalThis);
env.fetch = globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, self.location.origin);
  const prefix = `/vendor/voice/models/${MODEL}/`;
  if (url.origin !== self.location.origin || !(url.pathname.startsWith(prefix) || url.pathname.startsWith(ORT))) return Promise.reject(new Error('Voice worker denied non-local asset'));
  if (url.pathname.startsWith(prefix) && !url.pathname.startsWith(prefix + 'resolve/')) url.pathname = prefix + `resolve/${REVISION}/` + url.pathname.slice(prefix.length);
  return fetchLocal(url, init);
};
let busy = false;
let transcriber: Awaited<ReturnType<typeof pipeline<'automatic-speech-recognition'>>> | undefined;
self.onmessage = async (event: MessageEvent) => {
  const { id, pcm, sampleRate } = event.data;
  if (event.data.type !== 'transcribe' || busy) return;
  if (!(pcm instanceof Float32Array) || !pcm.length || pcm.byteLength > VOICE_MAX_BYTES || !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || pcm.length / sampleRate > 300 || pcm.some(x => !Number.isFinite(x))) {
    self.postMessage({ type: 'error', id, code: 'input_too_large', message: 'Invalid or oversized PCM' }); return;
  }
  busy = true;
  let stage = 'load';
  try {
    self.postMessage({ type: 'progress', id, stage: 'resample', message: 'Resampling to mono 16 kHz in local worker…' });
    const mono16k = resampleToMono16k(pcm, sampleRate);
    if (!transcriber) {
      self.postMessage({ type: 'progress', id, stage: 'load', message: 'Loading local model and compiling WASM…' });
      transcriber = await pipeline('automatic-speech-recognition', MODEL, {
        dtype: 'q8', device: 'wasm', local_files_only: true,
        progress_callback: info => self.postMessage({ type: 'progress', id, stage: 'load', message: `${info.status}${'file' in info ? ': ' + info.file : ''}` }),
      });
    }
    stage = 'infer';
    self.postMessage({ type: 'progress', id, stage, message: 'Transcribing on device…' });
    const start = performance.now();
    // Moonshine's pipeline does not implement chunk_length_s. Bound individual
    // model calls explicitly rather than feeding five minutes to one encoder.
    const chunkSamples = 30 * 16000, parts: string[] = [];
    for (let offset = 0; offset < mono16k.length; offset += chunkSamples) {
      self.postMessage({ type: 'progress', id, stage, message: `Transcribing on device: section ${Math.floor(offset / chunkSamples) + 1}/${Math.ceil(mono16k.length / chunkSamples)}…` });
      const output = await transcriber(mono16k.subarray(offset, Math.min(mono16k.length, offset + chunkSamples)));
      const result = Array.isArray(output) ? output[0] : output;
      parts.push(result.text.trim());
    }
    self.postMessage({ type: 'result', id, text: parts.filter(Boolean).join(' '), model: MODEL, revision: REVISION, backend: 'wasm', numThreads: 1, durationMs: mono16k.length / 16, inferMs: performance.now() - start });
  } catch (error) {
    self.postMessage({ type: 'error', id, code: stage === 'load' ? 'load_failed' : 'infer_failed', message: error instanceof Error ? error.message : String(error) });
  } finally { busy = false; }
};
