import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupAgentPrompt, setupChecklist } from '../server/setup-agent.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function config(overrides = {}) {
  return {
    schemaVersion: 2,
    components: {
      core: true,
      pi: true,
      opencode: true,
      hermes: false,
      bundlebees: true,
      workers: true,
      colab: false,
      apps: false,
      router: false,
      litellmLocal: false,
    },
    providers: [
      { id: 'router', label: 'Built-in router', kind: 'router', hasKey: true },
      { id: 'deepseek', label: 'DeepSeek', keyStatus: 'set' },
    ],
    roles: {
      setup: { provider: 'router', model: 'gpt-4.1-mini' },
      chat: { provider: 'router', model: 'anthropic/claude-sonnet' },
      workers: { provider: 'deepseek', model: 'deepseek-chat' },
    },
    installState: { core: 'installed', 'agent-pi': 'pending' },
    ...overrides,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertNoPrivateBits(text) {
  assert.doesNotMatch(text, /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  assert.doesNotMatch(text, /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/);
  assert.doesNotMatch(text, /\/home\/[A-Za-z0-9._-]+/);
  assert.doesNotMatch(text, /\.ts\.net\b|\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+\b/i);
  assert.doesNotMatch(text, /\bsk-[A-Za-z0-9_-]{8,}/);
  assert.doesNotMatch(text, /\bBearer\s+[A-Za-z0-9._-]{12,}/);
}

test('default prompt covers every setup layer without hosts, tokens or private paths', () => {
  const prompt = setupAgentPrompt({ agentLabel: 'a local agent' });
  assert.match(prompt, /health/i);
  assert.match(prompt, /mojomast\/workflow/);
  assert.match(prompt, /reference\/run_demo\.py/);
  assert.match(prompt, /bundlebees/i);
  assert.match(prompt, /local-workers/i);
  assert.match(prompt, /worker/i);
  assert.match(prompt, /docs\/ADAPTERS\.md/);
  assert.match(prompt, /Hermes/);
  assert.match(prompt, /Grok Bot/);
  assert.match(prompt, /Pi/);
  assert.match(prompt, /OpenCode/);
  assert.match(prompt, /Codex/);
  assert.match(prompt, /OpenAI-compatible/);
  assert.match(prompt, /PUT \/api\/onboarding\/install-state/);
  assert.match(prompt, /router/i);
  assertNoPrivateBits(prompt);
});

test('checklist steps have unique ids and secret-free verify commands', () => {
  const steps = setupChecklist();
  assert.ok(Array.isArray(steps));
  assert.ok(steps.length >= 5);
  const ids = steps.map((step) => step.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const step of steps) {
    assert.deepEqual(Object.keys(step).sort(), ['id', 'title', 'verify']);
    assert.ok(step.title.trim().length > 0);
    assert.ok(step.verify.trim().length > 0);
    assert.doesNotMatch(step.verify, /\bsk-[A-Za-z0-9_-]{8,}/);
    assert.doesNotMatch(step.verify, /\bBearer\s+[A-Za-z0-9._-]{12,}/);
    assert.doesNotMatch(step.verify, /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    assert.doesNotMatch(step.verify, /\/home\/[A-Za-z0-9._-]+/);
  }
});

test('only chosen components appear in the plan and checklist', () => {
  const selected = config({
    components: {
      core: true,
      pi: true,
      opencode: false,
      hermes: false,
      bundlebees: true,
      workers: true,
      colab: false,
      apps: false,
      router: false,
      litellmLocal: false,
    },
  });
  const prompt = setupAgentPrompt({ agentLabel: 'Pi', config: selected });
  for (const id of ['core', 'pi', 'bundlebees', 'workers']) {
    assert.match(prompt, new RegExp(`\\[${escapeRegExp(id)}\\]`));
  }
  for (const id of ['opencode', 'hermes', 'colab', 'apps', 'litellmLocal']) {
    assert.doesNotMatch(prompt, new RegExp(`\\[${escapeRegExp(id)}\\]`));
  }
  const ids = setupChecklist(selected).map((step) => step.id);
  assert.ok(ids.includes('core'));
  assert.ok(ids.includes('pi'));
  assert.ok(ids.includes('bundlebees'));
  assert.ok(ids.includes('workers'));
  assert.ok(!ids.includes('opencode'));
  assert.ok(!ids.includes('hermes'));
  assert.ok(!ids.includes('colab'));
  assert.ok(!ids.includes('apps'));
  assert.ok(!ids.includes('litellmLocal'));
});

test('role mapping names the provider and model for each part', () => {
  const prompt = setupAgentPrompt({ agentLabel: 'Pi', config: config() });
  assert.match(prompt, /chat:\s*router\s*\/\s*anthropic\/claude-sonnet/);
  assert.match(prompt, /workers:\s*deepseek\s*\/\s*deepseek-chat/);
  assert.match(prompt, /setup:\s*router\s*\/\s*gpt-4\.1-mini/);
});

test('a sentinel key in the config view never appears in the prompt', () => {
  const sentinel = 'sk-SENTINEL-DO-NOT-LEAK-123456';
  const cfg = config({
    providers: [
      {
        id: 'openai',
        label: 'OpenAI',
        apiKey: sentinel,
        key: sentinel,
        keyStatus: sentinel,
        masked: sentinel,
      },
    ],
    router: {
      enabled: true,
      mode: 'external',
      external: { baseUrl: 'https://router.example/v1', apiKey: sentinel, key: sentinel },
    },
  });
  const prompt = setupAgentPrompt({ agentLabel: 'Pi', config: cfg });
  assert.equal(prompt.includes(sentinel), false);
  assert.equal(prompt.includes('SENTINEL'), false);
});

test('router mode points agents at the configured router and role models', () => {
  const external = config({
    providerMode: 'router',
    components: { core: true, pi: true, opencode: true, hermes: false, bundlebees: true, workers: true, colab: false, apps: false, router: true, litellmLocal: false },
    router: { enabled: true, mode: 'external', external: { baseUrl: 'https://router.example/openai/v1' } },
  });
  const externalPrompt = setupAgentPrompt({ agentLabel: 'Pi', config: external });
  assert.match(externalPrompt, /https:\/\/router\.example\/openai\/v1/);
  assert.match(externalPrompt, /external/i);
  assert.match(externalPrompt, /chat:\s*router\s*\/\s*anthropic\/claude-sonnet/);
  assert.doesNotMatch(externalPrompt, /docker compose --profile router up -d router/);
  assert.doesNotMatch(externalPrompt, /pipx install 'litellm\[proxy\]'/);

  const builtin = config({
    providerMode: 'router',
    components: { core: true, pi: true, opencode: true, hermes: false, bundlebees: true, workers: true, colab: false, apps: false, router: true, litellmLocal: false },
    router: { enabled: true, mode: 'builtin', engine: 'bifrost', port: 8080 },
  });
  const builtinPrompt = setupAgentPrompt({ agentLabel: 'Pi', config: builtin });
  assert.match(builtinPrompt, /Bifrost/);
  assert.match(builtinPrompt, /supervisor/i);
  assert.match(builtinPrompt, /127\.0\.0\.1:8080\/v1/);
  assert.doesNotMatch(builtinPrompt, /docker compose --profile router up -d router/);
  assert.doesNotMatch(builtinPrompt, /pipx install 'litellm\[proxy\]'/);
});

test('local LiteLLM is installed only when components.litellmLocal is true', () => {
  const on = config({
    providerMode: 'router',
    components: { core: true, pi: false, opencode: false, hermes: false, bundlebees: false, workers: false, colab: false, apps: false, router: true, litellmLocal: true },
    router: { enabled: true, mode: 'builtin', engine: 'litellm', port: 4000 },
  });
  const onPrompt = setupAgentPrompt({ agentLabel: 'Pi', config: on });
  assert.match(onPrompt, /docker compose --profile router up -d router/);
  assert.match(onPrompt, /pipx install 'litellm\[proxy\]'/);
  assert.match(onPrompt, /litellm --config/);
  assert.match(onPrompt, /127\.0\.0\.1/);
  assert.match(onPrompt, /4000/);
  assert.match(onPrompt, /os\.environ\//);
  assert.match(onPrompt, /0600/);
  assert.match(onPrompt, /master key/i);
  assert.ok(setupChecklist(on).some((step) => step.id === 'litellmLocal'));

  const off = config({
    components: { core: true, pi: true, opencode: false, hermes: false, bundlebees: true, workers: true, colab: false, apps: false, router: false, litellmLocal: false },
  });
  const offPrompt = setupAgentPrompt({ agentLabel: 'Pi', config: off });
  assert.doesNotMatch(offPrompt, /docker compose --profile router up -d router/);
  assert.doesNotMatch(offPrompt, /pipx install 'litellm\[proxy\]'/);
  assert.doesNotMatch(offPrompt, /litellm --config/);
  assert.ok(!setupChecklist(off).some((step) => step.id === 'litellmLocal'));
});

test('skill and checklist documents mirror the setup plan', () => {
  const skill = read('skills/setup-agent/SKILL.md');
  const checklist = read('docs/SETUP_CHECKLIST.md');
  for (const text of [skill, checklist]) {
    assert.match(text, /health/i);
    assert.match(text, /mojomast\/workflow/);
    assert.match(text, /reference\/run_demo\.py/);
    assert.match(text, /bundlebees/i);
    assert.match(text, /docs\/ADAPTERS\.md/);
    assert.match(text, /PUT \/api\/onboarding\/install-state/);
    assertNoPrivateBits(text);
  }
  assert.match(checklist, /OpenCode free models stay direct/i);
  assert.match(checklist, /os\.environ\//);
  assert.match(checklist, /0600/);
});
