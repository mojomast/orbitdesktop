import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAgentRegistry,
  builtinAgentDefinitions,
  parseAgentConfig,
  validateAgentDefinition,
} from '../server/agent-registry.mjs';
import {
  configureAgentProviders,
  providerLabel,
  providerMark,
  providerState,
} from '../server/agent-providers.mjs';

const capabilities = Object.freeze({
  compact: true,
  modelSwitch: false,
  contextMeter: true,
  approvals: false,
  streaming: true,
});

function definition(overrides = {}) {
  return {
    id: 'local-agent',
    label: 'Local agent',
    mark: 'L',
    kind: 'openai-compatible',
    capabilities: { ...capabilities },
    configured: true,
    configHint: 'Set LOCAL_AGENT_API_URL before starting Orbit.',
    ...overrides,
  };
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-agent-registry-'));
}

function assertInvalid(fn, pattern = /Invalid agent provider/) {
  assert.throws(fn, error => pattern.test(error.message) && !/sk-live-secret|super-private/.test(error.message));
}

test('unknown provider ids stay unconfigured and never fall back to Hermes', () => {
  const registry = createAgentRegistry({
    builtins: builtinAgentDefinitions({ discovered: {} }),
    config: [],
  });

  for (const id of ['not-configured', 'openai-local', 'someone-elses-adapter']) {
    const state = registry.describe(id);
    assert.equal(state.configured, false);
    assert.equal(state.state, 'unconfigured');
    assert.equal(state.label, 'Unconfigured adapter');
    assert.equal(state.mark, '?');
    assert.deepEqual(state.capabilities, {
      compact: false,
      modelSwitch: false,
      contextMeter: false,
      approvals: false,
      streaming: false,
    });
    assert.equal(registry.get(id), null);
  }

  configureAgentProviders({ builtins: builtinAgentDefinitions({ discovered: {} }), config: [] });
  assert.equal(providerLabel('missing-adapter'), 'Unconfigured adapter');
  assert.equal(providerMark('missing-adapter'), '?');
  assert.equal(providerState('missing-adapter'), 'unconfigured');
  // Known adapters keep their label, but discovery decides whether they are usable.
  assert.equal(providerLabel('hermes'), 'Hermes');
  assert.equal(providerState('hermes'), 'unconfigured');
  configureAgentProviders({ builtins: builtinAgentDefinitions({ discovered: { hermes: {}, grok: {}, pi: {} } }), config: [] });
  assert.equal(providerState('hermes'), 'configured');
  assert.equal(providerState('grok'), 'configured');
  assert.equal(providerState('pi'), 'configured');
});

test('built-in adapters appear only when discovery reports them as configured', () => {
  const none = createAgentRegistry({ builtins: builtinAgentDefinitions({ discovered: {} }), config: [] });
  assert.deepEqual(none.list().map(item => item.id), ['hermes', 'grok', 'pi']);
  assert.equal(none.list().some(item => item.configured), false);
  assert.equal(none.describe('grok').state, 'unconfigured');

  const hermesOnly = createAgentRegistry({ builtins: builtinAgentDefinitions({ discovered: { hermes: {} } }), config: [] });
  assert.deepEqual(hermesOnly.list().filter(item => item.configured).map(item => item.id), ['hermes']);

  const empty = createAgentRegistry({ builtins: [], config: [] });
  assert.deepEqual(empty.list(), []);
  assert.equal(empty.describe('hermes').state, 'unconfigured');

  const summary = none.summary();
  assert.equal(summary.state, 'no-agents-configured');
  assert.match(summary.message, /No agents configured/i);
  assert.equal(summary.configured.length, 0);
});

test('config file accepts complete definitions and exposes only safe references', () => {
  const root = tempRoot();
  try {
    const file = path.join(root, 'agents.json');
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      agents: [definition({ apiKeyEnv: 'LOCAL_AGENT_API_KEY', apiKeyFile: 'local-agent.key' })],
    }));
    const registry = createAgentRegistry({ builtins: [], env: { ORBIT_AGENTS_FILE: file } });
    const listed = registry.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, 'local-agent');
    assert.equal(listed[0].apiKeyEnv, 'LOCAL_AGENT_API_KEY');
    assert.equal(listed[0].apiKeyFile, 'local-agent.key');
    assert.equal(listed[0].configured, true);
    assert.equal(registry.get('local-agent').label, 'Local agent');
    assert.equal(registry.describe('local-agent').state, 'configured');
    assert.equal(JSON.stringify(listed).includes('sk-live-secret'), false);

    const defaultRoot = path.join(root, 'runtime');
    fs.mkdirSync(defaultRoot);
    fs.writeFileSync(path.join(defaultRoot, 'agents.json'), JSON.stringify([definition()]));
    const byRuntime = createAgentRegistry({ builtins: [], env: {}, runtimeDir: defaultRoot });
    assert.equal(byRuntime.list()[0].id, 'local-agent');

    const missing = createAgentRegistry({ builtins: [], env: {}, runtimeDir: path.join(root, 'empty') });
    assert.deepEqual(missing.list(), []);

    for (const badPath of ['agents.json', './agents.json', 'runtime/../agents.json']) {
      assertInvalid(() => createAgentRegistry({ builtins: [], env: { ORBIT_AGENTS_FILE: badPath } }), /absolute/i);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('config and register validate ids, marks, capabilities, kinds and shapes', () => {
  const valid = definition();
  assert.equal(validateAgentDefinition(valid).id, 'local-agent');

  for (const id of ['Agent', 'a:b', '', '-leading', 'a'.repeat(33), 'a b', '../escape', 'a/b']) {
    assertInvalid(() => createAgentRegistry({ builtins: [], config: [definition({ id })] }));
  }
  for (const mark of ['', 'abc', 'a b', '\n', 42]) {
    assertInvalid(() => createAgentRegistry({ builtins: [], config: [definition({ mark })] }));
  }
  for (const kind of ['', 42, 'Bad Kind', 'upper/Case']) {
    assertInvalid(() => createAgentRegistry({ builtins: [], config: [definition({ kind })] }));
  }
  for (const configured of ['yes', 1, null]) {
    assertInvalid(() => createAgentRegistry({ builtins: [], config: [definition({ configured })] }));
  }
  for (const configHint of [null, 42, 'bad\nhint']) {
    assertInvalid(() => createAgentRegistry({ builtins: [], config: [definition({ configHint })] }));
  }
  for (const caps of [null, [], { compact: 'yes' }, { ...capabilities, unknown: true }]) {
    assertInvalid(() => createAgentRegistry({ builtins: [], config: [definition({ capabilities: caps })] }));
  }
  for (const config of ['{', '{}', 'null', '42', { agents: 'nope' }, { agents: [], extra: true }, { providers: [] }]) {
    assertInvalid(() => createAgentRegistry({ builtins: [], config }), /Invalid agent configuration|Invalid agent provider/);
  }
  assert.deepEqual(parseAgentConfig([]), []);

  const registry = createAgentRegistry({ builtins: [], config: [] });
  registry.register(definition({ id: 'second-agent', label: 'Second' }));
  assert.equal(registry.get('second-agent').label, 'Second');
  registry.register(definition({ id: 'second-agent', label: 'Renamed' }));
  assert.equal(registry.get('second-agent').label, 'Renamed');
  assert.equal(registry.list().length, 1);
  assertInvalid(() => registry.register(definition({ id: 'Not Valid' })));
});

test('inline secrets are refused; environment names and key-file names are allowed', () => {
  const secret = 'sk-live-secret-super-private';
  for (const key of ['apiKey', 'token', 'secret', 'password', 'key', 'api_key']) {
    assertInvalid(
      () => createAgentRegistry({ builtins: [], config: [{ ...definition(), [key]: secret }] }),
      /secret|inline/i,
    );
    assertInvalid(
      () => validateAgentDefinition({ ...definition(), [key]: secret }),
      /secret|inline/i,
    );
  }
  for (const ref of [
    { apiKeyEnv: secret },
    { tokenEnv: 'lower-case-env' },
    { keyEnv: '' },
    { apiKeyFile: '../outside.key' },
    { tokenFile: '/etc/passwd' },
    { keyFile: 'nested/key' },
    { keyFile: '..' },
  ]) {
    assertInvalid(() => createAgentRegistry({ builtins: [], config: [{ ...definition(), ...ref }] }), /key|env|file|reference/i);
  }

  const accepted = createAgentRegistry({
    builtins: [],
    config: [definition({ apiKeyEnv: 'LOCAL_AGENT_API_KEY', apiKeyFile: 'local-agent.key' })],
  });
  const listed = accepted.list()[0];
  assert.equal(listed.apiKeyEnv, 'LOCAL_AGENT_API_KEY');
  assert.equal(listed.apiKeyFile, 'local-agent.key');

  const root = tempRoot();
  try {
    const file = path.join(root, 'agents.json');
    fs.writeFileSync(file, JSON.stringify({ agents: [{ ...definition(), token: secret }] }));
    assertInvalid(() => createAgentRegistry({ builtins: [], env: { ORBIT_AGENTS_FILE: file } }), /secret|inline/i);
    assert.equal(fs.readFileSync(file, 'utf8').includes(secret), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
