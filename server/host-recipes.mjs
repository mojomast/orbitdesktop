import { redactAuditText } from './host-audit.mjs';

/**
 * Idempotent host recipes.
 *
 * SSH is used only to install, upgrade or remove the worker. The worker itself
 * dials out to Orbit and pairs with a short-lived code, so no SSH key and no
 * long-lived credential is written into the compose file or .env.
 *
 * UNTESTED: the tailcat ProxyCommand transport is not exercised by this module.
 * UNTESTED: remote authorized_keys cleanup on host removal is owned by the
 * SSH host module; this recipe never edits a remote authorized_keys file.
 */

// Placeholder digest for the development candidate; pass workerImage to the
// recipe factory when a release publishes the worker image.
export const BUNDLEBEES_WORKER_IMAGE = 'ghcr.io/mojomast/orbit-worker@sha256:4c39d73eb6d2097b56dacbdb4725ad36dff5e7c84771f1b886b61e9720cc5fa5';

export const BUNDLEBEES_WORKER_RECIPE = Object.freeze({
  id: 'bundlebees-worker',
  label: 'Bundlebees worker',
  actions: Object.freeze(['install', 'upgrade', 'remove']),
  image: BUNDLEBEES_WORKER_IMAGE,
});

const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_PAIRING_CODE = /^[A-Za-z0-9._~:-]{1,512}$/;
const SUPPORTED_ARCH = new Map([
  ['x86_64', 'amd64'],
  ['amd64', 'amd64'],
  ['aarch64', 'arm64'],
  ['arm64', 'arm64'],
]);
const DEFAULT_MIN_DOCKER = '24.0.0';
const DEFAULT_MIN_DISK_KB = 2 * 1024 * 1024;
const DEFAULT_MAX_CLOCK_SKEW_SEC = 300;

function recipeError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function assertHostId(hostId) {
  if (typeof hostId !== 'string' || !HOST_ID.test(hostId) || hostId === '.' || hostId === '..') {
    throw recipeError('invalid_host', 'Invalid host id.');
  }
  return hostId;
}

function normalizeExitCode(result) {
  const value = result?.code ?? result?.exitCode ?? result?.status;
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function parseVersion(text) {
  const match = String(text).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

function versionAtLeast(actual, required) {
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > required[index]) return true;
    if (actual[index] < required[index]) return false;
  }
  return true;
}

function pairingCodeOf(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    if (typeof value.code === 'string') return value.code;
    if (typeof value.pairingCode === 'string') return value.pairingCode;
    if (typeof value.pairing_code === 'string') return value.pairing_code;
  }
  return '';
}

function composeArgs(hostId, dockerMode, rest) {
  return dockerMode === 'context'
    ? ['docker', '--context', `orbit-${hostId}`, 'compose', ...rest]
    : ['docker', 'compose', ...rest];
}

function composeFile(hostId, image) {
  return [
    'name: orbit-worker',
    'services:',
    '  worker:',
    `    image: ${image}`,
    '    restart: unless-stopped',
    '    env_file:',
    '      - .env',
    '    labels:',
    '      orbit.managed: "true"',
    '      orbit.recipe: "bundlebees-worker"',
    `      orbit.host: "${hostId}"`,
    '',
  ].join('\n');
}

function envFile(hostId, pairingCode) {
  return [
    `ORBIT_HOST_ID=${hostId}`,
    'ORBIT_RECIPE=bundlebees-worker',
    `ORBIT_PAIRING_CODE=${pairingCode}`,
    '',
  ].join('\n');
}

export function createHostRecipes({
  run,
  exec,
  put,
  writeFile,
  issuePairingCode,
  createPairingCode,
  waitForPairing,
  waitForWorkerPairing,
  revokeWorkerToken,
  revokeToken,
  log = () => {},
  now = () => Date.now(),
  dockerMode = 'context',
  image,
  workerImage,
  minDockerVersion = DEFAULT_MIN_DOCKER,
  minDiskKb = DEFAULT_MIN_DISK_KB,
  maxClockSkewSec = DEFAULT_MAX_CLOCK_SKEW_SEC,
  workDir = '/opt/orbit/worker',
  project = 'orbit-worker',
} = {}) {
  run = run || exec;
  put = put || writeFile;
  issuePairingCode = issuePairingCode || createPairingCode;
  waitForPairing = waitForPairing || waitForWorkerPairing;
  revokeWorkerToken = revokeWorkerToken || revokeToken;
  image = image || workerImage || BUNDLEBEES_WORKER_IMAGE;
  if (typeof run !== 'function') throw recipeError('invalid_runner', 'A host run function is required.');
  if (dockerMode !== 'context' && dockerMode !== 'remote') throw recipeError('invalid_docker_mode', 'dockerMode must be context or remote.');
  if (typeof image !== 'string' || !/@sha256:[a-f0-9]{64}$/.test(image)) throw recipeError('invalid_image', 'The worker image must be pinned by digest.');
  const requiredDocker = parseVersion(minDockerVersion) ?? parseVersion(DEFAULT_MIN_DOCKER);

  function compose(hostId, rest) {
    return composeArgs(hostId, dockerMode, ['-p', project, ...rest]);
  }

  async function step(hostId, argv, { cwd = workDir, timeoutMs = 120000, allowFailure = false, code = 'recipe_failed' } = {}) {
    let result;
    try {
      result = await run(hostId, argv, { cwd, timeout: timeoutMs });
    } catch (error) {
      if (['approval_refused', 'approval_required', 'permission_denied', 'host_key_changed', 'host_revoked', 'audit_unavailable', 'timeout'].includes(error?.code)) throw error;
      throw recipeError(code, `Recipe step failed: ${redactAuditText(error?.message || 'command failed')}`);
    }
    const exitCode = normalizeExitCode(result);
    if (exitCode !== 0 && !allowFailure) {
      const detail = redactAuditText(String(result?.stderr || result?.stdout || '')).slice(0, 600);
      throw recipeError(code, `Recipe step exited ${exitCode}${detail ? `: ${detail}` : '.'}`);
    }
    return { ...result, exitCode };
  }

  async function preflight(hostId) {
    const steps = [];
    try {
      const uname = await step(hostId, ['uname', '-m'], { cwd: '/', timeoutMs: 15000, code: 'preflight_failed' });
      const rawArch = String(uname.stdout || '').trim().toLowerCase();
      const arch = SUPPORTED_ARCH.get(rawArch);
      if (!arch) throw recipeError('preflight_failed', `Unsupported architecture: ${rawArch || 'unknown'}.`);
      steps.push(['uname', '-m']);

      const docker = await step(hostId, ['docker', '--version'], { cwd: '/', timeoutMs: 15000, code: 'preflight_failed' });
      const dockerVersion = parseVersion(docker.stdout || docker.stderr);
      if (!dockerVersion || !versionAtLeast(dockerVersion, requiredDocker)) {
        throw recipeError('preflight_failed', `Docker ${minDockerVersion} or newer is required.`);
      }
      steps.push(['docker', '--version']);

      await step(hostId, ['docker', 'compose', 'version'], { cwd: '/', timeoutMs: 15000, code: 'preflight_failed' });
      steps.push(['docker', 'compose', 'version']);

      const df = await step(hostId, ['df', '-Pk', '/'], { cwd: '/', timeoutMs: 15000, code: 'preflight_failed' });
      const line = String(df.stdout || '').trim().split('\n').filter(Boolean).at(-1) || '';
      const columns = line.split(/\s+/);
      const available = Number(columns[3]);
      if (!Number.isFinite(available) || available < minDiskKb) {
        throw recipeError('preflight_failed', `At least ${minDiskKb} KiB free is required.`);
      }
      steps.push(['df', '-Pk', '/']);

      const clock = await step(hostId, ['date', '-u', '+%s'], { cwd: '/', timeoutMs: 15000, code: 'preflight_failed' });
      const remoteSeconds = Number(String(clock.stdout || '').trim());
      const localSeconds = Math.floor(now() / 1000);
      if (!Number.isFinite(remoteSeconds) || Math.abs(remoteSeconds - localSeconds) > maxClockSkewSec) {
        throw recipeError('preflight_failed', 'Host clock differs from Orbit by more than the allowed skew.');
      }
      steps.push(['date', '-u', '+%s']);

      return { arch, dockerVersion: dockerVersion.join('.'), steps };
    } catch (error) {
      if (error?.code === 'preflight_failed') throw error;
      throw recipeError('preflight_failed', redactAuditText(error?.message || 'Preflight failed.'));
    }
  }

  async function ensureDir(hostId) {
    await step(hostId, ['mkdir', '-p', workDir], { cwd: '/', timeoutMs: 30000 });
  }

  async function writeWorkerFiles(hostId, pairingCode) {
    if (typeof put !== 'function') throw recipeError('recipe_unavailable', 'A host file writer is required.');
    await put(hostId, `${workDir}/compose.yaml`, composeFile(hostId, image), { mode: 0o644 });
    if (pairingCode === null) return;
    if (typeof pairingCode !== 'string' || !SAFE_PAIRING_CODE.test(pairingCode)) {
      throw recipeError('invalid_pairing_code', 'The pairing code is not safe for an env file.');
    }
    await put(hostId, `${workDir}/.env`, envFile(hostId, pairingCode), { mode: 0o600 });
  }

  async function pullAndUp(hostId) {
    // The SSH host module creates the orbit-<hostId> docker context and ssh
    // alias; the recipe only drives compose through it.
    await step(hostId, compose(hostId, ['pull']), { cwd: workDir, timeoutMs: 600000 });
    await step(hostId, compose(hostId, ['up', '-d']), { cwd: workDir, timeoutMs: 300000 });
  }

  async function waitPaired(hostId, params, action) {
    if (typeof waitForPairing !== 'function') throw recipeError('recipe_unavailable', 'A pairing waiter is required.');
    const waited = await waitForPairing({ hostId, recipeId: BUNDLEBEES_WORKER_RECIPE.id, action, timeoutMs: Number(params.pairingTimeoutMs) || 120000 });
    const paired = waited === true || waited?.paired === true || waited?.status === 'paired' || waited?.ok === true;
    if (!paired) throw recipeError('pairing_timeout', 'The worker did not dial out and pair in time.');
    return true;
  }

  async function install(hostId, params) {
    const preflightResult = await preflight(hostId);
    await ensureDir(hostId);
    if (typeof issuePairingCode !== 'function') throw recipeError('recipe_unavailable', 'A pairing-code issuer is required.');
    const issued = await issuePairingCode({ hostId, recipeId: BUNDLEBEES_WORKER_RECIPE.id, action: 'install', purpose: 'worker-pairing' });
    const pairingCode = pairingCodeOf(issued);
    if (!pairingCode) throw recipeError('pairing_unavailable', 'Orbit did not issue a pairing code.');
    await writeWorkerFiles(hostId, pairingCode);
    await pullAndUp(hostId);
    const paired = await waitPaired(hostId, params, 'install');
    log({ hostId, recipeId: BUNDLEBEES_WORKER_RECIPE.id, action: 'install', arch: preflightResult.arch });
    return { hostId, recipeId: BUNDLEBEES_WORKER_RECIPE.id, action: 'install', image, arch: preflightResult.arch, dockerVersion: preflightResult.dockerVersion, paired, ...(issued?.expiresAt ? { pairingExpiresAt: String(issued.expiresAt) } : {}) };
  }

  async function upgrade(hostId, params) {
    const preflightResult = await preflight(hostId);
    await ensureDir(hostId);
    await writeWorkerFiles(hostId, null);
    await pullAndUp(hostId);
    const paired = await waitPaired(hostId, params, 'upgrade');
    log({ hostId, recipeId: BUNDLEBEES_WORKER_RECIPE.id, action: 'upgrade', arch: preflightResult.arch });
    return { hostId, recipeId: BUNDLEBEES_WORKER_RECIPE.id, action: 'upgrade', image, arch: preflightResult.arch, dockerVersion: preflightResult.dockerVersion, paired };
  }

  async function remove(hostId) {
    await step(hostId, compose(hostId, ['down']), { cwd: workDir, timeoutMs: 300000, allowFailure: true });
    await step(hostId, ['rm', '-rf', workDir], { cwd: '/', timeoutMs: 30000 });
    if (typeof revokeWorkerToken !== 'function') throw recipeError('recipe_unavailable', 'A worker-token revoker is required.');
    const revoked = await revokeWorkerToken({ hostId, recipeId: BUNDLEBEES_WORKER_RECIPE.id, action: 'remove' });
    if (revoked === false || revoked?.revoked === false || revoked?.ok === false) throw recipeError('revoke_failed', 'The worker token could not be revoked.');
    log({ hostId, recipeId: BUNDLEBEES_WORKER_RECIPE.id, action: 'remove' });
    return { hostId, recipeId: BUNDLEBEES_WORKER_RECIPE.id, action: 'remove', revoked: true, paired: false };
  }

  async function deploy(hostId, recipeId = BUNDLEBEES_WORKER_RECIPE.id, params = {}) {
    assertHostId(hostId);
    if (recipeId !== BUNDLEBEES_WORKER_RECIPE.id) throw recipeError('recipe_not_found', 'Unknown host recipe.');
    const action = params?.action ?? 'install';
    if (!BUNDLEBEES_WORKER_RECIPE.actions.includes(action)) throw recipeError('invalid_request', 'Unknown recipe action.');
    if (action === 'install') return install(hostId, params);
    if (action === 'upgrade') return upgrade(hostId, params);
    return remove(hostId, params);
  }

  return {
    ids: [BUNDLEBEES_WORKER_RECIPE.id],
    actions: BUNDLEBEES_WORKER_RECIPE.actions,
    has: id => id === BUNDLEBEES_WORKER_RECIPE.id,
    deploy,
    run: deploy,
    install: (hostId, params = {}) => deploy(hostId, BUNDLEBEES_WORKER_RECIPE.id, { ...params, action: 'install' }),
    upgrade: (hostId, params = {}) => deploy(hostId, BUNDLEBEES_WORKER_RECIPE.id, { ...params, action: 'upgrade' }),
    remove: (hostId, params = {}) => deploy(hostId, BUNDLEBEES_WORKER_RECIPE.id, { ...params, action: 'remove' }),
    preflight,
  };
}
