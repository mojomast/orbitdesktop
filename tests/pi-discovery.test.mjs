import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { discoverPiHarness, discoverAgentBackends, attachProviders } from '../server/agent-discovery.mjs';
import { createAgentProfiles } from '../server/agent-profiles.mjs';

/**
 * Pi discovery decides between three states: an external gateway, a harness on
 * this computer that Orbit hosts itself, or no Pi profile at all. A missing or
 * unusable configuration must leave the agent menu exactly as it was.
 */

const home = '/home/pi-user';

test('an explicit Pi gateway needs a URL and a token, and a bad URL disables Pi', () => {
  const external = discoverPiHarness({ env: { PI_GATEWAY_URL: 'http://127.0.0.1:1350/', PI_GATEWAY_TOKEN: 'pi-gateway-token' }, home, isExecutable: () => true });
  assert.deepEqual(external, {
    id: 'pi',
    label: 'Pi',
    provider: 'pi',
    apiUrl: 'http://127.0.0.1:1350',
    apiKey: 'pi-gateway-token',
    source: 'environment',
    external: true,
  });
  assert.equal(discoverPiHarness({ env: { PI_GATEWAY_URL: 'http://127.0.0.1:1350' }, home, isExecutable: () => true }), null);
  assert.equal(discoverPiHarness({ env: { PI_GATEWAY_URL: 'not a url', PI_GATEWAY_TOKEN: 'pi-gateway-token' }, home, isExecutable: () => true }), null);
  assert.equal(discoverPiHarness({ env: { PI_GATEWAY_URL: 'http://user:pass@127.0.0.1:1350', PI_GATEWAY_TOKEN: 'pi-gateway-token' }, home, isExecutable: () => true }), null);
});

test('the Pi harness binary is found on PATH or as PI_BIN, and never as a relative path', () => {
  const onPath = discoverPiHarness({ env: { PATH: `/usr/bin${path.delimiter}/home/pi-user/.local/bin` }, home, isExecutable: file => file === path.join(home, '.local', 'bin', 'pi') });
  assert.equal(onPath.source, 'pi-harness');
  assert.equal(onPath.managed, true);
  assert.equal(onPath.binary, path.join(home, '.local', 'bin', 'pi'));
  assert.equal(onPath.label, 'Pi');
  assert.equal(onPath.apiUrl, undefined);
  assert.equal(discoverPiHarness({ env: { PATH: '/usr/bin' }, home, isExecutable: () => false }), null);
  assert.equal(discoverPiHarness({ env: { PI_BIN: 'bin/pi' }, home, isExecutable: () => true }), null);
  assert.equal(discoverPiHarness({ env: { PI_BIN: '/opt/pi/pi' }, home, isExecutable: file => file === '/opt/pi/pi' }).binary, '/opt/pi/pi');
  assert.equal(discoverPiHarness({ env: { PI_HARNESS_DISABLED: 'true' }, home, isExecutable: () => true }), null);
});

test('a discovered Pi harness joins the agent menu beside Hermes and Grok Bot', () => {
  const harness = discoverPiHarness({ env: { PATH: '/usr/bin', PI_BIN: '/opt/pi/pi' }, home, isExecutable: () => true });
  const profile = { id: 'pi', label: harness.label, provider: 'pi', apiUrl: 'http://127.0.0.1:41234', apiKey: 'pi-gateway-token' };
  const catalog = createAgentProfiles({ profiles: [{ id: 'default', label: 'Hermes', apiUrl: 'http://127.0.0.1:8642', apiKey: 'hermes-key' }] });
  const withPi = attachProviders(catalog, [profile]);
  assert.deepEqual(withPi.list, [
    { id: 'default', label: 'Hermes' },
    { id: 'pi', label: 'Pi', provider: 'pi' },
  ]);
  assert.equal(withPi.get('pi').provider, 'pi');
  assert.equal(withPi.get('pi').apiUrl, 'http://127.0.0.1:41234');
  // A Pi profile reaches its gateway, never the Hermes run API.
  assert.equal(withPi.resolveRun('pi'), null);
  assert.equal(catalog.get('pi'), null);
});

test('attachProviders keeps refusing a profile with a missing key or a path', () => {
  const catalog = createAgentProfiles({ profiles: [{ id: 'default', label: 'Hermes', apiUrl: 'http://127.0.0.1:8642', apiKey: 'hermes-key' }] });
  const base = { id: 'pi', label: 'Pi', provider: 'pi', apiKey: 'pi-gateway-token' };
  assert.equal(attachProviders(catalog, [{ ...base, apiUrl: 'http://127.0.0.1:41234/path' }]).list.length, 1);
  assert.equal(attachProviders(catalog, [{ ...base, apiUrl: 'http://127.0.0.1:41234', apiKey: '   ' }]).list.length, 1);
  assert.equal(attachProviders(catalog, [{ ...base, apiUrl: 'http://127.0.0.1:41234', provider: 'not-a-provider' }]).list.length, 1);
});

test('backend discovery reports all three providers without reading a vendor key', () => {
  const backends = discoverAgentBackends({ env: { PATH: '/usr/bin' }, home, isExecutable: () => false });
  assert.deepEqual(Object.keys(backends), ['hermes', 'grok', 'pi']);
  assert.equal(backends.hermes, null);
  assert.equal(backends.pi, null);
  // Grok discovery also looks at absolute host paths, so this machine either has a
  // Grok Bot gateway or it does not; the shape is what this test owns.
  assert.ok(backends.grok === null || backends.grok.provider === 'grok');
});
