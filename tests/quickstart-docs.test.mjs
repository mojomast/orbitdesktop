// The stranger-facing quick start is a contract: every documented command must
// exist, every relative link must resolve, the first-run wizard and both provider
// paths must be described from the owner's point of view, and the page must not
// carry a maintainer's private infrastructure. This test is static on purpose;
// it never runs docker, podman or a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = name => readFileSync(path.join(REPO, name), 'utf8');
const QUICKSTART = 'docs/QUICKSTART.md';
const packageJson = () => JSON.parse(read('package.json'));
const scripts = () => packageJson().scripts ?? {};

function codeBlocks(source) {
  const blocks = [];
  const pattern = /```[^\n]*\n([\s\S]*?)```/g;
  let match;
  while ((match = pattern.exec(source))) blocks.push(match[1]);
  return blocks;
}

function markdownLinks(source) {
  const links = [];
  const pattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = pattern.exec(source))) links.push(match[1]);
  return links;
}

function relativeTarget(link) {
  if (/^(?:https?:|mailto:|tel:|#)/i.test(link)) return null;
  const clean = link.split('#')[0].split('?')[0];
  return clean ? path.resolve(REPO, 'docs', clean) : null;
}

test('QUICKSTART.md exists and is linked from the top of README.md', () => {
  assert.equal(existsSync(path.join(REPO, QUICKSTART)), true, `${QUICKSTART} must exist`);
  const readme = read('README.md');
  const top = readme.split(/\r?\n/).slice(0, 30).join('\n');
  assert.match(top, /docs\/QUICKSTART\.md/, 'README links the quick start near the top');
});

test('quick start covers first-run prerequisites and both install paths', () => {
  const source = read(QUICKSTART);
  assert.match(source, /^#\s+Quick start/m, 'has a Quick start title');
  assert.match(source, /prerequisites/i, 'names prerequisites');
  assert.match(source, /Node\.js\s+22\.12/i, 'states the supported Node version');
  assert.match(source, /Docker Compose/i, 'mentions Docker Compose');
  assert.match(source, /docker compose up -d/, 'documents the compose path');
  assert.match(source, /npm run up/, 'documents the local launcher path');
  assert.match(source, /npm ci/, 'documents locked dependency installation');
  assert.match(source, /--print-login-url/, 'documents how to read the one-time login URL');
});

test('quick start documents the first-run wizard, keys and Settings', () => {
  const source = read(QUICKSTART);
  assert.match(source, /Choose what to install/i, 'names step 1');
  assert.match(source, /Minimal install/i, 'documents the recommended minimal path');
  assert.match(source, /Custom/i, 'documents the granular custom path');
  assert.match(source, /Providers and keys/i, 'names step 2');
  assert.match(source, /model for each role|one model per role/i, 'names the per-role model step');
  assert.match(source, /Review and apply/i, 'names the review step');
  assert.match(source, /0600/, 'states key-file permissions');
  assert.match(source, /masked/i, 'states that the UI masks keys');
  assert.match(source, /docs\/CONFIG\.md/, 'links the configuration reference');
  assert.match(source, /Settings/, 'mentions editing later in Settings');
  assert.match(source, /per-role override|role.*override/i, 'documents per-role overrides');
  assert.match(source, /`mode`/, 'documents the mode field');
  assert.match(source, /`defaultModel`/, 'documents the defaultModel field');
});

test('quick start documents both provider paths and the opt-in router', () => {
  const source = read(QUICKSTART);
  assert.match(source, /Direct providers/i, 'documents direct providers');
  assert.match(source, /token router/i, 'documents the router path');
  assert.match(source, /hosted/i, 'mentions a hosted router endpoint');
  assert.match(source, /self-hosted/i, 'mentions a self-hosted router endpoint');
  assert.match(source, /base URL/i, 'explains the single endpoint plus key');
  assert.match(source, /Bifrost/i, 'names the default built-in engine');
  assert.match(source, /LiteLLM/i, 'names the advanced engine');
  assert.match(source, /Advanced/i, 'keeps LiteLLM under an advanced disclosure');
  assert.match(source, /digest/i, 'documents digest pinning');
  assert.match(source, /docs\/ROUTER\.md/, 'links the router guide');
  assert.doesNotMatch(source, /router[^.\n]{0,80}coming soon/i, 'the router is real, not coming soon');
  assert.match(source, /opt-in|off by default|unchecked/i, 'states that the router is opt-in');
});

test('quick start covers the setup agent and adding agents', () => {
  const source = read(QUICKSTART);
  assert.match(source, /setup agent/i, 'describes the setup agent');
  assert.match(source, /docs\/ADAPTERS\.md/, 'links the adapter guide');
  for (const adapter of ['Hermes', 'Grok Bot', 'Pi', 'OpenCode', 'OpenAI-compatible'])
    assert.match(source, new RegExp(adapter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `mentions ${adapter}`);
});

test('quick start keeps the default loopback posture and links optional host support', () => {
  const source = read(QUICKSTART);
  assert.match(source, /loopback/i, 'states the loopback default');
  assert.match(source, /127\.0\.0\.1/, 'shows the loopback address');
  assert.match(source, /Add an SSH host \(optional\)/, 'has the optional SSH host section');
  assert.match(source, /docs\/HOSTS\.md/, 'links the SSH hosts guide');
  assert.match(source, /tailcat/i, 'names the tailcat transport');
  assert.match(source, /untested/i, 'states the untested boundary');
  assert.match(source, /Troubleshooting/i, 'has troubleshooting');
  assert.match(source, /Uninstall/i, 'has uninstall instructions');
});

test('every relative Markdown link in QUICKSTART resolves inside the repository', () => {
  const source = read(QUICKSTART);
  for (const link of markdownLinks(source)) {
    const target = relativeTarget(link);
    if (!target) continue;
    assert.equal(existsSync(target), true, `link target is missing: ${link}`);
    assert.ok(target.startsWith(REPO + path.sep) || target === REPO, `link escapes the repository: ${link}`);
  }
});

test('every command in QUICKSTART refers to a real npm script or file', () => {
  const source = read(QUICKSTART);
  const text = codeBlocks(source).join('\n');
  const knownScripts = new Set(Object.keys(scripts()));

  for (const match of text.matchAll(/\bnpm run ([a-z0-9][a-z0-9:_-]*)/gi))
    assert.ok(knownScripts.has(match[1]), `npm script is missing: ${match[1]}`);

  for (const match of text.matchAll(/\bnpm (ci|start|test|install)\b/g)) {
    if (match[1] === 'start' || match[1] === 'test')
      assert.ok(knownScripts.has(match[1]), `npm script is missing: ${match[1]}`);
  }

  for (const match of text.matchAll(/\bnode\s+(scripts\/[A-Za-z0-9._-]+)/g))
    assert.equal(existsSync(path.join(REPO, match[1])), true, `referenced file is missing: ${match[1]}`);

  for (const match of text.matchAll(/(?:^|\s)(scripts\/[A-Za-z0-9._-]+\.(?:sh|mjs|py))/gm))
    assert.equal(existsSync(path.join(REPO, match[1])), true, `referenced file is missing: ${match[1]}`);
});

test('QUICKSTART avoids secrets, private hosts and personal paths', () => {
  const source = read(QUICKSTART);
  assert.doesNotMatch(source, /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, 'no Tailscale CGNAT address');
  assert.doesNotMatch(source, /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, 'no private IPv4 address');
  assert.doesNotMatch(source, /\.ts\.net\b/i, 'no tailnet DNS name');
  assert.doesNotMatch(source, /\/(?:home|Users)\/[A-Za-z0-9._-]+/, 'no personal filesystem path');
  assert.doesNotMatch(source, /\b(?:sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|xox[bap]-[A-Za-z0-9-]{8,})\b/, 'no token-shaped value');
  assert.doesNotMatch(source, /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/, 'no private key material');
});

test('README moves Tailscale instructions under an optional remote-access heading', () => {
  const readme = read('README.md');
  assert.match(readme, /^## Optional: remote access$/m, 'has the optional remote-access heading');
  assert.doesNotMatch(readme, /^## Serve Orbit on a Linux tailnet$/m, 'the old tailnet heading is gone');
  const remote = readme.indexOf('## Optional: remote access');
  assert.ok(remote >= 0, 'the optional remote-access section exists');
  const after = readme.slice(remote + '## Optional: remote access'.length);
  const section = after.split(/^## /m)[0];
  assert.match(section, /Tailscale/i, 'Tailscale guidance sits under the optional section');
  assert.doesNotMatch(readme, /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, 'no Tailscale CGNAT address');
  assert.doesNotMatch(readme, /\.ts\.net\b/i, 'no tailnet DNS name');
  assert.doesNotMatch(readme, /\/(?:home|Users)\/[A-Za-z0-9._-]+/, 'no personal filesystem path');
});

test('the fresh-container smoke script exists and is engine-neutral', () => {
  const file = path.join(REPO, 'scripts/smoke-fresh-container.sh');
  assert.equal(existsSync(file), true, 'scripts/smoke-fresh-container.sh must exist');
  const source = readFileSync(file, 'utf8');

  assert.match(source, /^#!.*\b(?:bash|sh)\b/m, 'has a shell shebang');
  assert.match(source, /--dry-run/, 'supports --dry-run');
  assert.match(source, /\bENGINE\b/, 'allows the container engine to be overridden');
  assert.match(source, /\bdocker\b/, 'mentions docker');
  assert.match(source, /\bpodman\b/, 'mentions podman');
  assert.match(source, /command -v|type -P|which/, 'detects the available engine');
  assert.match(source, /playwright-core/, 'uses the Playwright already in node_modules');
  assert.match(source, /curl/, 'uses curl for health checks');
  assert.match(source, /--print-login-url/, 'reads the documented login URL');
  assert.match(source, /orbit-up\.mjs/, 'uses the repository launcher');
  assert.match(source, /--build|build /, 'builds the image');
  assert.match(source, /Choose what to install\|Minimal install/, 'accepts either step-1 heading');
  assert.match(source, /service(?:=|%3D|\\=)router|service=router/, 'asserts the router service did not start');
  assert.match(source, /COMPOSE_PROFILES/, 'runs with COMPOSE_PROFILES unset');
  assert.match(source, /trap\b/, 'cleans up on exit');
  assert.match(source, /down -v|volume rm|volume create/, 'removes the container and volume');
  assert.match(source, /mktemp|RANDOM/, 'uses a fresh temporary name or directory');
  assert.match(source, /-eq 4318|!= 4318|4318/, 'explicitly excludes port 4318');
  assert.doesNotMatch(source, /127\.0\.0\.1:4318/, 'never publishes port 4318');
  assert.doesNotMatch(source, /(?:^|\s)PORT=4318\b/, 'never configures port 4318');
});

test('the pull-request workflow runs the smoke script and uploads the screenshot', () => {
  const file = path.join(REPO, '.github/workflows/fresh-container-smoke.yml');
  assert.equal(existsSync(file), true, 'fresh-container-smoke.yml must exist');
  const source = readFileSync(file, 'utf8');
  assert.match(source, /^on:\s*$/m, 'declares triggers');
  assert.match(source, /pull_request/, 'runs on pull_request');
  assert.match(source, /ubuntu-24\.04/, 'uses Ubuntu 24.04');
  assert.match(source, /scripts\/smoke-fresh-container\.sh/, 'calls the smoke script');
  assert.match(source, /upload-artifact/, 'uploads an artifact');
  assert.match(source, /screenshot|smoke-artifacts|onboarding/i, 'names the onboarding screenshot artifact');
  assert.doesNotMatch(source, /\bsecrets\.|\bsecrets\[/, 'uses no secrets');
});
