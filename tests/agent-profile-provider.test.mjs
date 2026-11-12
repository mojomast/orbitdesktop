import test from 'node:test';
import assert from 'node:assert/strict';
import { asProvider, profileProvider, providerLabel, registerAgentProvider } from '../src/agent-providers.ts';

test('unlisted Hermes profile names stay Hermes; explicit unknown provider ids stay unconfigured', () => {
  // A chat bound to a Hermes profile such as "research" before the profile list arrives.
  assert.equal(profileProvider('research'), 'hermes');
  assert.equal(providerLabel(profileProvider('research')), 'Hermes');
  assert.equal(profileProvider('default'), 'hermes');
  assert.equal(profileProvider(undefined), 'hermes');
  // Known adapters are recognised from the bare id.
  assert.equal(profileProvider('grok'), 'grok');
  assert.equal(profileProvider('pi'), 'pi');
  // A listed profile's explicit provider always wins, and an unknown one is never Hermes.
  assert.equal(profileProvider('research', 'grok'), 'grok');
  assert.equal(profileProvider('anything', 'mystery-adapter'), 'mystery-adapter');
  assert.equal(providerLabel(asProvider('mystery-adapter')), 'Unconfigured adapter');
  // A registered generic adapter is recognised by id.
  registerAgentProvider({ id: 'local-llm', label: 'Local LLM', mark: 'L', kind: 'openai-compatible', capabilities: { streaming: true }, configured: true, configHint: '' });
  assert.equal(profileProvider('local-llm'), 'local-llm');
  assert.equal(providerLabel(profileProvider('local-llm')), 'Local LLM');
});
