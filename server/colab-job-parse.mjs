/** Parsers for Google Colab job logs, remote tails, and file transfers. */

export function emptyProgress() {
  return { percent: null, stage: '', step: null, total: null, loss: null, eta: '', gpuMemory: '', losses: [] };
}

export function connectionLost(text) {
  return /Connection was lost|WebSocket connection (?:is )?closed|connection reset|ECONNRESET|ETIMEDOUT|socket hang up/i.test(String(text || ''));
}

export function remoteFailure(text) {
  const value = String(text || '');
  const marked = value.match(/\bORBIT_EXIT\s+(\d+)\b/);
  if (marked && Number(marked[1]) !== 0) return { failed: true, code: Number(marked[1]), summary: `Remote exit ${marked[1]}`, lost: false };
  if (!/Traceback \(most recent call last\):/.test(value)) return { failed: false, code: 0, summary: '', lost: connectionLost(value) };
  const summary = value.split('\n').map(line => line.trim()).filter(line => /(?:Error|Exception):/.test(line)).pop() || 'Python traceback';
  if (/Connection was lost/.test(summary)) return { failed: false, code: 0, summary: '', lost: true };
  return { failed: true, code: 1, summary: summary.slice(0, 300), lost: false };
}

export function parseRemoteTail(text) {
  const value = String(text || '');
  const pid = value.match(/ORBIT_REMOTE_PID\s+(\d+)/);
  const header = value.match(/ORBIT_CHUNK\s+(\d+)\s+(\d+)\s*\n/);
  let b64 = '';
  if (header) {
    const start = header.index + header[0].length;
    const end = value.indexOf('ORBIT_CHUNK_END', start);
    b64 = (end >= 0 ? value.slice(start, end) : '').replace(/\s+/g, '');
  }
  const exit = value.match(/ORBIT_EXIT\s+(\d+)/);
  return {
    lost: connectionLost(value),
    pid: pid ? Number(pid[1]) : null,
    offset: header ? Number(header[1]) : null,
    length: header ? Number(header[2]) : null,
    b64,
    alive: /ORBIT_ALIVE\b/.test(value),
    exitCode: exit ? Number(exit[1]) : null,
    killed: /ORBIT_KILLED\b/.test(value),
  };
}

export function parseFileInfo(text) {
  const match = String(text || '').match(/ORBIT_FILE\s+(\d+)\s+([a-f0-9]{64})/i);
  if (!match) return null;
  return { size: Number(match[1]), sha256: match[2].toLowerCase() };
}

function recordLoss(progress, loss, step) {
  if (!Number.isFinite(loss)) return;
  progress.loss = loss;
  const last = progress.losses.at(-1);
  if (last && last.loss === loss && last.step === step) return;
  progress.losses.push({ step: step ?? progress.losses.length, loss });
  if (progress.losses.length > 200) progress.losses.splice(0, progress.losses.length - 200);
}

function absorb(progress, body) {
  if (!body || typeof body !== 'object') return;
  if (typeof body.stage === 'string') progress.stage = body.stage.slice(0, 80);
  if (body.step !== undefined && Number.isFinite(Number(body.step))) progress.step = Number(body.step);
  if (body.total !== undefined && Number.isFinite(Number(body.total))) progress.total = Number(body.total);
  if (body.percent !== undefined && Number.isFinite(Number(body.percent))) progress.percent = Math.max(0, Math.min(100, Math.round(Number(body.percent))));
  if (typeof body.eta === 'string') progress.eta = body.eta.slice(0, 40);
  if (body.eta_sec !== undefined && Number.isFinite(Number(body.eta_sec))) progress.eta = `${Math.round(Number(body.eta_sec))}s`;
  if (typeof body.gpu_mem === 'string') progress.gpuMemory = body.gpu_mem.slice(0, 40);
  if (typeof body.gpuMemory === 'string') progress.gpuMemory = body.gpuMemory.slice(0, 40);
  if (body.gpu_used_mib !== undefined && body.gpu_total_mib !== undefined) progress.gpuMemory = `${body.gpu_used_mib}/${body.gpu_total_mib} MiB`;
  if (body.loss !== undefined) recordLoss(progress, Number(body.loss), progress.step);
}

export function applyProgress(progress, text) {
  const current = {
    ...(progress || emptyProgress()),
    losses: [...(progress?.losses || [])],
  };
  for (const raw of String(text || '').split(/\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('ORBIT_PROGRESS ')) {
      try { absorb(current, JSON.parse(line.slice('ORBIT_PROGRESS '.length))); } catch { /* ignore a partial progress line */ }
    } else if (line.startsWith('{')) {
      try {
        const body = JSON.parse(line);
        absorb(current, body.orbit_progress || body);
      } catch { /* training logs contain other braces */ }
    }
    const bar = line.match(/(\d{1,3})%\|[^|]*\|\s*(\d+)\/(\d+)(?:.*\[([^<\]]*)<([^,\]]+))?/);
    if (bar) {
      current.percent = Number(bar[1]);
      current.step = Number(bar[2]);
      current.total = Number(bar[3]);
      if (bar[5]) current.eta = bar[5].trim();
      if (!current.stage) current.stage = 'running';
    }
    const loss = line.match(/['"]loss['"]\s*:\s*([+-]?[0-9]*\.?[0-9]+(?:[eE][+-]?\d+)?)/);
    if (loss) recordLoss(current, Number(loss[1]), current.step);
    const gpu = line.match(/gpu[_\s-]?mem(?:ory)?\s*[:=]\s*([0-9.]+\s*\/\s*[0-9.]+\s*[KMGT]?i?B)/i);
    if (gpu) current.gpuMemory = gpu[1].replace(/\s+/g, ' ');
  }
  if (current.percent === null && current.step !== null && current.total) {
    current.percent = Math.max(0, Math.min(100, Math.round((100 * current.step) / current.total)));
  }
  return current;
}

export const ORBIT_REMOTE_PY = `import base64, os, subprocess, sys, time

def launch(root, script):
    os.makedirs(root, exist_ok=True)
    log_path = os.path.join(root, "run.log")
    pid_path = os.path.join(root, "pid")
    exit_path = os.path.join(root, "exit")
    if os.path.exists(pid_path):
        raw = open(pid_path).read().strip()
        if raw:
            try:
                os.kill(int(raw), 0)
                print("ORBIT_REMOTE_PID", raw)
                return
            except OSError:
                pass
    waiter = os.fork()
    if waiter == 0:
        os.setsid()
        log = open(log_path, "ab", buffering=0)
        proc = subprocess.Popen([sys.executable, "-u", script], stdout=log, stderr=subprocess.STDOUT, cwd=root)
        open(pid_path, "w").write(str(proc.pid))
        code = proc.wait()
        open(exit_path, "w").write(str(code))
        os._exit(0)
    for _ in range(100):
        if os.path.exists(pid_path) and open(pid_path).read().strip():
            print("ORBIT_REMOTE_PID", open(pid_path).read().strip())
            return
        time.sleep(0.05)
    print("ORBIT_REMOTE_PID", waiter)

def tail(root, offset):
    log_path = os.path.join(root, "run.log")
    pid_path = os.path.join(root, "pid")
    exit_path = os.path.join(root, "exit")
    data = b""
    if os.path.exists(log_path):
        with open(log_path, "rb") as handle:
            handle.seek(max(0, offset))
            data = handle.read(131072)
    print("ORBIT_CHUNK", offset, len(data))
    if data:
        print(base64.b64encode(data).decode())
    print("ORBIT_CHUNK_END")
    code = None
    if os.path.exists(exit_path):
        raw = open(exit_path).read().strip()
        if raw != "":
            code = int(raw)
    alive = False
    if os.path.exists(pid_path):
        raw = open(pid_path).read().strip()
        if raw:
            try:
                os.kill(int(raw), 0)
                alive = True
            except OSError:
                alive = False
    if code is not None and not alive:
        print("ORBIT_EXIT", code)
    elif alive:
        print("ORBIT_ALIVE")
    elif os.path.exists(pid_path):
        print("ORBIT_EXIT", 1)

def stop(root):
    pid_path = os.path.join(root, "pid")
    pid = 0
    if os.path.exists(pid_path):
        raw = open(pid_path).read().strip()
        pid = int(raw or "0")
        if pid:
            try:
                os.kill(pid, 15)
            except OSError:
                pass
    print("ORBIT_KILLED", pid)

cmd = sys.argv[1]
if cmd == "launch":
    launch(sys.argv[2], sys.argv[3])
elif cmd == "tail":
    tail(sys.argv[2], int(sys.argv[3]))
elif cmd == "stop":
    stop(sys.argv[2])
else:
    raise SystemExit("unknown")
`;

export const ORBIT_FS_PY = `import hashlib, json, os, sys
params = json.load(open(sys.argv[1], "r"))
cmd = params["cmd"]
path = params["path"]
if cmd == "info":
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    print("ORBIT_FILE", os.path.getsize(path), digest.hexdigest())
elif cmd == "slice":
    start = int(params["start"])
    length = int(params["length"])
    dest = params["dest"]
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(path, "rb") as src, open(dest, "wb") as out:
        src.seek(start)
        left = length
        while left:
            block = src.read(min(1024 * 1024, left))
            if not block:
                break
            out.write(block)
            left -= len(block)
    print("ORBIT_SLICE", start, os.path.getsize(dest))
else:
    raise SystemExit("unknown")
`;
