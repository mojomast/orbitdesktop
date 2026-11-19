// Local dictation worker. The model is fetched only from this Orbit origin's
// pinned /vendor/voice/ allowlist; remote model hosts are disabled, there is no
// remote inference fallback, and audio never leaves the page.
import { env, pipeline } from '@huggingface/transformers';

const MODEL_PATH = 'voice';

type Transcriber = (audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text?: string } | Array<{ text?: string }>>;
type Request = { id: number; audio: Float32Array };
type Reply = { id: number; type: 'progress' | 'result' | 'error'; progress?: number; text?: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: Reply): void;
};

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/vendor/';
env.useBrowserCache = false;

let transcriber: Promise<Transcriber> | null = null;
let queue: Promise<void> = Promise.resolve();

function create( id: number): Promise<Transcriber> {
  transcriber ??= (pipeline as unknown as (
    task: string,
    model: string,
    options: Record<string, unknown>,
  ) => Promise<Transcriber>)('automatic-speech-recognition', MODEL_PATH, {
    device: 'wasm',
    progress_callback: (info: { status?: string; progress?: number }) => {
      if (info && info.status === 'progress' && typeof info.progress === 'number') {
        scope.postMessage({ id, type: 'progress', progress: Math.max(0, Math.min(1, info.progress / 100)) });
      }
    },
  }).catch(error => {
    transcriber = null;
    throw error;
  });
  return transcriber;
}

async function transcribe({ id, audio }: Request) {
  try {
    if (!(audio instanceof Float32Array) || audio.length === 0) throw Error('empty');
    const model = await create(id);
    const output = await model(audio, { sampling_rate: 16000, language: 'en', task: 'transcribe' });
    const text = Array.isArray(output) ? output.map(part => part.text ?? '').join(' ') : output.text ?? '';
    scope.postMessage({ id, type: 'result', text: String(text).trim() });
  } catch {
    scope.postMessage({ id, type: 'error', text: 'Local dictation model is unavailable. Provision the pinned Moonshine assets and try again.' });
  }
}

scope.onmessage = event => {
  const request = event.data;
  if (!request || typeof request !== 'object' || typeof request.id !== 'number') return;
  queue = queue.then(() => transcribe(request)).catch(() => {});
};
