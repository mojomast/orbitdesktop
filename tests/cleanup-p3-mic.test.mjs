// Phase 3 follow-up (Kyle, 2:35 PM ET): "Voice: keep the Grok Bots dictation mic".
// The standalone Voice transcript feature stays cut; the Grok Bots chat mic and the local
// (on-device) voice capture it opens come back as a Grok Bots-only path.
// AC-001: Grok Bots has its 🎤 mic again and the host bridge answers its 'voice' op.
// AC-002: the local voice engine and its pinned model asset route are present.
// AC-003: voice is not a standalone Orbit feature (no technology surface, menu, onboarding step, capability or readiness row).
// AC-004: conversation transfers into Grok Bots drafts still work alongside the mic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {FEATURE_CAPABILITIES} from '../contracts/feature-capabilities.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('AC-001 Grok Bots mic and voice bridge op are back', () => {
  const app = read('apps/grokbots/index.html');
  assert.match(app, /id='micbtn'|id="micbtn"|\.id=['"]micbtn['"]/, 'Grok Bots composer must have the mic button');
  assert.match(app, /host\(['"]voice['"]/, 'the mic must ask the host to open voice capture');
  const bridge = read('src/grokbots-bridge.ts');
  assert.match(bridge, /registerGrokBotsOp\(['"]voice['"]/, "bridge must handle the 'voice' op");
  assert.match(bridge, /voice:\s*true/, 'bridge must advertise voice to the app');
});

test('AC-002 the local voice engine and model assets are present', async () => {
  for (const file of ['src/voice-capture.ts','src/voice-audio.ts','src/voice-transcribe.worker.ts','src/voice-capture.css','server/voice-model-assets.mjs','scripts/provision_voice_models.mjs'])
    assert.ok(fs.existsSync(path.join(root, file)), `${file} must exist`);
  assert.match(read('server/technology-assets.mjs'), /voice-model-assets\.mjs/, 'technology assets must serve /vendor/voice/ from the pinned voice asset map');
  const assets = await import('../server/voice-model-assets.mjs');
  assert.equal(typeof assets.createVoiceModelAssets, 'function');
  assert.match(read('src/host-surfaces.ts'), /voice-capture/, "the 'voice' host surface must mount voice capture");
});

test('AC-003 voice is not a standalone Orbit feature', () => {
  const tech = read('src/technology-surfaces.ts');
  assert.ok(!/\bvoice\s*:|case ['"]voice['"]/.test(tech), 'no Voice transcript technology surface');
  for (const file of ['src/main.ts','src/onboarding.ts','server/feature-readiness.mjs','README.md','docs/AGENT_GUIDE.md','examples/plugins/orbit-showcase/app.js'])
    assert.ok(!/Voice transcript|technology-voice|voice-transcript/i.test(read(file)), `${file} must not offer a standalone Voice transcript`);
  assert.deepEqual(FEATURE_CAPABILITIES.map(row => row[0]).filter(id => /voice/.test(id)), []);
});

test('AC-004 conversation transfer into the Grok Bots draft stays', () => {
  const app = read('apps/grokbots/index.html');
  assert.match(app, /gb-host-insert/);
  assert.match(app, /hostSend\(['"]conversation['"]/);
  assert.match(read('src/grokbots-bridge.ts'), /registerConversationRecipient/);
});
