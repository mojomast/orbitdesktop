export const VOICE_MAX_SECONDS = 300;
export const VOICE_MAX_BYTES = 30 * 1024 * 1024;

/** Windowed-sinc low-pass resampling avoids aliasing when downsampling microphone PCM. */
export function resampleToMono16k(input: Float32Array, inputRate: number): Float32Array {
  if (!Number.isFinite(inputRate) || inputRate < 8000 || inputRate > 192000 || !input.length) throw new Error('Invalid audio sample rate or empty audio');
  if (input.length / inputRate > VOICE_MAX_SECONDS || input.byteLength > VOICE_MAX_BYTES) throw new Error('Audio exceeds duration/decoded-byte limit');
  if (input.some(value => !Number.isFinite(value))) throw new Error('Invalid PCM audio');
  if (inputRate === 16000) return input.slice();
  const ratio = inputRate / 16000;
  const cutoff = Math.min(1, 1 / ratio);
  const radius = Math.ceil(16 / cutoff);
  const result = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < result.length; i++) {
    const position = i * ratio;
    let total = 0, weight = 0;
    for (let j = Math.max(0, Math.ceil(position - radius)); j <= Math.min(input.length - 1, Math.floor(position + radius)); j++) {
      const distance = j - position;
      const x = distance * cutoff;
      const w = (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * (0.5 + 0.5 * Math.cos(Math.PI * distance / radius));
      total += input[j] * w; weight += w;
    }
    result[i] = total / weight;
  }
  return result;
}

export function mixAudioToMono(audio: AudioBuffer, maxSeconds = VOICE_MAX_SECONDS): Float32Array {
  if (audio.duration > maxSeconds || audio.length * audio.numberOfChannels * 4 > VOICE_MAX_BYTES) throw new Error('Audio exceeds duration/decoded-byte limit');
  const mono = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const channel = audio.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / audio.numberOfChannels;
  }
  return mono;
}

export function mixAudioToMono16k(audio: AudioBuffer, maxSeconds = VOICE_MAX_SECONDS): Float32Array {
  return resampleToMono16k(mixAudioToMono(audio, maxSeconds), audio.sampleRate);
}
