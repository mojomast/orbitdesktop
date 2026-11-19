// Small, dependency-free audio helpers shared by the dictation surface and its
// unit tests. Capture itself is browser-only, but sample conversion, duration
// limits and WAV encoding are ordinary data operations. Nothing here contacts
// the network or stores audio.
export const SAMPLE_RATE = 16000;
export const MAX_SECONDS = 300;
export const MAX_SAMPLES = SAMPLE_RATE * MAX_SECONDS;
/** A dictation clip shorter than this is treated as an accidental tap. */
export const MIN_SECONDS = 0.2;

function positiveRate(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw Error('Invalid sample rate.');
  return value;
}

/** Concatenate capture buffers without retaining the source arrays. */
export function mergeChunks(chunks: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/** Keep at most maxSeconds of audio, preserving the beginning of the clip. */
export function limitDuration(samples: Float32Array, sampleRate = SAMPLE_RATE, maxSeconds = MAX_SECONDS): Float32Array {
  const rate = positiveRate(sampleRate);
  const limit = Math.max(0, Math.floor(rate * Math.max(0, maxSeconds)));
  return samples.length <= limit ? samples : samples.subarray(0, limit);
}

/**
 * Convert mono float samples to the model's rate. Downsampling averages each
 * source window (a cheap anti-alias) so a 48 kHz microphone is not undersampled
 * by simple decimation. Upsampling is linear and only needed for odd devices.
 */
export function downsample(samples: Float32Array, inputRate: number, outputRate = SAMPLE_RATE): Float32Array {
  const from = positiveRate(inputRate);
  const to = positiveRate(outputRate);
  if (samples.length === 0) return new Float32Array(0);
  if (from === to) return new Float32Array(samples);
  if (from > to) {
    const ratio = from / to;
    const length = Math.max(1, Math.floor(samples.length / ratio));
    const output = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let total = 0;
      for (let j = start; j < end; j++) total += samples[j];
      output[i] = total / (end - start);
    }
    return output;
  }
  const scale = from / to;
  const length = Math.max(1, Math.round(samples.length / scale));
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * scale;
    const left = Math.min(samples.length - 1, Math.floor(position));
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = position - left;
    output[i] = samples[left] + (samples[right] - samples[left]) * fraction;
  }
  return output;
}

/** Root mean square amplitude, used only for a local input-level meter. */
export function rootMeanSquare(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (const sample of samples) total += sample * sample;
  return Math.sqrt(total / samples.length);
}

export function peakAmplitude(samples: Float32Array): number {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

export function floatToPcm16(samples: Float32Array): Int16Array {
  const output = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    output[i] = value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff);
  }
  return output;
}

export function pcm16ToFloat(samples: Int16Array): Float32Array {
  const output = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) output[i] = samples[i] / 0x8000;
  return output;
}

const WAV_HEADER_BYTES = 44;

/** Encode mono 16-bit PCM WAV bytes. Used only for an explicit owner download. */
export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const rate = Math.round(positiveRate(sampleRate));
  const pcm = floatToPcm16(samples);
  const bytes = new Uint8Array(WAV_HEADER_BYTES + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(WAV_HEADER_BYTES + i * 2, pcm[i], true);
  return bytes;
}

/** Decode a mono or stereo 16-bit PCM WAV produced by encodeWav or a recorder. */
export function decodeWav(bytes: Uint8Array): { sampleRate: number; samples: Float32Array } {
  if (bytes.length < WAV_HEADER_BYTES) throw Error('Not a WAV file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (text(0) !== 'RIFF' || text(8) !== 'WAVE') throw Error('Not a WAV file.');
  let offset = 12;
  let format = 0;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let data: Float32Array | null = null;
  while (offset + 8 <= bytes.length) {
    const id = text(offset);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + size > bytes.length) throw Error('Truncated WAV file.');
    if (id === 'fmt ' && size >= 16) {
      format = view.getUint16(start, true);
      channels = view.getUint16(start + 2, true);
      rate = view.getUint32(start + 4, true);
      bits = view.getUint16(start + 14, true);
    } else if (id === 'data') {
      if (format !== 1 || bits !== 16 || (channels !== 1 && channels !== 2)) throw Error('Unsupported WAV encoding.');
      const frames = Math.floor(size / (channels * 2));
      const samples = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame++) {
        let total = 0;
        for (let channel = 0; channel < channels; channel++) total += view.getInt16(start + (frame * channels + channel) * 2, true);
        samples[frame] = total / channels / 0x8000;
      }
      data = samples;
    }
    offset = start + size + (size % 2);
  }
  if (!data || !rate) throw Error('WAV file has no audio data.');
  return { sampleRate: rate, samples: data };
}
