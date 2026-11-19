import test from 'node:test';
import assert from 'node:assert/strict';
import { transform } from 'esbuild';
import { readFile } from 'node:fs/promises';
const { code } = await transform(await readFile(new URL('../src/voice-audio.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const { resampleToMono16k, mixAudioToMono16k } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const tone = (hz, rate, duration = .1) => Float32Array.from({ length: Math.round(rate * duration) }, (_, i) => Math.sin(2 * Math.PI * hz * i / rate));
const energy = samples => Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
test('16 kHz duration and low-pass suppression of aliased high-frequency audio', () => {
  const low = resampleToMono16k(tone(1000, 48000), 48000);
  assert.equal(low.length, 1600);
  assert.ok(energy(low) > .69 && energy(low) < .72);
  assert.ok(energy(resampleToMono16k(tone(12000, 48000), 48000).slice(50, -50)) < .01);
});
test('mixdown, invalid rates, finite PCM, duration and decoded-byte bounds', () => {
  const samples = tone(1000, 16000);
  const audio = { duration: .1, length: samples.length, sampleRate: 16000, numberOfChannels: 2, getChannelData: c => c === 0 ? samples : samples.map(x => -x) };
  assert.equal(energy(mixAudioToMono16k(audio)), 0);
  assert.throws(() => resampleToMono16k(samples, NaN), /Invalid/);
  assert.throws(() => resampleToMono16k(new Float32Array([NaN]), 16000), /Invalid/);
  assert.throws(() => mixAudioToMono16k({ ...audio, duration: 301 }), /limit/);
  assert.throws(() => mixAudioToMono16k({ ...audio, length: 4000000, numberOfChannels: 3 }), /limit/);
});
