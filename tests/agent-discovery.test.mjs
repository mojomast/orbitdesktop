import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverHermesGateway, discoverGrokGateway, discoverAgentBackends, publicBackendSummary, attachProviders } from '../server/agent-discovery.mjs';
import { createAgentProfiles } from '../server/agent-profiles.mjs';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-discover-'));
}

test('Hermes discovery uses the API server bind, key, and model without copying a vendor key', () => {
  const home = tempHome();
  fs.writeFileSync(path.join(home, '.env'), [
    'API_SERVER_ENABLED=true',
    'API_SERVER_HOST=100.120.57.35',
    'API_SERVER_PORT=8642',
    'API_SERVER_KEY=gateway-key-not-for-logs',
    'OPENAI_API_KEY=vendor-secret',
  ].join('\n'));
  fs.writeFileSync(path.join(home, 'config.yaml'), [
    'model:',
    '  default: deepseek-v4.1-flash',
    '  provider: opencode-go',
  ].join('\n'));
  const found = discoverHermesGateway({ env: {}, home });
  assert.equal(found.apiUrl, 'http://100.120.57.35:8642');
  assert.equal(found.apiKey, 'gateway-key-not-for-logs');
  assert.equal(found.model, 'deepseek-v4.1-flash');
  assert.equal(found.modelProvider, 'opencode-go');
  assert.equal(found.label, 'Hermes · deepseek-v4.1-flash');
  assert.equal(found.source, 'hermes-env');
  const summary = publicBackendSummary(found);
  assert.equal(summary.hasKey, true);
  assert.equal(JSON.stringify(summary).includes('gateway-key-not-for-logs'), false);
  assert.equal(JSON.stringify(summary).includes('vendor-secret'), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('disabled Hermes API server and wildcard bind are handled', () => {
  const home = tempHome();
  fs.writeFileSync(path.join(home, '.env'), 'API_SERVER_ENABLED=false\nAPI_SERVER_KEY=secret\n');
  assert.equal(discoverHermesGateway({ env: {}, home }), null);
  fs.writeFileSync(path.join(home, '.env'), 'API_SERVER_ENABLED=true\nAPI_SERVER_HOST=0.0.0.0\nAPI_SERVER_PORT=8642\nAPI_SERVER_KEY=secret\n');
  assert.equal(discoverHermesGateway({ env: {}, home }).apiUrl, 'http://127.0.0.1:8642');
  fs.writeFileSync(path.join(home, '.env'), 'API_SERVER_ENABLED=true\nAPI_SERVER_HOST=127.0.0.1\n');
  assert.equal(discoverHermesGateway({ env: {}, home }), null);
  fs.rmSync(home, { recursive: true, force: true });
});

test('explicit Hermes environment skips discovery and still looks for Grok Bot', () => {
  const home = tempHome();
  fs.writeFileSync(path.join(home, '.env'), 'API_SERVER_KEY=secret\nAPI_SERVER_HOST=100.120.57.35\nAPI_SERVER_PORT=8642\n');
  const found = discoverAgentBackends({ env: { HERMES_API_URL: 'http://127.0.0.1:8642' }, home });
  assert.equal(found.hermes, null);
  assert.equal(found.grok, null);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Grok gateway.json rewrites a wildcard bind and keeps the token off the public summary', () => {
  const root = tempHome();
  fs.writeFileSync(path.join(root, 'gateway.json'), JSON.stringify({ port: 1340, host: '0.0.0.0', scheme: 'http', token: 'grok-gateway-token' }));
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ agentDefaultModel: { modelId: 'grok-4' } }));
  const found = discoverGrokGateway({ env: { GROK_BOT_AGENT_DATA_DIR: root }, home: tempHome() });
  assert.equal(found.apiUrl, 'http://127.0.0.1:1340');
  assert.equal(found.id, 'grok');
  assert.equal(found.provider, 'grok');
  assert.equal(found.model, 'grok-4');
  assert.equal(JSON.stringify(publicBackendSummary(found)).includes('grok-gateway-token'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Grok fallback URL and key work, and a bad URL or missing key does not throw', () => {
  const home = tempHome();
  const found = discoverGrokGateway({ env: { GROK_BOT_API_URL: 'http://127.0.0.1:1340', GROK_BOT_API_KEY: 'fallback-token', GROK_BOT_MODEL: 'grok-4' }, home });
  assert.equal(found.apiUrl, 'http://127.0.0.1:1340');
  assert.equal(found.source, 'environment');
  assert.equal(found.model, 'grok-4');
  assert.equal(discoverGrokGateway({ env: { GROK_BOT_API_URL: 'http://user:pass@127.0.0.1:1340', GROK_BOT_API_KEY: 'fallback-token' }, home }), null);
  assert.equal(discoverGrokGateway({ env: { GROK_BOT_API_URL: 'http://127.0.0.1:1340' }, home }), null);
  fs.rmSync(home, { recursive: true, force: true });
});

test('attachProviders adds Grok beside an unchanged Hermes catalog', () => {
  const catalog = createAgentProfiles({ apiUrl: 'http://127.0.0.1:8642', apiKey: 'hermes-key', profiles: [], profilesJson: undefined });
  const same = attachProviders(catalog, []);
  assert.equal(same, catalog);
  const wrapped = attachProviders(catalog, [{ id: 'grok', label: 'Grok Bot', provider: 'grok', apiUrl: 'http://127.0.0.1:1340', apiKey: 'grok-token', model: 'grok-4' }]);
  assert.deepEqual(wrapped.list, [{ id: 'default', label: 'Default' }, { id: 'grok', label: 'Grok Bot', provider: 'grok' }]);
  assert.equal(wrapped.get('grok').apiUrl, 'http://127.0.0.1:1340');
  assert.equal(wrapped.get('default').apiKey, 'hermes-key');
  assert.equal(wrapped.resolveRun('grok'), null);
  assert.equal(JSON.stringify(wrapped.list).includes('grok-token'), false);
});
