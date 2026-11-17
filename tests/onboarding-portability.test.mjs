import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

test('onboarding, config, discovery and quickstart tests have no maintainer paths', () => {
  const tests = new URL('./', import.meta.url);
  const files = readdirSync(tests).filter(name => /^(onboarding|agent-discovery|agent-registry|orbit-config|quickstart-docs|deploy-config|zero-agents-boot).*\.test\.mjs$/.test(name));
  const pathPattern = /\/(?:tmp\/opencode|home\/(?:mojo|kyle)|Users\/(?:mojo|kyle))\//i;
  for (const name of files) assert.doesNotMatch(readFileSync(new URL(name,tests),'utf8'), pathPattern, name);
});
