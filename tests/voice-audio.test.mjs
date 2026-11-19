import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SAMPLE_RATE,
  downsample,
  encodeWav,
  decodeWav,
  floatToPcm16,
  pcm16ToFloat,
  mergeChunks,
  limitDuration,
  rootMeanSquare,
  peakAmplitude,
} from '../src/voice-audio.ts';

const tone = (length, value = 0.25) => new Float32Array(length).fill(value);

test('mergeChunks concatenates in capture order without sharing storage', () => {
  const first = new Float32Array([0.1, 0.2]);
  const second = new Float32Array([-0.3]);
  const merged = mergeChunks([first, second]);
  assert.deepEqual([...merged], [0.1, 0.2, -0.3].map(value => Math.fround(value)));
  first[0] = 9;
  assert.ok(Math.abs(merged[0] - 0.1) < 1e-6);
  assert.equal(mergeChunks([]).length, 0);
});

test('downsample converts common microphone rates to 16 kHz and keeps a constant tone', () => {
  const input = tone(48000);
  const output = downsample(input, 48000, SAMPLE_RATE);
  assert.equal(output.length, 16000);
  for (const sample of output) assert.ok(Math.abs(sample - 0.25) < 1e-6);
  const same = downsample(input, 48000, 48000);
  assert.notEqual(same, input);
  assert.equal(same.length, input.length);
  assert.equal(downsample(new Float32Array(0), 48000).length, 0);
});

test('downsample rejects invalid sample rates', () => {
  assert.throws(() => downsample(tone(8), 0), /Invalid sample rate/);
  assert.throws(() => downsample(tone(8), 48000, Number.NaN), /Invalid sample rate/);
});

test('limitDuration keeps only the beginning of an overlong clip', () => {
  const input = tone(SAMPLE_RATE * 3);
  const limited = limitDuration(input, SAMPLE_RATE, 1);
  assert.equal(limited.length, SAMPLE_RATE);
  assert.equal(limitDuration(input, SAMPLE_RATE, 10).length, input.length);
});

test('level helpers measure the same local input signal', () => {
  const samples = new Float32Array([0.5, -0.5, 0.5, -0.5]);
  assert.ok(Math.abs(rootMeanSquare(samples) - 0.5) < 1e-6);
  assert.equal(peakAmplitude(samples), 0.5);
  assert.equal(rootMeanSquare(new Float32Array(0)), 0);
});

test('16-bit PCM conversion clamps and round-trips within one step', () => {
  const samples = new Float32Array([-2, -0.5, 0, 0.5, 2]);
  const pcm = floatToPcm16(samples);
  assert.deepEqual([...pcm], [-32768, -16384, 0, 16384, 32767]);
  const roundTrip = pcm16ToFloat(pcm);
  for (let i = 0; i < samples.length; i++) {
    const expected = Math.max(-1, Math.min(1, samples[i]));
    assert.ok(Math.abs(roundTrip[i] - expected) <= 1 / 32768 + 1e-9);
  }
});

test('WAV encoding has a mono 16-bit header and decodes back to the samples', () => {
  const samples = new Float32Array(SAMPLE_RATE).fill(0.25);
  const wav = encodeWav(samples);
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...wav.subarray(8, 12)), 'WAVE');
  assert.equal(String.fromCharCode(...wav.subarray(36, 40)), 'data');
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), SAMPLE_RATE);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), samples.length * 2);
  const decoded = decodeWav(wav);
  assert.equal(decoded.sampleRate, SAMPLE_RATE);
  assert.equal(decoded.samples.length, samples.length);
  assert.ok(Math.abs(decoded.samples[0] - 0.25) < 1e-4);
  assert.throws(() => decodeWav(new Uint8Array(10)), /Not a WAV file/);
});
