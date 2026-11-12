/** Pure Colab CLI planning. No process spawn and no credential reads. */

export const COST_WARNING = 'This allocates a billed Colab VM. Compute units are spent until the session is stopped, including while it sits idle. Availability depends on the Colab plan for the signed-in account. Stopping Orbit does not stop the VM.';
export const STOP_WARNING = 'Stopping releases this VM and interrupts code that is still running on it. Download outputs you need before stopping.';

/** Runtimes named by google-colab-cli. A live `colab help new` replaces this list. */
export const DOCUMENTED_RUNTIMES = [
  { id: 'cpu', kind: 'cpu', label: 'CPU', gpu: null, tpu: null, highMem: true, note: 'CLI default. No accelerator flag.' },
  { id: 'T4', kind: 'gpu', label: 'NVIDIA T4', gpu: 'T4', tpu: null, highMem: true, note: '' },
  { id: 'L4', kind: 'gpu', label: 'NVIDIA L4', gpu: 'L4', tpu: null, highMem: false, note: 'One machine shape. The CLI ignores --high-mem.' },
  { id: 'A100', kind: 'gpu', label: 'NVIDIA A100', gpu: 'A100', tpu: null, highMem: true, note: '' },
  { id: 'H100', kind: 'gpu', label: 'NVIDIA H100', gpu: 'H100', tpu: null, highMem: true, note: '' },
  { id: 'G4', kind: 'gpu', label: 'NVIDIA G4', gpu: 'G4', tpu: null, highMem: true, note: 'RTX PRO 6000 Blackwell, 96GB, when the account is entitled.' },
  { id: 'v5e1', kind: 'tpu', label: 'TPU v5e1', gpu: null, tpu: 'v5e1', highMem: false, note: 'One machine shape. The CLI ignores --high-mem.' },
  { id: 'v6e1', kind: 'tpu', label: 'TPU v6e1', gpu: null, tpu: 'v6e1', highMem: false, note: 'One machine shape. The CLI ignores --high-mem.' },
];

export const PRESETS = [{
  id: 'training-run',
  title: 'Training run',
  detail: 'Create a session on the runtime you pick, upload files, optionally install packages, execute a script or notebook, then download outputs and stop.',
  suggestedAccelerator: 'G4',
  example: 'LoRA SFT of Qwen/Qwen3-8B for mojomast/velvetrp fits a G4 (RTX PRO 6000 Blackwell, 96GB). The same preset runs on any runtime this CLI accepts.',
}];

const SESSION_LINE = /^\[([^\]]+)\]\s+(\S+)\s+\|\s+Hardware:\s+([^|]+?)\s+\|\s+Shape:\s+([^|]+?)\s+\|\s+Variant:\s+([^|]+?)(?:\s+\|\s+Status:\s+(.+))?$/;
const TOKEN_TEXT = /ya29\.[A-Za-z0-9_\-]+|(?:access_token|id_token|refresh_token|client_secret)"?\s*[:=]\s*"?[^"\s,}&]+|Bearer\s+[A-Za-z0-9._\-]+|([?&#](?:access_token|token|key|secret)=)[^&\s#]+/gi;

export function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function redactSecrets(text) {
  return String(text ?? '').replace(TOKEN_TEXT, (match, query) => query ? `${query}[redacted]` : '[redacted]');
}

export function stripAnsi(text) {
  return String(text ?? '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '');
}

export function sessionName(value) {
  const name = String(value ?? '');
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(name)) throw fail('Session name must start with a letter and use letters, numbers, _ or -.');
  return name;
}

export function remotePath(value, fallback = '') {
  const raw = value === undefined || value === null || value === '' ? fallback : String(value);
  if (!raw || raw.length > 512 || /[\u0000\r\n]/.test(raw) || raw.startsWith('-') || raw.includes('..')) throw fail('Remote path is not allowed.');
  return raw;
}

export function safeBasename(value) {
  const name = String(value ?? '').split(/[/\\]/).pop();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name)) throw fail('File name is not allowed.');
  return name;
}

export function blockedLocalPath(file) {
  const value = String(file || '').replaceAll('\\', '/');
  return /(^|\/)token\.json$/i.test(value)
    || /(^|\/)session-token$/.test(value)
    || /\/\.config\/colab-cli(\/|$)/.test(value)
    || /\/\.ssh(\/|$)/.test(value)
    || /(^|\/)credentials\.json$/i.test(value)
    || /(^|\/)id_rsa$/.test(value)
    || /service-account/i.test(value);
}

export function packageName(value) {
  const name = String(value ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._+\-[\],=<>!~]{0,80}$/.test(name) || name.startsWith('-')) throw fail(`Package name is not allowed: ${name.slice(0, 40)}`);
  return name;
}

export function timeoutSeconds(value, fallback) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(number) || number < 1 || number > 86400) throw fail('Timeout must be from 1 to 86400 seconds.');
  return Math.round(number);
}

function flag(value) {
  if (value !== true) throw fail('Confirmation is required.');
}

export function parseAcceleratorHelp(text) {
  const source = String(text || '');
  const gpu = /GPU accelerator[\s\S]{0,500}?Supported:\s*([A-Za-z0-9, _.-]+)/i.exec(source);
  const tpu = /TPU accelerator[\s\S]{0,500}?Supported:\s*([A-Za-z0-9, _.-]+)/i.exec(source);
  const split = chunk => String(chunk || '').split(',').map(part => part.trim().replace(/[.\s]+$/g, '')).filter(part => /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(part));
  return { gpus: split(gpu?.[1]), tpus: split(tpu?.[1]) };
}

export function catalogFromHelp(text) {
  const found = parseAcceleratorHelp(text);
  if (!found.gpus.length && !found.tpus.length) {
    return { runtimes: DOCUMENTED_RUNTIMES.map(runtime => ({ ...runtime, source: 'documented' })), discovered: false };
  }
  const runtimes = [{ ...DOCUMENTED_RUNTIMES[0], source: 'cli' }];
  for (const name of found.gpus) {
    const known = DOCUMENTED_RUNTIMES.find(runtime => runtime.gpu?.toLowerCase() === name.toLowerCase());
    runtimes.push(known
      ? { ...known, gpu: name, id: known.id, source: 'cli' }
      : { id: name, kind: 'gpu', label: name, gpu: name, tpu: null, highMem: true, note: 'Reported by colab help.', source: 'cli' });
  }
  for (const name of found.tpus) {
    const known = DOCUMENTED_RUNTIMES.find(runtime => runtime.tpu?.toLowerCase() === name.toLowerCase());
    runtimes.push(known
      ? { ...known, source: 'cli' }
      : { id: name, kind: 'tpu', label: `TPU ${name}`, gpu: null, tpu: name, highMem: false, note: 'Reported by colab help.', source: 'cli' });
  }
  return { runtimes, discovered: true };
}

export function runtimeById(catalog, id) {
  const runtime = (catalog || DOCUMENTED_RUNTIMES).find(item => item.id === id);
  if (!runtime) throw fail('Unknown runtime. Refresh the accelerator list.');
  return runtime;
}

export function acceleratorArgs(runtime, highMem) {
  const args = [];
  if (runtime.gpu) args.push('--gpu', runtime.gpu);
  if (runtime.tpu) args.push('--tpu', runtime.tpu);
  if (highMem) {
    if (!runtime.highMem) throw fail('--high-mem does not apply to this runtime.');
    args.push('--high-mem');
  }
  return args;
}

export function parseUsage(text) {
  const raw = redactSecrets(text).trim();
  const balance = /Current balance:\s*([0-9]+(?:\.[0-9]+)?)\s*compute units/i.exec(raw);
  const rate = /Usage rate:\s*([0-9]+(?:\.[0-9]+)?)\/hr/i.exec(raw);
  const count = /Active assignments:\s*([0-9]+)/i.exec(raw);
  if (!balance || !rate || !count) return { balance: null, ratePerHour: null, assignments: null, raw };
  return { balance: Number(balance[1]), ratePerHour: Number(rate[1]), assignments: Number(count[1]), raw };
}

export function parseSessions(text) {
  const raw = redactSecrets(text).trim();
  const sessions = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = SESSION_LINE.exec(line.trim());
    if (!match) continue;
    sessions.push({
      name: match[1] === '?' ? '' : match[1],
      orphan: match[1] === '?',
      hardware: match[3],
      shape: match[4],
      variant: match[5],
      status: match[6] || '',
    });
  }
  return { sessions, empty: /No active sessions/i.test(raw), raw };
}

export function parseStatus(text) {
  const parsed = parseSessions(text);
  const last = /Last Execution:\s*(.+)/.exec(parsed.raw);
  return { ...parsed, lastExecution: last ? last[1].trim() : '' };
}

export function parseVersion(text) {
  const match = /Version:\s*(\S+)/.exec(String(text || ''));
  return match ? match[1] : '';
}

export function parseLs(text) {
  const raw = redactSecrets(text).trim();
  if (/\[colab\] Error:/i.test(raw)) return { entries: [], raw, error: raw };
  const entries = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean).filter(line => !line.startsWith('[colab]')).map(name => ({
    name: name.endsWith('/') ? name.slice(0, -1) : name,
    directory: name.endsWith('/'),
  })).filter(entry => entry.name && !entry.name.includes('/') && !entry.name.startsWith('.'));
  return { entries, raw, error: '' };
}

export function parseNvidiaSmi(text) {
  const gpus = [];
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    const parts = line.split(',').map(part => part.trim()).filter(part => part && !part.startsWith('[colab]') && part !== 'exit');
    if (parts.length < 4) continue;
    const utilization = Number(parts[1]);
    const memoryUsedMiB = Number(parts[2]);
    const memoryTotalMiB = Number(parts[3]);
    if (!parts[0] || !Number.isFinite(utilization) || !Number.isFinite(memoryUsedMiB) || !Number.isFinite(memoryTotalMiB)) continue;
    const temperature = Number(parts[4]);
    gpus.push({
      name: parts[0].slice(0, 80),
      utilization,
      memoryUsedMiB,
      memoryTotalMiB,
      temperature: Number.isFinite(temperature) ? temperature : null,
    });
  }
  return gpus;
}

export function imageMarkers(text) {
  const found = [];
  const pattern = /\[Image saved to:\s*([^\]]+)\]/g;
  let match;
  while ((match = pattern.exec(String(text || '')))) found.push(match[1].trim());
  return found;
}

/** Fold carriage returns, backspace and simple cursor controls into visible lines. */
export function collapseTerminal(text) {
  const lines = [''];
  let row = 0;
  let col = 0;
  const chars = line => Array.from(line);
  const ensure = next => { while (lines.length <= next) lines.push(''); };
  const write = ch => {
    ensure(row);
    const current = chars(lines[row]);
    while (current.length < col) current.push(' ');
    current[col] = ch;
    lines[row] = current.join('');
    col += 1;
  };
  const source = String(text ?? '');
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '\n') { row += 1; col = 0; ensure(row); continue; }
    if (ch === '\r') { col = 0; continue; }
    if (ch === '\b') { col = Math.max(0, col - 1); continue; }
    if (ch === '\u001b' && source[index + 1] === '[') {
      index += 2;
      let params = '';
      while (index < source.length && (source[index] < '@' || source[index] > '~')) { params += source[index]; index += 1; }
      const command = source[index] || '';
      const amount = Number(params.split(';').pop()) || 1;
      if (command === 'A') row = Math.max(0, row - amount);
      else if (command === 'B') { row += amount; ensure(row); }
      else if (command === 'C') col += amount;
      else if (command === 'D') col = Math.max(0, col - amount);
      else if (command === 'K') lines[row] = chars(lines[row] || '').slice(0, col).join('');
      else if (command === 'G') col = Math.max(0, amount - 1);
      continue;
    }
    if (ch === '\u001b') continue;
    if (ch < ' ' && ch !== '\t') continue;
    if (ch === '\t') { const width = 8 - (col % 8); for (let step = 0; step < width; step += 1) write(' '); continue; }
    write(ch);
  }
  return lines.join('\n').replace(/[ \t]+$/gm, '');
}

export function publicRuntime(runtime) {
  return {
    id: runtime.id,
    kind: runtime.kind,
    label: runtime.label,
    highMem: runtime.highMem,
    note: runtime.note || '',
    source: runtime.source || 'documented',
  };
}

export function planCommand(body, catalog) {
  const action = String(body?.action || '');
  const session = body?.session ? sessionName(body.session) : '';
  const withSession = args => session ? [...args.slice(0, 1), '-s', session, ...args.slice(1)] : args;
  if (action === 'usage') return { args: ['usage'], timeoutMs: 30000 };
  if (action === 'sessions') return { args: ['sessions'], timeoutMs: 30000 };
  if (action === 'status') return { args: withSession(['status']), timeoutMs: 30000 };
  if (action === 'version') return { args: ['version'], timeoutMs: 20000 };
  if (action === 'discover') return { args: ['help', 'new'], timeoutMs: 20000 };
  if (action === 'url') {
    if (!session) throw fail('Session is required.');
    return { args: ['url', '-s', session], timeoutMs: 30000 };
  }
  if (action === 'create' || action === 'new') {
    flag(body.confirm_cost);
    if (!session) throw fail('Session is required.');
    const runtime = runtimeById(catalog, String(body.accelerator || 'cpu'));
    return { args: ['new', '-s', session, ...acceleratorArgs(runtime, body.high_mem === true)], timeoutMs: 180000, cost: true };
  }
  if (action === 'stop') {
    flag(body.confirm_stop);
    if (!session) throw fail('Session is required.');
    return { args: ['stop', '-s', session], timeoutMs: 60000 };
  }
  if (action === 'restart-kernel') {
    if (!session) throw fail('Session is required.');
    return { args: ['restart-kernel', '-s', session], timeoutMs: 60000 };
  }
  if (action === 'ls') {
    if (!session) throw fail('Session is required.');
    return { args: ['ls', '-s', session, remotePath(body.path, '/content')], timeoutMs: 30000 };
  }
  if (action === 'rm') {
    flag(body.confirm);
    if (!session) throw fail('Session is required.');
    return { args: ['rm', '-s', session, remotePath(body.path)], timeoutMs: 30000 };
  }
  if (action === 'upload') {
    if (!session) throw fail('Session is required.');
    return { args: ['upload', '-s', session, body.local_path, remotePath(body.remote)], timeoutMs: 180000 };
  }
  if (action === 'download') {
    if (!session) throw fail('Session is required.');
    return { args: ['download', '-s', session, remotePath(body.remote), body.local_path], timeoutMs: 180000 };
  }
  if (action === 'install') {
    if (!session) throw fail('Session is required.');
    const packages = Array.isArray(body.packages) ? body.packages.map(packageName) : [];
    if (!packages.length && !body.requirement) throw fail('Name at least one package or a requirements file.');
    if (packages.length > 40) throw fail('Too many packages.');
    const args = ['install', '-s', session];
    if (body.requirement) args.push('-r', body.requirement);
    args.push(...packages);
    const timeout = timeoutSeconds(body.timeout, 1800);
    return { args, timeoutMs: timeout * 1000, silenceMs: timeout * 1000, background: true };
  }
  if (action === 'exec') {
    if (!session) throw fail('Session is required.');
    if (!body.file) throw fail('A script or notebook file is required.');
    const timeout = timeoutSeconds(body.timeout, 3600);
    const args = ['exec', '-s', session, '-f', body.file, '--timeout', String(timeout)];
    const env = envArgs(body.env);
    for (const pair of env) args.push('--env', pair);
    return { args, timeoutMs: 86400000, silenceMs: (timeout + 30) * 1000, background: true };
  }
  if (action === 'run') {
    flag(body.confirm_cost);
    if (!body.file) throw fail('A Python script is required.');
    const runtime = runtimeById(catalog, String(body.accelerator || 'cpu'));
    const timeout = timeoutSeconds(body.timeout, 3600);
    const name = session || '';
    const args = ['run', ...acceleratorArgs(runtime, body.high_mem === true), '--timeout', String(timeout)];
    if (name) args.push('-s', name);
    if (body.keep === true) args.push('--keep');
    const scriptArgs = Array.isArray(body.script_args) ? body.script_args.map(arg => {
      const text = String(arg);
      if (!text || text.length > 200 || /[\u0000\r\n]/.test(text)) throw fail('Script argument is not allowed.');
      return text;
    }) : [];
    if (scriptArgs.length > 40) throw fail('Too many script arguments.');
    args.push(body.file, ...scriptArgs);
    return { args, timeoutMs: 86400000, silenceMs: (timeout + 45) * 1000, background: true, cost: true };
  }
  if (action === 'repl') {
    if (!session) throw fail('Session is required.');
    const code = String(body.code || '');
    if (!code.trim() || code.length > 200000) throw fail('REPL code is missing or too large.');
    return { args: ['repl', '-s', session], stdin: code, timeoutMs: 120000, silenceMs: 120000, background: true };
  }
  if (action === 'console') {
    if (!session) throw fail('Session is required.');
    const command = String(body.command || '');
    if (!command.trim() || command.length > 4000 || /[\u0000]/.test(command)) throw fail('Console command is missing or too large.');
    return { args: ['console', '-s', session], stdin: command.endsWith('\n') ? command : `${command}\n`, timeoutMs: 120000, silenceMs: 120000, background: true };
  }
  if (action === 'drivemount') {
    if (!session) throw fail('Session is required.');
    return { args: ['drivemount', '-s', session, remotePath(body.path, '/content/drive')], stdin: null, leaveStdinOpen: true, timeoutMs: 600000, silenceMs: 600000, background: true };
  }
  if (action === 'vm-auth') {
    if (!session) throw fail('Session is required.');
    return { args: ['auth', '-s', session], stdin: null, leaveStdinOpen: true, timeoutMs: 600000, silenceMs: 600000, background: true };
  }
  if (action === 'log') {
    if (!session) throw fail('Session is required.');
    const args = ['log', '-s', session];
    if (body.lines !== undefined && body.lines !== null && body.lines !== '') {
      const lines = Number(body.lines);
      if (!Number.isInteger(lines) || lines < 1 || lines > 5000) throw fail('Log line count must be from 1 to 5000.');
      args.push('-n', String(lines));
    }
    if (body.event_type) {
      const type = String(body.event_type);
      if (!/^[a-z0-9_-]{1,40}$/.test(type)) throw fail('Log type is not allowed.');
      args.push('-t', type);
    }
    if (body.output) args.push('-o', body.output);
    return { args, timeoutMs: 60000 };
  }
  if (action === 'gpu') {
    if (!session) throw fail('Session is required.');
    return {
      args: ['console', '-s', session],
      stdin: 'nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits\n',
      timeoutMs: 25000,
      silenceMs: 25000,
    };
  }
  if (action === 'update-check') return { args: ['update'], timeoutMs: 30000 };
  throw fail('Unknown Colab action.');
}

function envArgs(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) throw fail('Environment list is not allowed.');
  return value.map(entry => {
    const text = String(entry);
    const cut = text.indexOf('=');
    if (cut < 1) throw fail('Environment entries must be KEY=VALUE.');
    const key = text.slice(0, cut);
    const stored = text.slice(cut + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(key)) throw fail('Environment name is not allowed.');
    if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY/i.test(key)) throw fail('Refusing to forward a credential environment variable.');
    if (stored.length > 512 || /[\u0000\r\n]/.test(stored)) throw fail('Environment value is not allowed.');
    return `${key}=${stored}`;
  });
}

export function colabEnvironment(bin, home, extraPath = '') {
  const directory = String(bin).includes('/') ? bin.slice(0, bin.lastIndexOf('/')) : '';
  const pieces = [];
  for (const part of [directory, '/usr/local/bin', '/usr/bin', '/bin']) if (part && !pieces.includes(part)) pieces.push(part);
  for (const part of String(extraPath || '').split(':')) {
    if (!part || !part.startsWith('/') || part.includes('\0') || blockedLocalPath(part)) continue;
    if (!pieces.includes(part)) pieces.push(part);
  }
  return {
    HOME: home,
    PATH: pieces.join(':'),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TERM: 'xterm-256color',
    TMPDIR: '/tmp',
    PYTHONDONTWRITEBYTECODE: '1',
  };
}
