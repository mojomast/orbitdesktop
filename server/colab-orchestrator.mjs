/** Google Colab runtimes (colab.research.google.com). This is not Orbit's project board. */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { tokenMatches, allowedRequest } from './security.mjs';
import {
  COST_WARNING, STOP_WARNING, PRESETS, DOCUMENTED_RUNTIMES, blockedLocalPath, catalogFromHelp,
  colabEnvironment, collapseTerminal, fail, imageMarkers, parseLs, parseNvidiaSmi, parseSessions,
  parseStatus, parseUsage, parseVersion, planCommand, publicRuntime, redactSecrets, remotePath,
  safeBasename, sessionName, timeoutSeconds, jobLabel,
} from './colab-plan.mjs';
import {
  ORBIT_FS_PY, ORBIT_REMOTE_PY, applyProgress, connectionLost, emptyProgress, parseFileInfo, parseRemoteTail, remoteFailure,
} from './colab-job-parse.mjs';

const API = '/api/colab-runtime';
const LOG_LIMIT = 64 * 1024 * 1024;
const UPLOAD_LIMIT = 256 * 1024 * 1024;
const TAIL_LIMIT = 256 * 1024;

function defaultBin() {
  if (process.env.ORBIT_COLAB_BIN) return process.env.ORBIT_COLAB_BIN;
  const candidate = '/home/box/.local/bin/colab';
  return fs.existsSync(candidate) ? candidate : 'colab';
}

async function assertLocalFile(file) {
  const requested = path.resolve(String(file || ''));
  if (!path.isAbsolute(requested) || blockedLocalPath(requested)) throw fail('Local path is not allowed.');
  let stat;
  try { stat = await fs.promises.lstat(requested); }
  catch { throw fail('Local file was not found.'); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw fail('Local path must be a regular file.');
  if (stat.size > UPLOAD_LIMIT) throw fail('Local file is too large.');
  const real = await fs.promises.realpath(requested);
  if (blockedLocalPath(real)) throw fail('Local path is not allowed.');
  return real;
}

function readJson(req, max = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > max) { reject(fail('Request too large.', 413)); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(fail('Invalid JSON.')); }
    });
    req.on('error', () => reject(fail('Request failed.')));
  });
}

export function createColabOrchestrator(options = {}) {
  const reply = options.reply;
  const token = options.token || '';
  const port = options.port;
  const devOrigins = options.devOrigins || [];
  const spawnImpl = options.spawn || spawn;
  const supervise = options.supervise !== false && !options.spawn;
  const chunkBytes = options.chunkBytes || 64 * 1024 * 1024;
  const reconnectDelay = options.reconnectDelay ?? 1000;
  const workerPath = fileURLToPath(new URL('./colab-job-worker.mjs', import.meta.url));
  const bin = options.bin || defaultBin();
  const home = options.home || process.env.ORBIT_COLAB_HOME || os.homedir();
  const root = options.root;
  const env = () => colabEnvironment(bin, home, options.pathExtra || process.env.ORBIT_COLAB_PATH || '');
  if (!root) throw fail('Colab orchestrator storage is required.', 500);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let catalog = DOCUMENTED_RUNTIMES.map(runtime => ({ ...runtime, source: 'documented' }));
  let discovered = false;
  const jobs = new Map();
  const children = new Set();
  let stopped = false;

  function authorize(req) {
    if (!allowedRequest(req, port, devOrigins)) return 403;
    const header = req.headers.authorization || '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!tokenMatches(presented, token)) return 401;
    return 0;
  }

  function publicJob(job) {
    return {
      id: job.id,
      action: job.action,
      session: job.session,
      state: job.state,
      exitCode: job.exitCode,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      bytes: job.bytes,
      error: job.error,
      rich: job.rich,
      truncated: job.truncated === true,
      label: job.label || '',
      remote: job.remote === true,
      progress: job.progress || emptyProgress(),
    };
  }

  function remember(job) {
    const meta = {
      ...publicJob(job), log: 'output.log', pid: job.pid || 0, detached: job.detached === true,
      stepIndex: job.stepIndex || 0, stepCount: job.stepCount || 1, notebook: job.notebook || '',
      remotePid: job.remotePid || 0, remoteOffset: job.remoteOffset || 0,
    };
    fs.writeFileSync(path.join(job.dir, 'meta.json'), JSON.stringify(meta), { mode: 0o600 });
  }

  function processAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { return error?.code === 'EPERM'; }
  }

  function loadJobs() {
    const folder = path.join(root, 'jobs');
    if (!fs.existsSync(folder)) return;
    for (const name of fs.readdirSync(folder)) {
      if (!/^[a-f0-9]{24}$/.test(name)) continue;
      try {
        const dir = path.join(folder, name);
        const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
        const logPath = path.join(dir, 'output.log');
        const fileBytes = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
        const detached = meta.detached === true;
        const pid = Number(meta.pid) || 0;
        const job = {
          ...meta,
          id: name,
          dir,
          logPath,
          bytes: fileBytes,
          pid,
          detached,
          stepIndex: Number(meta.stepIndex) || 0,
          stepCount: Number(meta.stepCount) || 1,
          notebook: typeof meta.notebook === 'string' ? meta.notebook : '',
          label: typeof meta.label === 'string' ? meta.label : '',
          remote: meta.remote === true,
          remotePid: Number(meta.remotePid) || 0,
          remoteOffset: Number(meta.remoteOffset) || 0,
          progress: meta.progress && typeof meta.progress === 'object' ? meta.progress : emptyProgress(),
          socket: path.join(dir, 'input.sock'),
          state: meta.state,
          rich: Array.isArray(meta.rich) ? meta.rich : [],
          listeners: new Set(),
          queue: Promise.resolve(),
          carry: '',
          child: null,
          live: false,
          watch: null,
        };
        if (job.state === 'running' && !job.remote && !(detached && pid && processAlive(pid))) job.state = 'interrupted';
        jobs.set(name, job);
        if (job.state === 'running' && job.remote) void followRemote(job);
        else if (job.state === 'running') watchJob(job);
        else if (meta.state === 'running' && detached) void settleDetached(job);
      } catch { /* ignore a damaged job directory */ }
    }
  }
  loadJobs();

  function enqueue(job, fn) {
    job.queue = job.queue.then(fn, fn);
    return job.queue;
  }

  function emit(job, event) {
    for (const listener of job.listeners) {
      try { listener(event); } catch { /* a detached client must not stop the job */ }
    }
  }

  async function appendOutput(job, stream, text) {
    const clean = redactSecrets(text);
    if (!clean) return;
    await enqueue(job, async () => {
      if (job.bytes >= LOG_LIMIT) return;
      let piece = clean;
      if (job.bytes + Buffer.byteLength(piece) > LOG_LIMIT) {
        piece = piece.slice(0, Math.max(0, LOG_LIMIT - job.bytes));
        job.truncated = true;
      }
      const offset = job.bytes;
      await fs.promises.appendFile(job.logPath, piece);
      job.bytes += Buffer.byteLength(piece);
      emit(job, { type: 'data', offset, text: piece, stream });
      const blob = job.carry + piece;
      const marks = imageMarkers(blob);
      const end = marks.length ? blob.lastIndexOf(']') + 1 : Math.max(0, blob.length - 180);
      job.carry = blob.slice(end);
      for (const source of marks) await adoptImage(job, source);
      noteProgress(job, piece);
      if (job.truncated && job.child) {
        try { job.child.kill('SIGTERM'); } catch { /* already gone */ }
      }
    });
  }

  async function adoptImage(job, source) {
    try {
      if (blockedLocalPath(source)) return;
      const real = await fs.promises.realpath(source);
      if (blockedLocalPath(real)) return;
      const stat = await fs.promises.lstat(real);
      if (!stat.isFile() || stat.size <= 0 || stat.size > 20 * 1024 * 1024) return;
      const ext = path.extname(real).toLowerCase();
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext];
      if (!mime) return;
      const name = `plot-${job.rich.length + 1}${ext}`;
      const dest = path.join(job.dir, 'artifacts', name);
      await fs.promises.copyFile(real, dest);
      await fs.promises.chmod(dest, 0o600);
      const rich = { id: name, kind: 'image', mime, name };
      job.rich.push(rich);
      remember(job);
      emit(job, { type: 'rich', rich });
    } catch { /* a missing temp image is not a failed training run */ }
  }

  async function adoptNotebook(job, notebook) {
    if (!notebook || !notebook.endsWith('.ipynb')) return;
    const output = notebook.replace(/\.ipynb$/i, '_output.ipynb');
    let raw;
    try { raw = await fs.promises.readFile(output, 'utf8'); }
    catch { return; }
    let notebookJson;
    try { notebookJson = JSON.parse(raw); }
    catch { return; }
    const artifacts = path.join(job.dir, 'artifacts');
    const added = [];
    let index = job.rich.length;
    for (const cell of notebookJson.cells || []) {
      for (const item of cell.outputs || []) {
        const data = item.data || {};
        for (const [mime, ext] of [['image/png', '.png'], ['image/jpeg', '.jpg']]) {
          if (typeof data[mime] !== 'string') continue;
          index += 1;
          const name = `cell-${index}${ext}`;
          await fs.promises.writeFile(path.join(artifacts, name), Buffer.from(data[mime], 'base64'), { mode: 0o600 });
          const rich = { id: name, kind: 'image', mime, name };
          job.rich.push(rich);
          added.push(rich);
        }
        const html = data['text/html'];
        if (typeof html === 'string' || Array.isArray(html)) {
          index += 1;
          const name = `cell-${index}.html`;
          const body = Array.isArray(html) ? html.join('') : html;
          if (body.length <= 200000) {
            await fs.promises.writeFile(path.join(artifacts, name), body, { mode: 0o600 });
            const rich = { id: name, kind: 'html', mime: 'text/html', name };
            job.rich.push(rich);
            added.push(rich);
          }
        }
      }
    }
    if (added.length) { remember(job); for (const rich of added) emit(job, { type: 'rich', rich }); }
  }

  function startProcess(args, stdio) {
    let child;
    try {
      child = spawnImpl(bin, args, { shell: false, env: env(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      throw fail(error?.code === 'ENOENT' ? 'Colab CLI was not found. Set ORBIT_COLAB_BIN to the colab executable.' : 'Colab CLI could not be started.');
    }
    children.add(child);
    child.on('error', () => {});
    if (stdio.stdin !== undefined && stdio.stdin !== null) child.stdin.end(stdio.stdin);
    else if (!stdio.leaveStdinOpen) child.stdin.end();
    return child;
  }

  function collect(child, job, silenceMs, wallMs) {
    const out = new StringDecoder('utf8');
    const err = new StringDecoder('utf8');
    let silence = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* already exited */ } }, silenceMs);
    silence.unref?.();
    const wall = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* already exited */ } }, wallMs);
    wall.unref?.();
    const bump = () => { clearTimeout(silence); silence = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* already exited */ } }, silenceMs); silence.unref?.(); };
    const bytes = chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    child.stdout.on('data', chunk => { bump(); const text = out.write(bytes(chunk)); if (job && text) void appendOutput(job, 'stdout', text); });
    child.stderr.on('data', chunk => { bump(); const text = err.write(bytes(chunk)); if (job && text) void appendOutput(job, 'stderr', text); });
    return new Promise(resolve => {
      let settled = false;
      const done = (result) => { if (settled) return; settled = true; clearTimeout(silence); clearTimeout(wall); children.delete(child); resolve(result); };
      child.on('error', error => done({ code: 127, signal: null, error: error.code === 'ENOENT' ? 'Colab CLI was not found. Set ORBIT_COLAB_BIN to the colab executable.' : 'Colab CLI could not be started.' }));
      child.on('close', (code, signal) => {
        const stdout = out.end();
        const stderr = err.end();
        if (job) {
          if (stdout) void appendOutput(job, 'stdout', stdout);
          if (stderr) void appendOutput(job, 'stderr', stderr);
        }
        done({ code: code ?? 1, signal, stdout, stderr });
      });
    });
  }

  async function runForeground(plan, owner = null) {
    const child = startProcess(plan.args, plan);
    if (owner) owner.child = child;
    const captured = { out: '', err: '' };
    const decoderOut = new StringDecoder('utf8');
    const decoderErr = new StringDecoder('utf8');
    const silenceMs = plan.silenceMs || plan.timeoutMs;
    let silence = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* already exited */ } }, silenceMs);
    silence.unref?.();
    const wall = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* already exited */ } }, plan.timeoutMs);
    wall.unref?.();
    const bump = () => { clearTimeout(silence); silence = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* already exited */ } }, silenceMs); silence.unref?.(); };
    const bytes = chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    child.stdout.on('data', chunk => { bump(); captured.out += decoderOut.write(bytes(chunk)); if (captured.out.length > 1024 * 1024) captured.out = captured.out.slice(-1024 * 1024); });
    child.stderr.on('data', chunk => { bump(); captured.err += decoderErr.write(bytes(chunk)); if (captured.err.length > 256 * 1024) captured.err = captured.err.slice(-256 * 1024); });
    const result = await new Promise(resolve => {
      let settled = false;
      const done = (value) => { if (settled) return; settled = true; clearTimeout(silence); clearTimeout(wall); children.delete(child); resolve(value); };
      child.on('error', error => done({ code: 127, error: error.code === 'ENOENT' ? 'Colab CLI was not found. Set ORBIT_COLAB_BIN to the colab executable.' : 'Colab CLI could not be started.' }));
      child.on('close', (code, signal) => {
        captured.out += decoderOut.end();
        captured.err += decoderErr.end();
        done({ code: code ?? 1, signal });
      });
    });
    if (owner && owner.child === child) owner.child = null;
    const output = redactSecrets(`${captured.out}${captured.err ? `\n${captured.err}` : ''}`).trim();
    if (result.error && !stopped && !owner?.cancelRequested) throw fail(result.error);
    if (result.code !== 0 && !stopped && !owner?.cancelRequested) throw fail(output || `colab ${plan.args[0]} exited ${result.code}.`);
    return output;
  }

  function createJob(action, session, label = '') {
    if ([...jobs.values()].filter(job => job.state === 'running').length >= 4) throw fail('Four Colab jobs are already running.');
    const id = randomBytes(12).toString('hex');
    const dir = path.join(root, 'jobs', id);
    fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true, mode: 0o700 });
    const job = {
      id, dir, action, session: session || '', state: 'running', exitCode: null, startedAt: new Date().toISOString(),
      endedAt: null, bytes: 0, error: '', rich: [], truncated: false, listeners: new Set(), queue: Promise.resolve(),
      carry: '', child: null, logPath: path.join(dir, 'output.log'), pid: 0, detached: false, live: true,
      stepIndex: 0, stepCount: 1, notebook: '', socket: path.join(dir, 'input.sock'), watch: null,
      label: label || '', remote: false, remotePid: 0, remoteOffset: 0, progress: emptyProgress(), cancelRequested: false,
    };
    fs.writeFileSync(job.logPath, '', { mode: 0o600 });
    jobs.set(id, job);
    remember(job);
    return job;
  }

  async function readLogTail(job) {
    const stat = await fs.promises.stat(job.logPath).catch(() => null);
    if (!stat?.size) return '';
    const take = Math.min(stat.size, 512 * 1024);
    const fh = await fs.promises.open(job.logPath, 'r');
    try {
      const buffer = Buffer.alloc(take);
      await fh.read(buffer, 0, take, stat.size - take);
      return buffer.toString('utf8');
    } finally { await fh.close(); }
  }

  function noteProgress(job, text) {
    const next = applyProgress(job.progress, text);
    if (JSON.stringify(next) === JSON.stringify(job.progress || emptyProgress())) return;
    job.progress = next;
    remember(job);
  }

  async function finishJob(job, code, error, state = '') {
    if (job.state !== 'running' && job.state !== 'interrupted') return;
    await job.queue;
    if (job.state !== 'running' && job.state !== 'interrupted') return;
    if (job.watch) { clearInterval(job.watch); job.watch = null; }
    let nextState = state || (job.truncated ? 'truncated' : 'exited');
    let nextCode = code;
    let nextError = error ? redactSecrets(error).slice(0, 2000) : '';
    if (nextState === 'exited' && (nextCode === 0 || nextCode === null)) {
      const found = remoteFailure(await readLogTail(job));
      if (found.failed) {
        nextState = 'failed';
        nextCode = found.code;
        nextError = nextError || found.summary;
      }
    }
    job.state = nextState;
    job.exitCode = nextCode;
    job.endedAt = new Date().toISOString();
    job.error = nextError;
    job.child = null;
    remember(job);
    emit(job, { type: 'status', job: publicJob(job) });
  }

  function completeUtf8(buffer) {
    let index = buffer.length - 1;
    let continuation = 0;
    while (index >= 0 && continuation < 3 && (buffer[index] & 0xc0) === 0x80) { continuation += 1; index -= 1; }
    if (index < 0) return buffer.length;
    const lead = buffer[index];
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    return buffer.length - index < need ? index : buffer.length;
  }

  async function readGrowth(job) {
    const stat = await fs.promises.stat(job.logPath).catch(() => null);
    if (!stat || stat.size <= job.bytes) return null;
    const take = Math.min(stat.size - job.bytes, 65536);
    const fh = await fs.promises.open(job.logPath, 'r');
    try {
      const buffer = Buffer.alloc(take);
      const { bytesRead } = await fh.read(buffer, 0, take, job.bytes);
      if (!bytesRead) return null;
      const slice = buffer.subarray(0, bytesRead);
      const end = completeUtf8(slice);
      if (!end) return null;
      return { offset: job.bytes, text: slice.subarray(0, end).toString('utf8'), consumed: end };
    } finally { await fh.close(); }
  }

  async function pump(job) {
    await enqueue(job, async () => {
      const chunk = await readGrowth(job);
      if (!chunk) return;
      job.bytes += chunk.consumed;
      emit(job, { type: 'data', offset: chunk.offset, text: chunk.text, stream: 'stdout' });
      const blob = job.carry + chunk.text;
      const marks = imageMarkers(blob);
      const end = marks.length ? blob.lastIndexOf(']') + 1 : Math.max(0, blob.length - 180);
      job.carry = blob.slice(end);
      for (const source of marks) await adoptImage(job, source);
      noteProgress(job, chunk.text);
      remember(job);
    });
  }

  function watchJob(job) {
    if (job.watch) return;
    const timer = setInterval(() => { void pump(job).then(() => { if (!job.live && job.pid && !processAlive(job.pid)) void settleDetached(job); }); }, 300);
    timer.unref?.();
    job.watch = timer;
    void pump(job);
  }

  async function settleDetached(job) {
    if (job.settling || job.live) return;
    job.settling = true;
    try {
      await pump(job);
      const exitPath = path.join(job.dir, 'step-exit.json');
      let exit = null;
      try { exit = JSON.parse(fs.readFileSync(exitPath, 'utf8')); } catch { exit = null; }
      if (processAlive(job.pid) && !exit) return;
      const last = (job.stepIndex || 0) >= (job.stepCount || 1) - 1;
      if (job.notebook) await adoptNotebook(job, job.notebook);
      if (!last) await finishJob(job, exit?.code ?? 1, 'Orbit restarted before the remaining steps. Later steps did not start.', 'interrupted');
      else await finishJob(job, exit?.code ?? 1, exit ? '' : 'Colab step ended without an exit record.');
    } finally { job.settling = false; }
  }

  function launchWorker(job, plan) {
    const exitPath = path.join(job.dir, 'step-exit.json');
    fs.rmSync(exitPath, { force: true });
    const specPath = path.join(job.dir, 'step.json');
    const spec = {
      bin, args: plan.args, log: job.logPath, exit: exitPath,
      silenceMs: plan.silenceMs || plan.timeoutMs, wallMs: plan.timeoutMs,
      stdin: plan.stdin || '', holdStdin: plan.leaveStdinOpen === true,
      socket: plan.leaveStdinOpen ? job.socket : '',
    };
    fs.writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });
    const child = spawn(process.execPath, [workerPath, specPath], {
      detached: true, stdio: 'ignore', env: env(), windowsHide: true,
    });
    child.unref();
    job.pid = child.pid;
    job.detached = true;
    job.child = null;
    remember(job);
    return exitPath;
  }

  function waitExit(exitPath, job) {
    return new Promise(resolve => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (fs.existsSync(exitPath)) {
          clearInterval(timer);
          try { resolve(JSON.parse(fs.readFileSync(exitPath, 'utf8'))); }
          catch { resolve({ code: 1, error: 'Colab step exit record was unreadable.' }); }
          return;
        }
        if (job.pid && !processAlive(job.pid) && Date.now() - started > 1000) {
          clearInterval(timer);
          resolve({ code: 1, error: 'Colab step ended without an exit record.' });
        }
      }, 150);
      timer.unref?.();
    });
  }

  async function runPlan(job, plan, notebook) {
    await appendOutput(job, 'stdout', `[orbit] colab ${plan.args[0]}\n`);
    if (notebook) job.notebook = notebook;
    if (supervise) {
      const exitPath = launchWorker(job, plan);
      watchJob(job);
      const exit = await waitExit(exitPath, job);
      await pump(job);
      if (notebook) await adoptNotebook(job, notebook);
      if (exit.error && !fs.existsSync(exitPath)) throw fail(exit.error);
      if ((exit.code ?? 1) !== 0) throw fail(`colab ${plan.args[0]} exited ${exit.code}.`);
      return exit;
    }
    const child = startProcess(plan.args, plan);
    job.child = child;
    const result = await collect(child, job, plan.silenceMs || plan.timeoutMs, plan.timeoutMs);
    await job.queue;
    if (notebook) await adoptNotebook(job, notebook);
    if (result.error) throw fail(result.error);
    if (result.code !== 0) throw fail(`colab ${plan.args[0]} exited ${result.code}.`);
    return result;
  }

  async function startBackground(action, session, plan, notebook = '', label = '') {
    const job = createJob(action, session, label);
    void (async () => {
      try { await runPlan(job, plan, notebook); await finishJob(job, 0, ''); }
      catch (error) { await finishJob(job, 1, job.cancelRequested ? 'Cancelled. Remote work was interrupted.' : (error.message || 'Colab job failed.'), job.cancelRequested ? 'cancelled' : ''); }
    })();
    return { job: publicJob(job) };
  }

  function sleep(ms) {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  async function consoleText(session, command, timeoutMs, owner = null) {
    const plan = planCommand({ action: 'console', session, command }, catalog);
    plan.timeoutMs = timeoutMs;
    plan.silenceMs = timeoutMs;
    return runForeground(plan, owner);
  }

  async function consoleAttempt(session, command, timeoutMs, owner = null) {
    if (stopped || owner?.cancelRequested) return { output: '', lost: false, stopped, cancelled: owner?.cancelRequested === true };
    try {
      const output = await consoleText(session, command, timeoutMs, owner);
      if (stopped || owner?.cancelRequested) return { output, lost: false, stopped, cancelled: owner?.cancelRequested === true };
      return { output, lost: connectionLost(output), stopped: false, cancelled: false };
    } catch (error) {
      const message = error?.message || '';
      if (stopped || owner?.cancelRequested) return { output: message, lost: false, stopped, cancelled: owner?.cancelRequested === true };
      if (connectionLost(message)) return { output: message, lost: true, stopped: false, cancelled: false };
      throw error;
    }
  }

  async function launchRemote(job, session, file) {
    const remoteRoot = `/content/orbit-jobs/${job.id}`;
    const scriptRemote = `${remoteRoot}/main.py`;
    const helperRemote = '/content/orbit-jobs/orbit-remote.py';
    await appendOutput(job, 'stdout', '[orbit] starting a detached run on the VM\n');
    if (stopped || job.cancelRequested) return;
    await runForeground(planCommand({ action: 'upload', session, local_path: file, remote: scriptRemote }, catalog), job);
    const helperLocal = path.join(job.dir, 'orbit-remote.py');
    await fs.promises.writeFile(helperLocal, ORBIT_REMOTE_PY, { mode: 0o600 });
    await runForeground(planCommand({ action: 'upload', session, local_path: helperLocal, remote: helperRemote }, catalog), job);
    let launched = null;
    for (let attempt = 0; attempt < 4 && !launched; attempt += 1) {
      if (stopped || job.cancelRequested) return;
      const result = await consoleAttempt(session, `python3 ${helperRemote} launch ${remoteRoot} ${scriptRemote}`, 90000, job);
      if (result.stopped || result.cancelled) return;
      const parsed = parseRemoteTail(result.output);
      if (!result.lost && parsed.pid) launched = parsed;
      else await appendOutput(job, 'stderr', '\n[orbit] Connection was lost while launching. Retrying.\n');
      if (!launched) await sleep(Math.min(reconnectDelay * (attempt + 1), 15000));
    }
    if (!launched?.pid) throw fail('Remote run did not start.');
    job.remote = true;
    job.remotePid = launched.pid;
    remember(job);
    await appendOutput(job, 'stdout', `[orbit] remote pid ${launched.pid}\n`);
    remember(job);
    await followRemote(job);
  }

  async function followRemote(job) {
    if (job.following || stopped) return;
    job.following = true;
    const session = job.session;
    const remoteRoot = `/content/orbit-jobs/${job.id}`;
    const helperRemote = '/content/orbit-jobs/orbit-remote.py';
    let delay = reconnectDelay;
    let noted = false;
    let unreadable = 0;
    try {
      while (job.state === 'running' && !job.cancelRequested && !stopped) {
        let attempt;
        try {
          attempt = await consoleAttempt(session, `python3 ${helperRemote} tail ${remoteRoot} ${job.remoteOffset || 0}`, 60000, job);
        } catch (error) {
          if (stopped || job.cancelRequested || job.state !== 'running') return;
          await finishJob(job, 1, error.message || 'Remote tail failed.');
          return;
        }
        if (attempt.stopped || attempt.cancelled || stopped || job.cancelRequested || job.state !== 'running') return;
        if (attempt.lost) {
          if (!noted) {
            await appendOutput(job, 'stderr', '\n[orbit] Connection was lost. The VM run keeps going. Reconnecting.\n');
            noted = true;
          }
          await sleep(delay);
          delay = Math.min(delay * 2, 15000);
          continue;
        }
        const parsed = parseRemoteTail(attempt.output);
        if (parsed.length === null || parsed.offset === null) {
          unreadable += 1;
          if (unreadable >= 8) {
            await finishJob(job, 1, 'Remote tail did not return a log chunk.');
            return;
          }
          await sleep(delay);
          delay = Math.min(delay * 2, 15000);
          continue;
        }
        unreadable = 0;
        noted = false;
        delay = reconnectDelay;
        if (parsed.length > 0) {
          const bytes = Buffer.from(parsed.b64, 'base64');
          if (bytes.length !== parsed.length) {
            await sleep(delay);
            delay = Math.min(delay * 2, 15000);
            continue;
          }
          await appendOutput(job, 'stdout', bytes.toString('utf8'));
          job.remoteOffset = parsed.offset + parsed.length;
          remember(job);
        }
        if (parsed.exitCode !== null && !parsed.alive) {
          const failed = parsed.exitCode !== 0;
          await finishJob(job, parsed.exitCode, failed ? `Remote exit ${parsed.exitCode}` : '', failed ? 'failed' : '');
          return;
        }
        if (!parsed.length) await sleep(reconnectDelay);
      }
    } finally {
      job.following = false;
    }
  }

  async function sha256File(file) {
    const hash = createHash('sha256');
    await pipeline(fs.createReadStream(file), hash);
    return hash.digest('hex');
  }

  async function downloadChunked(session, remote, local) {
    const helperDir = path.join(root, 'helpers');
    fs.mkdirSync(helperDir, { recursive: true, mode: 0o700 });
    const helperLocal = path.join(helperDir, 'orbit-fs.py');
    await fs.promises.writeFile(helperLocal, ORBIT_FS_PY, { mode: 0o600 });
    const helperRemote = '/content/orbit-jobs/orbit-fs.py';
    await runForeground(planCommand({ action: 'upload', session, local_path: helperLocal, remote: helperRemote }, catalog));
    const scratch = path.join(root, 'scratch');
    fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const runFs = async (params) => {
      const localParams = path.join(scratch, `${randomBytes(8).toString('hex')}.json`);
      await fs.promises.writeFile(localParams, JSON.stringify(params), { mode: 0o600 });
      const remoteParams = `/content/orbit-jobs/params-${path.basename(localParams)}`;
      await runForeground(planCommand({ action: 'upload', session, local_path: localParams, remote: remoteParams }, catalog));
      return consoleText(session, `python3 ${helperRemote} ${remoteParams}`, 180000);
    };
    const attempt = async (fn) => {
      let last = fail('Download failed.');
      for (let tryNumber = 0; tryNumber < 4; tryNumber += 1) {
        try { return await fn(); }
        catch (error) {
          last = error;
          if (stopped) throw error;
          await sleep(Math.min(reconnectDelay * (tryNumber + 1), 15000));
        }
      }
      throw last;
    };
    const info = await attempt(async () => {
      const parsed = parseFileInfo(await runFs({ cmd: 'info', path: remote }));
      if (!parsed) throw fail('Remote file size was not reported.');
      return parsed;
    });
    const key = createHash('sha256').update(`${session}\0${remote}`).digest('hex').slice(0, 24);
    const partial = path.join(path.dirname(local), `${key}.partial`);
    const sidecar = `${partial}.json`;
    let offset = 0;
    try {
      const saved = JSON.parse(await fs.promises.readFile(sidecar, 'utf8'));
      if (saved.sha256 === info.sha256 && saved.size === info.size && Number.isInteger(saved.offset) && saved.offset >= 0 && saved.offset <= info.size) offset = saved.offset;
    } catch { offset = 0; }
    const existing = await fs.promises.stat(partial).catch(() => null);
    if (!existing) offset = 0;
    else if (existing.size !== offset) {
      await fs.promises.truncate(partial, Math.min(existing.size, offset));
      offset = Math.min(existing.size, offset);
    }
    const sliceRemote = `/content/orbit-jobs/slice-${key}.bin`;
    while (offset < info.size) {
      const start = offset;
      const length = Math.min(chunkBytes, info.size - start);
      const chunkPath = `${partial}.chunk`;
      await attempt(async () => {
        const current = await fs.promises.stat(partial).catch(() => null);
        if (current && current.size > start) await fs.promises.truncate(partial, start);
        const sliced = await runFs({ cmd: 'slice', path: remote, start, length, dest: sliceRemote });
        if (!/ORBIT_SLICE/.test(sliced)) throw fail('Remote slice was not written.');
        const plan = planCommand({ action: 'download', session, remote: sliceRemote, local_path: chunkPath }, catalog);
        plan.timeoutMs = 600000;
        plan.silenceMs = 600000;
        await runForeground(plan);
        const stat = await fs.promises.stat(chunkPath).catch(() => null);
        if (!stat || stat.size !== length) throw fail('Downloaded chunk size did not match.');
        await pipeline(fs.createReadStream(chunkPath), fs.createWriteStream(partial, { flags: 'a', mode: 0o600 }));
        const handle = await fs.promises.open(partial, 'r');
        try { await handle.sync(); }
        finally { await handle.close(); }
        await fs.promises.rm(chunkPath, { force: true });
      });
      offset = start + length;
      await fs.promises.writeFile(sidecar, JSON.stringify({ offset, size: info.size, sha256: info.sha256 }), { mode: 0o600 });
    }
    if (!info.size && !existing) await fs.promises.writeFile(partial, '', { mode: 0o600 });
    const digest = await sha256File(partial);
    if (digest !== info.sha256) throw fail('Downloaded file sha256 did not match.');
    await fs.promises.rename(partial, local);
    await fs.promises.rm(sidecar, { force: true });
    return { bytes: info.size, sha256: digest };
  }

  async function dispatch(body) {
    const action = String(body?.action || '');
    if (action === 'capabilities') {
      return {
        costWarning: COST_WARNING,
        stopWarning: STOP_WARNING,
        runtimes: catalog.map(publicRuntime),
        discovered,
        presets: PRESETS,
        bin: path.basename(bin),
        streaming: 'sse',
        commands: ['usage', 'sessions', 'status', 'create', 'stop', 'restart-kernel', 'url', 'exec', 'run', 'repl', 'console', 'install', 'upload', 'download', 'ls', 'rm', 'read', 'write', 'drivemount', 'vm-auth', 'log', 'gpu', 'train', 'tail', 'cancel'],
      };
    }
    if (action === 'jobs') {
      const session = body.session ? sessionName(body.session) : '';
      const list = [...jobs.values()].filter(job => !session || job.session === session);
      return { jobs: list.map(publicJob).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, 50) };
    }
    if (action === 'job' || action === 'tail') {
      const job = jobs.get(String(body.job_id || ''));
      if (!job) throw fail('Job not found.', 404);
      if (action === 'job') return { job: publicJob(job) };
      const after = Number(body.after || 0);
      if (!Number.isInteger(after) || after < 0) throw fail('Tail offset is not allowed.');
      const length = Math.max(0, job.bytes - after);
      const take = Math.min(length, TAIL_LIMIT);
      let text = '';
      if (take) {
        const fh = await fs.promises.open(job.logPath, 'r');
        try {
          const buffer = Buffer.alloc(take);
          const { bytesRead } = await fh.read(buffer, 0, take, after);
          text = buffer.subarray(0, bytesRead).toString('utf8');
        } finally { await fh.close(); }
      }
      return { job: publicJob(job), text, plain: collapseTerminal(text), next: after + Buffer.byteLength(text), rich: job.rich };
    }
    if (action === 'cancel') {
      if (body.confirm !== true) throw fail('Confirmation is required.');
      const job = jobs.get(String(body.job_id || ''));
      if (!job) throw fail('Job not found.', 404);
      job.cancelRequested = true;
      if (job.child) { try { job.child.kill('SIGTERM'); } catch { /* already exited */ } }
      else if (job.pid && processAlive(job.pid)) {
        try { process.kill(-job.pid, 'SIGTERM'); }
        catch { try { process.kill(job.pid, 'SIGTERM'); } catch { /* already exited */ } }
      }
      if (job.session) {
        if (job.remote || job.remotePid) {
          try {
            const output = await consoleText(job.session, `python3 /content/orbit-jobs/orbit-remote.py stop /content/orbit-jobs/${job.id}`, 60000);
            await appendOutput(job, 'stderr', `\n[orbit] ${output.trim() || 'Remote process signalled.'}\n`);
          } catch (error) {
            await appendOutput(job, 'stderr', `\n[orbit] Remote stop failed: ${error.message || 'stop failed'}\n`);
          }
        }
        try {
          await runForeground(planCommand({ action: 'restart-kernel', session: job.session }, catalog));
          await appendOutput(job, 'stderr', '\n[orbit] Kernel restarted.\n');
        } catch (error) {
          await appendOutput(job, 'stderr', `\n[orbit] Kernel restart failed: ${error.message || 'restart failed'}\n`);
        }
      }
      await appendOutput(job, 'stderr', '\n[orbit] Cancelled. Remote work was interrupted. The VM stays allocated until you stop the session.\n');
      await finishJob(job, null, 'Cancelled. Remote work was interrupted.', 'cancelled');
      return { job: publicJob(job), cancelled: true };
    }
    if (action === 'job-input') {
      const job = jobs.get(String(body.job_id || ''));
      if (!job) throw fail('Job not found.', 404);
      const text = String(body.text ?? '\n');
      if (text.length > 2000 || /[\u0000]/.test(text)) throw fail('Job input is not allowed.');
      const line = text.endsWith('\n') ? text : `${text}\n`;
      if (job.child?.stdin?.writable) { job.child.stdin.write(line); return { ok: true }; }
      if (!job.detached || !job.socket) throw fail('That job is not waiting for input.');
      await new Promise((resolve, reject) => {
        const client = net.connect(job.socket);
        const failInput = () => reject(fail('That job is not waiting for input.'));
        client.on('connect', () => client.end(line));
        client.on('error', failInput);
        client.on('close', resolve);
      });
      return { ok: true };
    }
    if (action === 'pay') return { url: 'https://colab.research.google.com/signup' };
    if (action === 'ssh') return { supported: false, reason: 'SSH needs an interactive terminal and a private key. Use the session URL instead.' };
    if (action === 'read') {
      const session = sessionName(body.session);
      const remote = remotePath(body.path);
      const local = path.join(root, 'scratch', `${randomBytes(8).toString('hex')}-${safeBasename(remote)}`);
      fs.mkdirSync(path.dirname(local), { recursive: true, mode: 0o700 });
      const output = await runForeground(planCommand({ action: 'download', session, remote, local_path: local }, catalog));
      const stat = await fs.promises.stat(local);
      if (stat.size > 1000000) return { remote, bytes: stat.size, text: '', binary: true, output };
      const text = await fs.promises.readFile(local, 'utf8');
      return { remote, bytes: stat.size, text, binary: text.includes('\u0000'), output };
    }
    if (action === 'write') {
      if (body.confirm !== true) throw fail('Confirmation is required.');
      const session = sessionName(body.session);
      const remote = remotePath(body.path);
      const text = String(body.text ?? '');
      if (text.length > 1000000) throw fail('File text is too large.');
      const local = path.join(root, 'scratch', `${randomBytes(8).toString('hex')}-${safeBasename(remote)}`);
      fs.mkdirSync(path.dirname(local), { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(local, text, { mode: 0o600 });
      const output = await runForeground(planCommand({ action: 'upload', session, local_path: local, remote }, catalog));
      return { remote, bytes: Buffer.byteLength(text), output };
    }
    if (action === 'train') {
      if (body.confirm_cost !== true) throw fail('Confirmation is required.');
      const session = sessionName(body.session);
      const runtime = body.accelerator || 'cpu';
      const uploads = Array.isArray(body.uploads) ? body.uploads : [];
      if (uploads.length > 20) throw fail('Too many uploads.');
      const files = [];
      for (const item of uploads) files.push({ local: await assertLocalFile(item.local), remote: remotePath(item.remote) });
      let script = body.script ? await assertLocalFile(body.script) : '';
      const code = body.code !== undefined && body.code !== null ? String(body.code) : '';
      if (!script && !code.trim()) throw fail('A training script or notebook is required.');
      if (code.length > 500000) throw fail('Training source is too large.');
      const packages = Array.isArray(body.packages) ? body.packages : [];
      const timeout = timeoutSeconds(body.timeout, 3600);
      const label = jobLabel(body.label);
      const job = createJob('train', session, label);
      if (!script) {
        script = path.join(job.dir, code.trim().startsWith('{') ? 'train.ipynb' : 'train.py');
        await fs.promises.writeFile(script, code, { mode: 0o600 });
      }
      const attached = body.attached === true || script.endsWith('.ipynb');
      const plans = [planCommand({ action: 'create', session, accelerator: runtime, high_mem: body.high_mem === true, confirm_cost: true }, catalog)];
      for (const item of files) plans.push(planCommand({ action: 'upload', session, local_path: item.local, remote: item.remote }, catalog));
      if (packages.length) plans.push(planCommand({ action: 'install', session, packages, timeout }, catalog));
      if (attached) plans.push(planCommand({ action: 'exec', session, file: script, timeout }, catalog));
      job.stepCount = plans.length + (attached ? 0 : 1);
      remember(job);
      void (async () => {
        try {
          for (let index = 0; index < plans.length; index += 1) {
            job.stepIndex = index;
            remember(job);
            await runPlan(job, plans[index], attached && index === plans.length - 1 ? script : '');
          }
          if (attached) await finishJob(job, 0, '');
          else {
            job.stepIndex = plans.length;
            remember(job);
            await launchRemote(job, session, script);
          }
        } catch (error) {
          await finishJob(job, 1, job.cancelRequested ? 'Cancelled. Remote work was interrupted.' : (error.message || 'Training run failed.'), job.cancelRequested ? 'cancelled' : '');
        }
      })();
      return { job: publicJob(job), session, warning: COST_WARNING };
    }
    if (action === 'discover') {
      const output = await runForeground(planCommand({ action: 'discover' }, catalog));
      const next = catalogFromHelp(output);
      catalog = next.runtimes;
      discovered = next.discovered;
      let version = '';
      try { version = parseVersion(await runForeground(planCommand({ action: 'version' }, catalog))); }
      catch { version = ''; }
      return { runtimes: catalog.map(publicRuntime), discovered, version, help: redactSecrets(output).slice(0, 4000) };
    }
    if (action === 'exec' || action === 'repl' || action === 'run') {
      let file = body.file ? await assertLocalFile(body.file) : '';
      let notebook = file;
      if ((action === 'exec' || action === 'run') && body.code && !file) {
        const jobDir = path.join(root, 'snippets');
        fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
        const source = String(body.code);
        if (source.length > 500000) throw fail('Source is too large.');
        file = path.join(jobDir, `${randomBytes(8).toString('hex')}${source.trim().startsWith('{') ? '.ipynb' : '.py'}`);
        await fs.promises.writeFile(file, source, { mode: 0o600 });
        notebook = file;
      }
      if (action === 'run' && file && !file.endsWith('.py')) throw fail('colab run expects a Python script.');
      const label = jobLabel(body.label);
      const session = body.session ? sessionName(body.session) : '';
      if (action === 'exec' && file && body.attached !== true && !file.endsWith('.ipynb')) {
        if (!session) throw fail('Session is required.');
        const job = createJob('exec', session, label);
        void (async () => {
          try { await launchRemote(job, session, file); }
          catch (error) { await finishJob(job, 1, job.cancelRequested ? 'Cancelled. Remote work was interrupted.' : (error.message || 'Remote run failed.'), job.cancelRequested ? 'cancelled' : ''); }
        })();
        return { job: publicJob(job) };
      }
      const plan = planCommand({ ...body, file }, catalog);
      return startBackground(action, body.session || '', plan, action === 'exec' ? notebook : '', label);
    }
    if (action === 'upload') {
      const local = await assertLocalFile(body.local_path);
      const output = await runForeground(planCommand({ ...body, local_path: local }, catalog));
      return { output };
    }
    if (action === 'download') {
      const session = sessionName(body.session);
      const remote = remotePath(body.remote);
      const name = safeBasename(body.name || remote);
      const dir = path.join(root, 'downloads', session);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const local = path.join(dir, `${randomBytes(4).toString('hex')}-${name}`);
      const saved = await downloadChunked(session, remote, local);
      const id = path.basename(local);
      return { output: 'Downloaded in chunks.', file: id, name, session, bytes: saved.bytes, sha256: saved.sha256 };
    }
    if (action === 'log' && body.format) {
      const session = sessionName(body.session);
      const format = String(body.format);
      if (!['ipynb', 'md', 'txt', 'jsonl'].includes(format)) throw fail('Log format is not allowed.');
      const dir = path.join(root, 'exports');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const local = path.join(dir, `${session}-${randomBytes(4).toString('hex')}.${format}`);
      const output = await runForeground(planCommand({ action: 'log', session, lines: body.lines, event_type: body.event_type, output: local }, catalog));
      return { output, file: path.basename(local), name: path.basename(local), session: 'exports' };
    }
    const plan = planCommand(body, catalog);
    if (plan.background) return startBackground(action, body.session || '', plan, '', jobLabel(body.label));
    const output = await runForeground(plan);
    if (action === 'usage') return { usage: parseUsage(output), warning: COST_WARNING };
    if (action === 'sessions' || action === 'status') {
      const parsed = action === 'status' ? parseStatus(output) : parseSessions(output);
      delete parsed.raw;
      return parsed;
    }
    if (action === 'url') {
      const url = output.split(/\r?\n/).map(line => line.trim()).find(line => line.startsWith('https://'));
      if (!url) throw fail(output || 'Colab did not return a session URL.');
      return { url: redactSecrets(url), output: redactSecrets(output) };
    }
    if (action === 'ls') return parseLs(output);
    if (action === 'gpu') return { gpus: parseNvidiaSmi(output), output: redactSecrets(output).slice(0, 4000) };
    if (action === 'version') return { version: parseVersion(output), output };
    if (action === 'create' || action === 'new') return { output, warning: COST_WARNING };
    return { output };
  }

  async function handle(req, res, url) {
    const status = authorize(req);
    if (status) return reply(res, status, { error: status === 401 ? 'Authentication required.' : 'Origin rejected.' });
    try {
      if (req.method === 'GET' && url.pathname === `${API}/stream`) return stream(req, res, url);
      if (req.method === 'GET' && url.pathname.startsWith(`${API}/artifact/`)) return artifact(res, url.pathname);
      if (req.method === 'GET' && url.pathname.startsWith(`${API}/file/`)) return sendFile(res, url.pathname);
      if (req.method === 'POST' && url.pathname === `${API}/upload`) return receiveUpload(req, res);
      if (req.method === 'POST' && url.pathname === API) {
        const body = await readJson(req);
        return reply(res, 200, await dispatch(body));
      }
      return reply(res, 405, { error: 'Method not allowed.' });
    } catch (error) {
      if (res.headersSent) { try { res.end(); } catch { /* closed */ } return; }
      return reply(res, error.status || 500, { error: redactSecrets(error.message || 'Colab request failed.').slice(0, 4000) });
    }
  }

  async function stream(req, res, url) {
    const job = jobs.get(String(url.searchParams.get('job') || ''));
    if (!job) return reply(res, 404, { error: 'Job not found.' });
    let cursor = Number(url.searchParams.get('after') || req.headers['last-event-id'] || 0);
    if (!Number.isInteger(cursor) || cursor < 0) cursor = 0;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    const pending = [];
    const listener = event => { if (!closed) pending.push(event); };
    job.listeners.add(listener);
    const ping = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 15000);
    ping.unref?.();
    const writeData = (offset, text) => {
      res.write(`id: ${offset + Buffer.byteLength(text)}\nevent: data\ndata: ${JSON.stringify({ offset, text })}\n\n`);
    };
    const flush = async () => {
      const fh = await fs.promises.open(job.logPath, 'r');
      try {
        for (;;) {
          const stat = await fh.stat();
          if (stat.size <= cursor) break;
          const length = Math.min(stat.size - cursor, 65536);
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await fh.read(buffer, 0, length, cursor);
          if (!bytesRead) break;
          const text = buffer.subarray(0, bytesRead).toString('utf8');
          writeData(cursor, text);
          cursor += bytesRead;
        }
      } finally { await fh.close(); }
    };
    try {
      await flush();
      for (const rich of job.rich) res.write(`event: rich\ndata: ${JSON.stringify(rich)}\n\n`);
      while (pending.length) {
        const event = pending.shift();
        if (event.type === 'data' && event.offset >= cursor) {
          writeData(event.offset, event.text);
          cursor = event.offset + Buffer.byteLength(event.text);
        } else if (event.type === 'rich') res.write(`event: rich\ndata: ${JSON.stringify(event.rich)}\n\n`);
        else if (event.type === 'status') res.write(`event: status\ndata: ${JSON.stringify(event.job)}\n\n`);
      }
      await new Promise(resolve => {
        const live = event => {
          if (closed) return;
          if (event.type === 'data') {
            if (event.offset < cursor) return;
            writeData(event.offset, event.text);
            cursor = event.offset + Buffer.byteLength(event.text);
          } else if (event.type === 'rich') res.write(`event: rich\ndata: ${JSON.stringify(event.rich)}\n\n`);
          else if (event.type === 'status') {
            res.write(`event: status\ndata: ${JSON.stringify(event.job)}\n\n`);
            resolve();
          }
        };
        listener.live = live;
        job.listeners.add(live);
        job.listeners.delete(listener);
        req.on('close', () => resolve());
        if (job.state !== 'running') {
          res.write(`event: status\ndata: ${JSON.stringify(publicJob(job))}\n\n`);
          resolve();
        }
      });
    } catch {
      if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ error: 'Stream interrupted.' })}\n\n`);
    } finally {
      closed = true;
      clearInterval(ping);
      job.listeners.delete(listener);
      if (listener.live) job.listeners.delete(listener.live);
      try { res.end(); } catch { /* closed */ }
    }
  }

  function artifact(res, pathname) {
    const parts = pathname.split('/');
    const job = jobs.get(parts[4] || '');
    const name = parts[5] || '';
    if (!job || !/^[-a-z0-9.]+$/i.test(name)) return reply(res, 404, { error: 'Artifact not found.' });
    const file = path.join(job.dir, 'artifacts', name);
    if (!file.startsWith(path.join(job.dir, 'artifacts') + path.sep) || !fs.existsSync(file)) return reply(res, 404, { error: 'Artifact not found.' });
    const rich = job.rich.find(item => item.name === name);
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': rich?.mime || 'application/octet-stream',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
    });
    res.end(body);
  }

  function sendFile(res, pathname) {
    const match = pathname.match(/^\/api\/colab-runtime\/file\/(exports|[A-Za-z][A-Za-z0-9_-]{0,40})\/([A-Za-z0-9][A-Za-z0-9._-]{0,120})$/);
    if (!match) return reply(res, 404, { error: 'File not found.' });
    const bucket = match[1] === 'exports' ? 'exports' : path.join('downloads', match[1]);
    const fileName = match[2];
    const file = path.join(root, bucket, fileName);
    const base = path.join(root, bucket);
    if (!file.startsWith(base + path.sep) || !fs.existsSync(file)) return reply(res, 404, { error: 'File not found.' });
    const stat = fs.statSync(file);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(stat.size),
      'Content-Disposition': `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, '')}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    const stream = fs.createReadStream(file);
    stream.on('error', () => { try { res.destroy(); } catch { /* closed */ } });
    stream.pipe(res);
  }

  async function receiveUpload(req, res) {
    const session = sessionName(req.headers['x-colab-session']);
    const remote = remotePath(req.headers['x-colab-remote']);
    const name = safeBasename(req.headers['x-colab-filename'] || 'upload.bin');
    const dir = path.join(root, 'incoming');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const local = path.join(dir, `${randomBytes(8).toString('hex')}-${name}`);
    const write = fs.createWriteStream(local, { mode: 0o600 });
    let size = 0;
    try {
      await new Promise((resolve, reject) => {
        req.on('data', chunk => {
          size += chunk.length;
          if (size > UPLOAD_LIMIT) { reject(fail('Upload is too large.', 413)); req.destroy(); return; }
          if (!write.write(chunk)) req.pause();
        });
        write.on('drain', () => req.resume());
        req.on('end', () => write.end(resolve));
        req.on('error', reject);
        write.on('error', reject);
      });
      const output = await runForeground(planCommand({ action: 'upload', session, local_path: local, remote }, catalog));
      return reply(res, 200, { output, remote, bytes: size });
    } catch (error) {
      return reply(res, error.status || 500, { error: redactSecrets(error.message || 'Upload failed.').slice(0, 2000) });
    }
  }

  function close() {
    stopped = true;
    for (const child of children) { try { child.kill('SIGTERM'); } catch { /* already exited */ } }
    for (const job of jobs.values()) if (job.watch) { clearInterval(job.watch); job.watch = null; }
  }

  return { handle, dispatch, close, root };
}
