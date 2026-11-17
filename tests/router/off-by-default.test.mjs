// Compose's config command renders a model locally. Never up, pull or probe a daemon.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ROUTER_IMAGES } from '../../server/orbit-config.mjs';

function compose(t, selected) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-compose-profile-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const env = { HOME: cwd, PATH: process.env.PATH, DOCKER_HOST: 'unix:///no-orbit-test-daemon' };
  if (spawnSync('docker', ['compose', 'version'], { cwd, env }).status !== 0) {
    t.skip('Docker Compose CLI unavailable'); return;
  }
  for (const name of ['docker-compose.yml', 'compose.router.yml']) {
    fs.copyFileSync(new URL(`../../${name}`, import.meta.url), path.join(cwd, name));
  }
  if (selected) {
    fs.mkdirSync(path.join(cwd, 'runtime/router'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'runtime/router/router.env'), '', { mode: 0o600 });
    env.COMPOSE_PROFILES = 'router';
    env.ORBIT_ROUTER_IMAGE = 'unexpected-override'; // must not override the release pin
  }
  const model = JSON.parse(execFileSync('docker', ['compose', '--env-file', '/dev/null', 'config', '--format', 'json'], { cwd, env, encoding: 'utf8' }));
  if (!selected) assert.equal(fs.existsSync(path.join(cwd, 'runtime')), false);
  return model.services;
}

test('no_selection_starts_nothing', t => {
  const services = compose(t, false);
  if (services) assert.deepEqual(Object.keys(services), ['orbit']);
});

test('only_the_router_profile_starts_the_router_service', t => {
  const services = compose(t, true);
  if (services) assert.deepEqual(services.router.profiles, ['router']);
});

test('image_is_digest_pinned_read_only_and_portless', t => {
  const services = compose(t, true);
  if (!services) return;
  assert.equal(services.router.image, ROUTER_IMAGES.bifrost);
  assert.equal(services.router.read_only, true);
  assert.deepEqual(services.router.cap_drop, ['ALL']);
  assert.equal(services.router.ports, undefined);
  assert.ok(!JSON.stringify(services).includes('docker.sock'));
});
