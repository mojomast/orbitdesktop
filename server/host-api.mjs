import path from 'node:path';
import { createHostAudit, redactAuditText } from './host-audit.mjs';
import { createHostRecipes, BUNDLEBEES_WORKER_IMAGE } from './host-recipes.mjs';

/**
 * Orbit's host API for agents.
 *
 * Agents never receive SSH keys, Orbit's generated ssh_config or tailcat
 * addresses. They call hosts.list / hosts.run / hosts.put / hosts.deploy and
 * Orbit applies a per-agent, per-host permission level:
 *
 *   none    no actions (the host remains visible as a sanitized card)
 *   read    status/log reads only
 *   deploy  named recipes and an allow-list of provisioning commands
 *   admin   raw argv, with an approval for destructive commands
 *
 * Every executed command is appended to the per-host hash-chained audit log.
 * Destructive commands are never run until the injected approval channel
 * returns an authenticated owner decision for the exact host, agent and argv:
 * an object `{ approved: true, id: <non-empty string>, authenticated: true }`.
 * Every other outcome is a refusal, including a bare id string, `true`,
 * `{ status: 'approved' }`, `{ decision: 'approve' }`, an approval object
 * without `authenticated: true` or an id, malformed objects, null/undefined,
 * thrown errors and timeouts. Refusals are audited with a reason code
 * (`not_approved`, `approval_timeout`, `approval_unavailable` or
 * `approval_malformed`) and are never executed.
 *
 * UNTESTED: the tailcat ProxyCommand transport is owned by the SSH host module
 * and is not exercised here.
 * UNTESTED: remote authorized_keys cleanup on host removal is owned by the SSH
 * host module and is not executed by this API.
 */

const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LEVELS = new Set(['none', 'read', 'deploy', 'admin']);
const MAX_ARGV = 64;
const MAX_ARG_BYTES = 8192;
const MAX_CONTENT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_TAIL_CHARS = 2048;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 120000;
const MINIMAL_ENV = Object.freeze({
  PATH: '/usr/local/bin:/usr/bin:/bin',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
});

function hostError(code, message, status = 403) {
  const error = new Error(message || code);
  error.code = code;
  error.status = status;
  return error;
}

function assertHostId(hostId) {
  if (typeof hostId !== 'string' || !HOST_ID.test(hostId) || hostId === '.' || hostId === '..') {
    throw hostError('invalid_host', 'Invalid host id.', 400);
  }
  return hostId;
}

function agentOf(value) {
  const agent = typeof value === 'string' ? value.trim() : '';
  return AGENT_ID.test(agent) ? agent : '';
}

function binaryOf(argv) {
  return path.posix.basename(String(argv[0] || '')).toLowerCase();
}

function includesAny(argv, values) {
  return argv.some(value => values.includes(String(value).toLowerCase()));
}

function validateArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGV) {
    throw hostError('invalid_request', 'argv must be a non-empty array.', 400);
  }
  let bytes = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (typeof value !== 'string') throw hostError('invalid_request', 'Each argv entry must be a string.', 400);
    if (index === 0 && value.length === 0) throw hostError('invalid_request', 'The command cannot be empty.', 400);
    if (value.includes('\u0000')) throw hostError('invalid_request', 'argv cannot contain NUL bytes.', 400);
    bytes += Buffer.byteLength(value);
    if (bytes > MAX_ARG_BYTES) throw hostError('invalid_request', 'argv is too large.', 400);
  }
  return argv.map(value => value);
}

function dockerWords(argv) {
  let index = 1;
  while (index < argv.length) {
    const value = argv[index];
    if (value === '--context' || value === '-H' || value === '--host' || value === '--config' || value === '--log-level') {
      index += 2;
      continue;
    }
    if (value.startsWith('--context=') || value.startsWith('--host=') || value.startsWith('--config=') || value.startsWith('--log-level=')) {
      index += 1;
      continue;
    }
    if (value.startsWith('-')) {
      index += 1;
      continue;
    }
    return { command: value, rest: argv.slice(index + 1) };
  }
  return { command: '', rest: [] };
}

function composeAction(rest) {
  let index = 0;
  while (index < rest.length) {
    const value = rest[index];
    if (['-p', '--project-name', '-f', '--file', '--env-file', '--profile'].includes(value)) {
      index += 2;
      continue;
    }
    if (value.startsWith('-')) {
      index += 1;
      continue;
    }
    return value;
  }
  return '';
}

function composeProject(rest) {
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '-p' || rest[index] === '--project-name') return rest[index + 1];
    if (rest[index].startsWith('--project-name=')) return rest[index].slice('--project-name='.length);
  }
  return null;
}

function unitIsOrbit(unit) {
  return typeof unit === 'string' && /^orbit-[A-Za-z0-9._@-]+$/.test(unit);
}

function hasRecursiveFlag(argv) {
  return argv.slice(1).some(value => value === '--recursive' || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(value));
}

function sudoAllowed(argv) {
  if (binaryOf(argv) !== 'sudo') return true;
  const rest = argv.slice(1).filter(value => value !== '-n');
  const command = rest[0] ? path.posix.basename(rest[0]).toLowerCase() : '';
  if (command === 'systemctl') {
    const action = rest[1];
    const unit = rest[2];
    return ['status', 'is-active', 'restart', 'start', 'stop'].includes(action) && unitIsOrbit(unit);
  }
  if (command === 'install') return rest.slice(1).some(value => value.startsWith('/opt/orbit/')) || rest.at(-1)?.startsWith('/opt/orbit/');
  if (command === 'mkdir') return rest.slice(1).every(value => !value.startsWith('/') || value === '/opt/orbit' || value.startsWith('/opt/orbit/'));
  return false;
}

function writesOutsideOrbit(argv) {
  const command = binaryOf(argv);
  const absoluteTargets = () => argv.slice(1).filter(value => value.startsWith('/')).filter(value => !pathUnderOrbit(value));
  if (command === 'dd') return argv.slice(1).some(value => value.startsWith('of=/') && !pathUnderOrbit(value.slice(3)));
  if (command === 'sed') return argv.some(value => value === '-i' || value.startsWith('-i')) && absoluteTargets().length > 0;
  if (['cp', 'mv'].includes(command)) {
    const target = argv.at(-1);
    return typeof target === 'string' && target.startsWith('/') && !pathUnderOrbit(target);
  }
  if (['install', 'touch', 'truncate'].includes(command)) {
    const target = argv.at(-1);
    return typeof target === 'string' && target.startsWith('/') && !pathUnderOrbit(target);
  }
  if (['mkdir', 'chmod', 'chown', 'ln', 'tee'].includes(command)) return absoluteTargets().length > 0;
  return false;
}

function isDestructive(argv) {
  const command = binaryOf(argv);
  const rest = argv.slice(1);
  if (writesOutsideOrbit(argv)) return true;
  if (command === 'rm' && hasRecursiveFlag(argv)) return true;
  if (command === 'docker') {
    const { command: sub, rest: dockerRest } = dockerWords(argv);
    if (sub === 'system' && dockerRest[0] === 'prune') return true;
    if (sub === 'volume' && dockerRest[0] === 'rm') return true;
    if ((sub === 'rm' || sub === 'rmi') && dockerRest.length > 0) return true;
    if (sub === 'compose') {
      const action = composeAction(dockerRest);
      if (action === 'down' && includesAny(dockerRest, ['-v', '--volumes'])) return true;
    }
  }
  if (['reboot', 'shutdown', 'poweroff', 'halt', 'userdel'].includes(command)) return true;
  if (['iptables', 'ip6tables', 'ufw', 'nft', 'nftables'].includes(command)) return true;
  if (command === 'mkfs' || command.startsWith('mkfs.')) return true;
  if (command === 'dd' && rest.some(value => /^of=\/dev\//.test(value))) return true;
  const packageAction = rest.find(value => !value.startsWith('-'));
  if (['apt', 'apt-get'].includes(command) && ['remove', 'purge', 'autoremove'].includes(packageAction)) return true;
  if (['yum', 'dnf'].includes(command) && ['remove', 'erase', 'autoremove'].includes(packageAction)) return true;
  if (command === 'apk' && packageAction === 'del') return true;
  if (command === 'pacman' && rest.some(value => /^-[A-Za-z]*R/.test(value))) return true;
  if (command === 'sudo' && !sudoAllowed(argv)) return true;
  return false;
}

function pathUnderOrbit(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return false;
  const resolved = path.posix.resolve('/', value);
  return resolved === '/opt/orbit' || resolved.startsWith('/opt/orbit/');
}

function remotePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\u0000')) {
    throw hostError('invalid_request', 'A safe absolute remote path is required.', 400);
  }
  if (!value.startsWith('/')) throw hostError('invalid_request', 'Remote paths must be absolute.', 400);
  const resolved = path.posix.resolve('/', value);
  if (resolved !== value.replace(/\/+$/, '') || value.split('/').includes('..')) {
    throw hostError('invalid_request', 'Remote path traversal is not allowed.', 400);
  }
  return resolved;
}

function isReadAllowed(argv) {
  const command = binaryOf(argv);
  if (['uptime', 'date', 'uname', 'df', 'free', 'id', 'hostname', 'whoami', 'ps'].includes(command)) return true;
  if (command === 'docker') {
    const { command: sub, rest } = dockerWords(argv);
    if (['ps', 'info', 'version', 'inspect', 'logs'].includes(sub)) return true;
    if (sub === 'stats' && rest.includes('--no-stream')) return true;
    if (sub === 'compose') {
      const action = composeAction(rest);
      return ['ps', 'logs', 'config'].includes(action);
    }
    return false;
  }
  if (command === 'systemctl') {
    const action = argv[1];
    return ['status', 'is-active'].includes(action) && unitIsOrbit(argv[2]);
  }
  if (command === 'journalctl') {
    const unitIndex = argv.findIndex(value => value === '-u' || value === '--unit');
    return unitIndex > 0 && unitIsOrbit(argv[unitIndex + 1]);
  }
  if (command === 'test') return argv.length === 3 && argv[1] === '-d' && pathUnderOrbit(argv[2]);
  return false;
}

function isDeployAllowed(argv) {
  if (isReadAllowed(argv)) return true;
  const command = binaryOf(argv);
  if (command === 'docker') {
    const { command: sub, rest } = dockerWords(argv);
    if (sub === 'pull') {
      const image = rest.find(value => !value.startsWith('-'));
      return typeof image === 'string' && /@sha256:[a-f0-9]{64}$/.test(image) && image.includes('orbit-worker');
    }
    if (sub === 'compose') {
      const action = composeAction(rest);
      if (!['pull', 'up', 'down', 'ps', 'logs', 'config', 'restart', 'start', 'stop'].includes(action)) return false;
      const project = composeProject(rest);
      return project === null || project === 'orbit-worker';
    }
    return false;
  }
  if (command === 'mkdir') {
    const targets = argv.slice(1).filter(value => !value.startsWith('-'));
    return targets.length > 0 && targets.every(pathUnderOrbit);
  }
  if (command === 'install') {
    const target = argv.at(-1);
    return pathUnderOrbit(target);
  }
  if (command === 'systemctl') {
    return ['restart', 'start', 'stop', 'status', 'is-active'].includes(argv[1]) && unitIsOrbit(argv[2]);
  }
  return false;
}

function sanitizeHost(host, permission) {
  const transport = host.transport && typeof host.transport === 'object' ? host.transport : { kind: host.transport };
  const kind = ['direct', 'proxyJump', 'tailscale', 'tailcat', 'cloudflare'].includes(transport.kind) ? transport.kind : 'direct';
  const auth = host.auth && typeof host.auth === 'object' ? host.auth : {};
  const status = host.status && typeof host.status === 'object' ? host.status : typeof host.status === 'string' ? { state: host.status } : {};
  const privilege = host.privilege && typeof host.privilege === 'object' ? host.privilege : {};
  const docker = host.docker && typeof host.docker === 'object' ? host.docker : {};
  const hostKey = host.hostKey && typeof host.hostKey === 'object' ? host.hostKey : {};
  const permissions = host.permissions && typeof host.permissions === 'object' ? host.permissions : {};
  return {
    id: String(host.id || ''),
    label: redactAuditText(String(host.label || host.id || '')),
    address: kind === 'tailcat' ? '' : redactAuditText(String(host.address || '')),
    port: Number.isInteger(host.port) ? host.port : 22,
    user: redactAuditText(String(host.user || 'orbit')),
    tags: Array.isArray(host.tags) ? host.tags.map(value => redactAuditText(String(value))).slice(0, 32) : [],
    roles: Array.isArray(host.roles) ? host.roles.map(value => redactAuditText(String(value))).slice(0, 32) : [],
    transport: {
      kind,
      jumpHostId: typeof transport.jumpHostId === 'string' ? transport.jumpHostId : null,
      cloudflareHostname: typeof transport.cloudflareHostname === 'string' ? redactAuditText(transport.cloudflareHostname) : null,
    },
    auth: {
      kind: typeof auth.kind === 'string' ? auth.kind : 'orbit-key',
      keyId: typeof auth.keyId === 'string' ? auth.keyId : 'orbit-default',
    },
    hostKey: {
      fingerprints: Array.isArray(hostKey.fingerprints) ? hostKey.fingerprints.map(String).slice(0, 8) : [],
      pinnedAt: typeof hostKey.pinnedAt === 'string' ? hostKey.pinnedAt : null,
      verifiedBy: typeof hostKey.verifiedBy === 'string' ? hostKey.verifiedBy : null,
    },
    privilege: {
      sudo: ['none', 'scoped', 'full'].includes(privilege.sudo) ? privilege.sudo : 'none',
      docker: ['group', 'rootless', 'none'].includes(privilege.docker) ? privilege.docker : 'none',
      forcedCommand: privilege.forcedCommand === true,
      terminal: privilege.terminal === true,
    },
    permissions: Object.fromEntries(Object.entries(permissions).map(([key, value]) => [String(key).slice(0, 32), LEVELS.has(value) ? value : 'none'])),
    docker: { context: `orbit-${String(host.id || '')}` },
    status: {
      state: typeof status.state === 'string' ? status.state.toLowerCase() : 'verified',
      lastSeen: typeof status.lastSeen === 'string' ? status.lastSeen : null,
    },
    permission,
    keyInUse: typeof auth.keyId === 'string' ? auth.keyId : 'orbit-default',
  };
}

function safeForAgent(value, depth = 0) {
  if (depth > 8) return null;
  if (typeof value === 'string') return redactAuditText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => safeForAgent(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (/privatekey|sshconfig|tailcat|pairingcode|secret|password|token|keyref/i.test(key)) continue;
      output[key] = safeForAgent(item, depth + 1);
    }
    return output;
  }
  return null;
}

function normalizeOutput(result) {
  const stdoutValue = result?.stdout ?? result?.output ?? '';
  const stdoutRaw = typeof stdoutValue === 'string' ? stdoutValue : Buffer.isBuffer(stdoutValue) ? stdoutValue.toString('utf8') : '';
  const stderrValue = result?.stderr ?? '';
  const stderrRaw = typeof stderrValue === 'string' ? stderrValue : Buffer.isBuffer(stderrValue) ? stderrValue.toString('utf8') : '';
  const outputBytes = Buffer.byteLength(stdoutRaw) + Buffer.byteLength(stderrRaw);
  const stdout = redactAuditText(stdoutRaw);
  const stderr = redactAuditText(stderrRaw);
  const truncated = outputBytes > MAX_OUTPUT_BYTES;
  return {
    stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
    stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
    outputBytes,
    truncated,
    outputTail: `${stdout}${stderr ? `\n${stderr}` : ''}`.slice(-MAX_TAIL_CHARS),
  };
}

export function createHostApi({
  sshHosts,
  audit,
  approvals,
  permissions,
  exec,
  log = () => {},
  runtimeDir,
  now = () => Date.now(),
  agent: defaultAgent = 'agent',
  recipes,
  permissionByAgent,
  issuePairingCode,
  waitForPairing,
  revokeWorkerToken,
  dockerMode = 'context',
  workerImage = BUNDLEBEES_WORKER_IMAGE,
  image,
} = {}) {
  if (!sshHosts || typeof sshHosts !== 'object') throw hostError('invalid_ssh_hosts', 'sshHosts is required.', 500);
  const auditSink = audit || (runtimeDir ? createHostAudit({ runtimeDir, now }) : null);
  const resolver = permissions || permissionByAgent;

  async function getHost(hostId) {
    const id = assertHostId(hostId);
    let record = null;
    const getter = sshHosts.get || sshHosts.getHost || sshHosts.host;
    const lister = sshHosts.list || sshHosts.listHosts;
    if (typeof getter === 'function') record = await getter.call(sshHosts, id);
    else if (typeof lister === 'function') {
      const listed = await lister.call(sshHosts);
      const records = Array.isArray(listed?.hosts) ? listed.hosts : Array.isArray(listed) ? listed : listed instanceof Map ? [...listed.values()] : [];
      record = records.find(item => item?.id === id) || null;
    } else if (sshHosts.hosts && typeof sshHosts.hosts.get === 'function') {
      record = sshHosts.hosts.get(id) || null;
    } else if (sshHosts.hosts && typeof sshHosts.hosts === 'object') {
      record = sshHosts.hosts[id] || null;
    }
    if (record && record.host && typeof record.host === 'object') record = record.host;
    if (!record) throw hostError('not_found', 'Host not found.', 404);
    return { id, record };
  }

  function hostState(host) {
    const raw = host?.status;
    if (typeof raw === 'string') return raw.toLowerCase();
    return String(raw?.state ?? host?.state ?? 'verified').toLowerCase();
  }

  function assertUsable(host) {
    const state = hostState(host);
    if (state === 'key-changed' || state === 'key_changed') throw hostError('host_key_changed', 'The host key changed. Re-verify it in Settings before any action.', 409);
    if (state === 'revoked') throw hostError('host_revoked', 'This host has been revoked.', 409);
  }

  async function permissionFor(agent, hostId, host) {
    if (typeof agent !== 'string' || !AGENT_ID.test(agent)) return 'none';
    let level = null;
    try {
      if (typeof resolver === 'function') {
        level = await resolver({ agent, hostId, host });
        if (!LEVELS.has(level) && resolver.length >= 2) level = await resolver(agent, hostId, host);
      } else if (resolver && typeof resolver.level === 'function') {
        level = await resolver.level({ agent, hostId, host });
        if (!LEVELS.has(level) && resolver.level.length >= 2) level = await resolver.level(agent, hostId, host);
      } else if (resolver && typeof resolver.get === 'function') {
        level = resolver.get(`${agent}:${hostId}`) ?? resolver.get(`${hostId}:${agent}`) ?? resolver.get(agent);
      } else if (resolver && typeof resolver === 'object') {
        level = resolver[agent] ?? resolver[hostId]?.[agent];
      }
    } catch {
      level = null;
    }
    const normalized = typeof level === 'string' ? level.toLowerCase() : level;
    const rawHostLevel = host?.permissions?.[agent];
    const hostLevel = typeof rawHostLevel === 'string' ? rawHostLevel.toLowerCase() : rawHostLevel;
    if (LEVELS.has(normalized)) level = normalized;
    else if (LEVELS.has(hostLevel)) level = hostLevel;
    else level = 'none';
    return level;
  }

  async function appendAudit(record) {
    if (!auditSink) return;
    try {
      if (typeof auditSink.append === 'function') await auditSink.append(record);
      else if (typeof auditSink.write === 'function') await auditSink.write(record);
    } catch (error) {
      throw hostError('audit_unavailable', `The host audit log is unavailable: ${redactAuditText(error?.message || 'write failed')}`, 503);
    }
  }

  async function askApproval({ hostId, host, agent, argv, reason, cwd, timeoutMs }) {
    const request = typeof approvals === 'function' ? approvals : approvals?.request || approvals?.ask || approvals?.requestApproval;
    if (typeof request !== 'function') return { approved: false, id: null, unavailable: true, reason: 'approval_unavailable' };
    const waitMs = Math.min(
      MAX_TIMEOUT_MS,
      Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Math.trunc(Number(timeoutMs)) : DEFAULT_TIMEOUT_MS,
    );
    let result;
    let timer;
    try {
      const pending = Promise.resolve().then(() => request.call(approvals, {
        kind: 'host-command',
        hostId,
        host: String(host?.label || hostId),
        agent,
        argv: argv.slice(),
        exactCommand: argv.join(' '),
        reason,
        cwd: cwd ?? null,
        timeoutMs: waitMs,
      }));
      const expired = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('The approval request timed out.');
          error.code = 'approval_timeout';
          reject(error);
        }, waitMs);
      });
      result = await Promise.race([pending, expired]);
    } catch (error) {
      const timedOut = error?.code === 'approval_timeout';
      return {
        approved: false,
        id: null,
        unavailable: !timedOut,
        timedOut,
        reason: timedOut ? 'approval_timeout' : 'approval_unavailable',
        error,
      };
    } finally {
      clearTimeout(timer);
    }
    let id = null;
    if (typeof result === 'string') {
      id = result || null;
    } else if (result && typeof result === 'object' && !Array.isArray(result)) {
      try {
        const candidate = result.id ?? result.approvalId ?? result.approval_id;
        if (typeof candidate === 'string' && candidate.length > 0) id = candidate;
      } catch {
        return { approved: false, id: null, unavailable: false, reason: 'approval_malformed' };
      }
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return { approved: false, id, unavailable: false, reason: 'not_approved' };
    }
    let approved = false;
    let malformed = false;
    try {
      if (result.approved !== true || result.authenticated !== true) {
        approved = false;
      } else if (result.id === null || result.id === undefined) {
        approved = false;
      } else if (typeof result.id !== 'string' || result.id.trim() === '') {
        malformed = true;
      } else {
        approved = true;
        id = result.id;
      }
    } catch {
      malformed = true;
    }
    if (approved) return { approved: true, id, unavailable: false, reason: null };
    return { approved: false, id, unavailable: false, reason: malformed ? 'approval_malformed' : 'not_approved' };
  }

  async function resolveExec() {
    if (typeof exec === 'function') return exec;
    if (exec && typeof exec === 'object' && typeof exec.exec === 'function') return exec.exec;
    if (exec && typeof exec === 'object' && typeof exec.run === 'function') return exec.run;
    if (typeof sshHosts.exec === 'function') return sshHosts.exec;
    if (typeof sshHosts.run === 'function') return sshHosts.run;
    throw hostError('unsupported', 'No host command runner is configured.', 503);
  }

  function clampTimeout(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return DEFAULT_TIMEOUT_MS;
    return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(number)));
  }

  async function execute({ agent, hostId, argv, options = {}, source = 'agent' }) {
    const id = assertHostId(hostId);
    const args = validateArgv(argv);
    const { record: host } = await getHost(id);
    assertUsable(host);
    const level = await permissionFor(agent, id, host);
    if (level === 'none') throw hostError('permission_denied', 'This agent has no access to the host.', 403);

    if (source === 'recipe') {
      if (level !== 'deploy' && level !== 'admin') throw hostError('permission_denied', 'Deploy or admin access is required for recipes.', 403);
    } else if (level === 'read') {
      if (!isReadAllowed(args)) throw hostError('permission_denied', 'Read access only allows status and log commands.', 403);
    } else if (level === 'deploy') {
      if (!isDeployAllowed(args)) throw hostError('permission_denied', 'This command is not in the deploy allow-list.', 403);
    }

    const destructive = isDestructive(args);
    const cwd = typeof options.cwd === 'string' && options.cwd ? options.cwd : null;
    const timeoutMs = clampTimeout(options.timeout ?? options.timeoutMs);
    let approvalId = null;
    if (destructive) {
      if (level !== 'admin' && !(source === 'recipe' && level === 'deploy')) {
        throw hostError('permission_denied', 'Destructive commands require admin access and owner approval.', 403);
      }
      const approval = await askApproval({ hostId: id, host, agent, argv: args, reason: 'destructive', cwd, timeoutMs });
      approvalId = approval.id;
      if (!approval.approved) {
        const denialReason = approval.reason || (approval.unavailable ? 'approval_unavailable' : 'not_approved');
        await appendAudit({
          time: new Date(now()).toISOString(),
          agent,
          host: id,
          argv: args,
          approvalId,
          exitCode: null,
          durationMs: 0,
          outputBytes: 0,
          outputTail: denialReason,
          reason: denialReason,
          status: 'refused',
        });
        throw hostError(approval.unavailable ? 'approval_required' : 'approval_refused', approval.unavailable ? 'No approval channel is available for this destructive command.' : 'The owner did not approve this command.', 403);
      }
    }

    const runner = await resolveExec();
    const started = now();
    let result;
    try {
      const call = runner(id, args, { cwd, timeout: timeoutMs, timeoutMs, env: { ...MINIMAL_ENV }, signal: AbortSignal.timeout(timeoutMs), ...(options.stdin !== undefined ? { stdin: options.stdin } : {}) });
      let timer;
      const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(hostError('timeout', 'The host command timed out.', 504)), timeoutMs);
      });
      try {
        result = await Promise.race([call, guard]);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      const durationMs = Math.max(0, now() - started);
      const code = typeof error?.code === 'string' && !['ENOENT', 'EACCES', 'ECONNREFUSED', 'ECONNRESET'].includes(error.code)
        ? error.code
        : error?.code === 'timeout' ? 'timeout' : 'host_unreachable';
      await appendAudit({
        time: new Date(now()).toISOString(),
        agent,
        host: id,
        argv: args,
        approvalId,
        exitCode: null,
        durationMs,
        outputBytes: 0,
        outputTail: redactAuditText(error?.message || ''),
        status: 'error',
      });
      throw hostError(code, redactAuditText(error?.message || 'The host command failed.'), code === 'timeout' ? 504 : 502);
    }

    const durationMs = Math.max(0, now() - started);
    const timedOut = result?.timedOut === true || result?.timeout === true;
    const exitCode = timedOut ? null : Number.isFinite(result?.code) ? Math.trunc(result.code) : Number.isFinite(result?.exitCode) ? Math.trunc(result.exitCode) : 0;
    const output = normalizeOutput(result);
    if (timedOut) {
      await appendAudit({
        time: new Date(now()).toISOString(),
        agent,
        host: id,
        argv: args,
        approvalId,
        exitCode: null,
        durationMs,
        outputBytes: output.outputBytes,
        outputTail: output.outputTail,
        status: 'error',
      });
      throw hostError('timeout', 'The host command timed out.', 504);
    }
    await appendAudit({
      time: new Date(now()).toISOString(),
      agent,
      host: id,
      argv: args,
      approvalId,
      exitCode,
      durationMs,
      outputBytes: output.outputBytes,
      outputTail: output.outputTail,
      status: exitCode === 0 ? 'ok' : 'error',
    });
    return {
      hostId: id,
      argv: args.map(value => redactAuditText(value)),
      code: exitCode,
      exitCode,
      stdout: output.stdout,
      stderr: output.stderr,
      durationMs,
      duration: durationMs,
      approvalId,
      truncated: output.truncated,
    };
  }

  async function putInternal({ agent, hostId, file, content, options = {}, source = 'agent' }) {
    const id = assertHostId(hostId);
    const target = remotePath(file);
    const body = typeof content === 'string' ? content : Buffer.isBuffer(content) ? content.toString('utf8') : null;
    if (body === null) throw hostError('invalid_request', 'File content must be text.', 400);
    if (Buffer.byteLength(body) > MAX_CONTENT_BYTES) throw hostError('invalid_request', 'File content is too large.', 400);
    const mode = options.mode === 0o644 ? 0o644 : 0o600;
    const { record: host } = await getHost(id);
    assertUsable(host);
    const level = await permissionFor(agent, id, host);
    if (level === 'none' || level === 'read') throw hostError('permission_denied', 'Deploy or admin access is required to write files.', 403);
    const outside = !pathUnderOrbit(target);
    if (outside && level !== 'admin') throw hostError('permission_denied', 'Deploy access can only write inside /opt/orbit.', 403);

    let approvalId = null;
    if (outside) {
      const approval = await askApproval({ hostId: id, host, agent, argv: ['put', target], reason: 'outside-orbit-write', cwd: null, timeoutMs: 30000 });
      approvalId = approval.id;
      if (!approval.approved) {
        const denialReason = approval.reason || (approval.unavailable ? 'approval_unavailable' : 'not_approved');
        await appendAudit({
          time: new Date(now()).toISOString(),
          agent,
          host: id,
          argv: ['put', target],
          approvalId,
          exitCode: null,
          durationMs: 0,
          outputBytes: 0,
          outputTail: denialReason,
          reason: denialReason,
          status: 'refused',
        });
        throw hostError(approval.unavailable ? 'approval_required' : 'approval_refused', 'Writing outside /opt/orbit needs owner approval.', 403);
      }
    }

    const started = now();
    let written;
    try {
      if (typeof sshHosts.put === 'function') {
        written = await sshHosts.put(id, target, body, { mode });
      } else {
        const result = await execute({
          agent,
          hostId: id,
          argv: ['install', '-m', mode.toString(8), '-D', '/dev/stdin', target],
          options: { cwd: '/', timeout: 30000, stdin: body },
          source: 'recipe',
        });
        if (result.code !== 0) throw hostError('put_failed', 'The host file writer failed.', 502);
        written = { bytes: Buffer.byteLength(body) };
      }
    } catch (error) {
      if (['permission_denied', 'approval_refused', 'approval_required', 'host_key_changed', 'host_revoked', 'audit_unavailable', 'timeout'].includes(error?.code)) throw error;
      const durationMs = Math.max(0, now() - started);
      await appendAudit({
        time: new Date(now()).toISOString(),
        agent,
        host: id,
        argv: ['put', target],
        approvalId,
        exitCode: null,
        durationMs,
        outputBytes: 0,
        outputTail: redactAuditText(error?.message || ''),
        status: 'error',
      });
      throw hostError('put_failed', redactAuditText(error?.message || 'The host file writer failed.'), 502);
    }

    const durationMs = Math.max(0, now() - started);
    const bytes = Number.isFinite(written?.bytes) ? written.bytes : Buffer.byteLength(body);
    await appendAudit({
      time: new Date(now()).toISOString(),
      agent,
      host: id,
      argv: ['put', target],
      approvalId,
      exitCode: 0,
      durationMs,
      outputBytes: bytes,
      outputTail: '',
      status: 'ok',
    });
    return { hostId: id, path: target, bytes, mode, approvalId };
  }

  function recipesFor(agent) {
    if (recipes && typeof recipes.deploy === 'function') return recipes;
    return createHostRecipes({
      dockerMode,
      image: workerImage || image,
      issuePairingCode,
      waitForPairing,
      revokeWorkerToken,
      log,
      now,
      run: (hostId, argv, options) => execute({ agent, hostId, argv, options, source: 'recipe' }),
      put: (hostId, file, content, options) => putInternal({ agent, hostId, file, content, options, source: 'recipe' }),
    });
  }

  async function deployInternal({ agent, hostId, recipeId, params = {} }) {
    const id = assertHostId(hostId);
    if (typeof recipeId !== 'string' || !recipeId) throw hostError('invalid_request', 'A recipe id is required.', 400);
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw hostError('invalid_request', 'Recipe parameters must be an object.', 400);
    const { record: host } = await getHost(id);
    assertUsable(host);
    const level = await permissionFor(agent, id, host);
    if (level !== 'deploy' && level !== 'admin') throw hostError('permission_denied', 'Deploy or admin access is required for recipes.', 403);
    const recipeParams = { ...params };
    delete recipeParams.agent;
    const runner = recipesFor(agent);
    let result;
    try {
      result = await runner.deploy(id, recipeId, recipeParams);
    } catch (error) {
      if (error?.code) throw hostError(error.code, redactAuditText(error?.message || error.code), Number.isInteger(error.status) ? error.status : 502);
      throw hostError('recipe_failed', redactAuditText(error?.message || 'The recipe failed.'), 502);
    }
    return safeForAgent(result);
  }

  function makeView(agent) {
    return {
      async list(options = {}) {
        const actor = agentOf(typeof options === 'string' ? options : options?.agent || agent);
        let records;
        const lister = sshHosts.list || sshHosts.listHosts;
        if (typeof lister === 'function') {
          const listed = await lister.call(sshHosts);
          records = Array.isArray(listed?.hosts) ? listed.hosts : Array.isArray(listed) ? listed : listed instanceof Map ? [...listed.values()] : [];
        } else if (sshHosts.hosts instanceof Map) {
          records = [...sshHosts.hosts.values()];
        } else if (sshHosts.hosts && typeof sshHosts.hosts === 'object') {
          records = Object.values(sshHosts.hosts);
        } else {
          records = [];
        }
        const hosts = [];
        for (const record of records) {
          if (!record || typeof record.id !== 'string') continue;
          const level = await permissionFor(actor, record.id, record);
          hosts.push(sanitizeHost(record, level));
        }
        return { hosts };
      },
      run(hostId, argv, options = {}) {
        return execute({ agent: agentOf(options.agent || agent), hostId, argv, options, source: 'agent' });
      },
      put(hostId, file, content, options = {}) {
        return putInternal({ agent: agentOf(options.agent || agent), hostId, file, content, options, source: 'agent' });
      },
      deploy(hostId, recipeId, params = {}) {
        return deployInternal({ agent: agentOf(params.agent || agent), hostId, recipeId, params });
      },
    };
  }

  const api = {
    hosts: makeView(agentOf(defaultAgent)),
    forAgent(agent) {
      const actor = agentOf(agent);
      const view = makeView(actor);
      return { hosts: view, list: view.list, run: view.run, put: view.put, deploy: view.deploy, forAgent: api.forAgent };
    },
  };
  api.list = api.hosts.list;
  api.run = api.hosts.run;
  api.put = api.hosts.put;
  api.deploy = api.hosts.deploy;
  return api;
}
