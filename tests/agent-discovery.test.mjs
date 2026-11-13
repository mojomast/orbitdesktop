import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverHermesGateway, discoverGrokGateway, discoverAgentBackends, publicBackendSummary, attachProviders } from '../server/agent-discovery.mjs';
import { createAgentProfiles } from '../server/agent-profiles.mjs';

/**
 * Every test owns an isolated sandbox: a temp HOME, a temp config root and an
 * explicit env. The injected reader answers only inside that sandbox and
 * denies everything else, so discovery can never consult the host's real
 * Hermes or Grok Bot configuration (tests 3 and 5 used to fail on any machine
 * that had a gateway config at a well-known host path).
 */
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-discover-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  return {
    root,
    home,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function inside(root, file) {
  const resolved = path.resolve(file);
  return resolved === path.resolve(root) || resolved.startsWith(`${path.resolve(root)}${path.sep}`);
}

/** A reader confined to `root`; host paths are denied instead of read. */
function confinedReader(root) {
  const asked = [];
  return {
    asked,
    readFile(file) {
      asked.push(path.resolve(file));
      if (!inside(root, file)) return null;
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

const NO_PI = () => false;

test('Hermes discovery uses the API server bind, key, and model without copying a vendor key', () => {
  const box = sandbox();
  try {
    fs.writeFileSync(path.join(box.home, '.env'), [
      'API_SERVER_ENABLED=true',
      'API_SERVER_HOST=198.51.100.10',
      'API_SERVER_PORT=8642',
      'API_SERVER_KEY=gateway-key-not-for-logs',
      'OPENAI_API_KEY=vendor-secret',
    ].join('\n'));
    fs.writeFileSync(path.join(box.home, 'config.yaml'), [
      'model:',
      '  default: deepseek-v4.1-flash',
      '  provider: opencode-go',
    ].join('\n'));
    const found = discoverHermesGateway({ env: {}, home: box.home, readFile: confinedReader(box.root).readFile });
    assert.equal(found.apiUrl, 'http://198.51.100.10:8642');
    assert.equal(found.apiKey, 'gateway-key-not-for-logs');
    assert.equal(found.model, 'deepseek-v4.1-flash');
    assert.equal(found.modelProvider, 'opencode-go');
    assert.equal(found.label, 'Hermes · deepseek-v4.1-flash');
    assert.equal(found.source, 'hermes-env');
    const summary = publicBackendSummary(found);
    assert.equal(summary.hasKey, true);
    assert.equal(JSON.stringify(summary).includes('gateway-key-not-for-logs'), false);
    assert.equal(JSON.stringify(summary).includes('vendor-secret'), false);
  } finally {
    box.cleanup();
  }
});

test('disabled Hermes API server and wildcard bind are handled', () => {
  const box = sandbox();
  try {
    const readFile = confinedReader(box.root).readFile;
    const envFile = path.join(box.home, '.env');
    fs.writeFileSync(envFile, 'API_SERVER_ENABLED=false\nAPI_SERVER_KEY=secret\n');
    assert.equal(discoverHermesGateway({ env: {}, home: box.home, readFile }), null);
    fs.writeFileSync(envFile, 'API_SERVER_ENABLED=true\nAPI_SERVER_HOST=0.0.0.0\nAPI_SERVER_PORT=8642\nAPI_SERVER_KEY=secret\n');
    assert.equal(discoverHermesGateway({ env: {}, home: box.home, readFile }).apiUrl, 'http://127.0.0.1:8642');
    fs.writeFileSync(envFile, 'API_SERVER_ENABLED=true\nAPI_SERVER_HOST=127.0.0.1\n');
    assert.equal(discoverHermesGateway({ env: {}, home: box.home, readFile }), null);
  } finally {
    box.cleanup();
  }
});

test('explicit Hermes environment skips discovery and still looks for Grok Bot', () => {
  const box = sandbox();
  try {
    fs.writeFileSync(path.join(box.home, '.env'), 'API_SERVER_KEY=secret\nAPI_SERVER_HOST=198.51.100.10\nAPI_SERVER_PORT=8642\n');
    const found = discoverAgentBackends({
      env: { HERMES_API_URL: 'http://127.0.0.1:8642' },
      home: box.home,
      readFile: confinedReader(box.root).readFile,
      isExecutable: NO_PI,
    });
    assert.equal(found.hermes, null);
    assert.equal(found.grok, null);
    assert.equal(found.pi, null);
  } finally {
    box.cleanup();
  }
});

test('Grok gateway.json rewrites a wildcard bind and keeps the token off the public summary', () => {
  const box = sandbox();
  try {
    const root = path.join(box.root, 'grok');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'gateway.json'), JSON.stringify({ port: 1340, host: '0.0.0.0', scheme: 'http', token: 'grok-gateway-token' }));
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ agentDefaultModel: { modelId: 'grok-4' } }));
    const found = discoverGrokGateway({
      env: { GROK_BOT_AGENT_DATA_DIR: root },
      home: box.home,
      readFile: confinedReader(box.root).readFile,
    });
    assert.equal(found.apiUrl, 'http://127.0.0.1:1340');
    assert.equal(found.id, 'grok');
    assert.equal(found.provider, 'grok');
    assert.equal(found.model, 'grok-4');
    assert.equal(JSON.stringify(publicBackendSummary(found)).includes('grok-gateway-token'), false);
  } finally {
    box.cleanup();
  }
});

test('Grok fallback URL and key work, and a bad URL or missing key does not throw', () => {
  const box = sandbox();
  try {
    const readFile = confinedReader(box.root).readFile;
    const found = discoverGrokGateway({ env: { GROK_BOT_API_URL: 'http://127.0.0.1:1340', GROK_BOT_API_KEY: 'fallback-token', GROK_BOT_MODEL: 'grok-4' }, home: box.home, readFile });
    assert.equal(found.apiUrl, 'http://127.0.0.1:1340');
    assert.equal(found.source, 'environment');
    assert.equal(found.model, 'grok-4');
    assert.equal(discoverGrokGateway({ env: { GROK_BOT_API_URL: 'http://user:pass@127.0.0.1:1340', GROK_BOT_API_KEY: 'fallback-token' }, home: box.home, readFile }), null);
    assert.equal(discoverGrokGateway({ env: { GROK_BOT_API_URL: 'http://127.0.0.1:1340' }, home: box.home, readFile }), null);
  } finally {
    box.cleanup();
  }
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
