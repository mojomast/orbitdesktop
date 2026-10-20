#!/usr/bin/env python3
"""Orbit local-worker launcher (runs on Kyle's PC, never on the Orbit host).

Owns every Cua call, holds the provider key and never returns it, enforces one
execution controller per attempt, journals attempts locally, and exposes a
narrow token-scoped HTTP API on the Tailscale IP only.

  uv run --with cua==0.5.0 launcher.py serve  --config config.json
  uv run --with cua==0.5.0 launcher.py doctor --config config.json
"""
from __future__ import annotations
import argparse, asyncio, platform, hashlib, hmac, ipaddress, json, os, re, sys, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "0.1.0"
TERMINAL = {"succeeded", "failed", "cancelled"}
GO_BASE_URL = "https://opencode.ai/inference/go/openai/v1"
# Workers must not fan out: deny the OpenCode `task` (subagent) tool.
WORKER_OPENCODE_CONFIG = {"$schema": "https://opencode.ai/config.json", "permission": {"task": "deny"}}
RATE_LIMIT = re.compile(r"\b429\b|rate.?limit|too many requests|quota", re.I)
SECRETISH = re.compile(r"(sk-[A-Za-z0-9_\-]{8,}|Bearer\s+\S+|[A-Za-z0-9_\-]{32,})")

def redact(s):
    return SECRETISH.sub("<redacted>", s) if isinstance(s, str) else s

def load_config(path):
    cfg = json.loads(Path(path).read_text("utf-8-sig"))
    cfg.setdefault("port", 47821)
    cfg["max_concurrent"] = max(1, min(3, int(cfg.get("max_concurrent", 1))))
    cfg.setdefault("model", "deepseek-v4.1-flash")
    cfg.setdefault("base_url", GO_BASE_URL)
    cfg.setdefault("wire", "openai-chat")
    cfg.setdefault("image", "ghcr.io/trycua/linux@sha256:fd00735ceb6c65ab628d962640068c9f63076a49a62d86f6b6eb5ac4bbcbbf6b")
    cfg.setdefault("runtime", "runc")
    cfg.setdefault("memory_mb", 6144)
    cfg.setdefault("backoff_s", [30, 60, 120, 240])
    cfg.setdefault("data_dir", str(Path.home() / ".orbit-launcher"))
    cfg.setdefault("projects", {})  # name -> {"repo": url} (authorized projects)
    return cfg

def check_bind(host):
    ip = ipaddress.ip_address(host)
    if ip.is_unspecified:
        raise SystemExit("refusing to bind 0.0.0.0/:: - set bind to the PC's Tailscale IP (100.x)")
    if not (ip.is_loopback or ip in ipaddress.ip_network("100.64.0.0/10") or ip in ipaddress.ip_network("fd7a:115c:a1e0::/48")):
        raise SystemExit(f"refusing to bind {host}: only loopback or a Tailscale address is allowed")

def read_secret(cfg, name):
    """Provider key: env ORBIT_WORKER_GO_KEY, else a user-only file. Never logged or returned."""
    v = os.environ.get(name)
    if v: return v.strip()
    p = Path(cfg.get("go_key_file") or (Path(cfg["data_dir"]) / "go.key"))
    return p.read_text("utf-8").strip() if p.exists() else ""

# ---------------------------------------------------------------- backends
# Every real-SDK call the backend makes, checked against the installed package by
# `launcher.py doctor` / sdk_contract_check() (tests run it against cua==0.5.0).
#   (class in cua._native, method, must_be_async, required parameter names)
SDK_CONTRACT = [
    ("Cua", "sandboxes", False, []),
    ("Sandboxes", "create", True, ["options"]),
    ("Sandboxes", "connect", True, ["name"]),     # name -> Sandbox handle (get() returns SandboxInfo: no agents())
    ("Sandboxes", "delete", True, ["name"]),
    ("Sandbox", "agents", True, []),
    ("Sandbox", "name", False, []),
    ("Sandbox", "spacesd", True, ["probe_timeout_ms"]),
    ("SpacesdClient", "sh", True, ["line", "timeout_ms"]),
    ("SpacesdClient", "upload", True, ["path", "data", "options"]),
    ("Sandbox", "id", False, []),
    ("Agents", "run", True, ["harness", "prompt", "options"]),
    ("Agents", "get", True, ["run_id"]),
    ("AgentRun", "run_id", False, []),
    ("AgentRun", "events", True, ["cursor", "max"]),
    ("AgentRun", "interrupt", True, []),
    ("AgentRun", "stop", True, []),
    ("AgentRun", "result", True, []),
    ("AgentRun", "artifacts", True, []),
]
SDK_TYPES = {  # constructor keyword fields the backend passes or reads
    "SandboxCreateOptions": ["on", "kind", "runtime", "image", "name", "memory_mb", "wait_for"],
    "ReadinessProbe": ["service"],
    "AgentRunOptions": ["env", "model", "base_url", "wire", "repo", "branch", "cwd", "exit_when_idle", "label"],
    "AgentEventPage": ["events", "cursor", "caught_up"],
    "AgentEvent": ["seq", "kind", "line", "text", "stop_reason"],
    "AgentRunResult": ["status", "stop_reason", "text", "tool_calls", "usage_json", "error"],
    "AgentArtifact": ["path", "size"],
    "ProcessOutput": ["stdout", "stderr", "pty", "exit"],
}

def sdk_contract_check():
    import inspect
    import cua
    from cua import _native as n
    problems = []
    for name in ("embedded", "SandboxCreateOptions", "AgentRunOptions", "ReadinessProbe", "cua_sdk_version"):
        if not hasattr(cua, name): problems.append(f"cua.{name} missing")
    for cls, meth, is_async, params in SDK_CONTRACT:
        c = getattr(n, cls, None); f = getattr(c, meth, None) if c else None
        if f is None: problems.append(f"{cls}.{meth} missing"); continue
        if inspect.iscoroutinefunction(f) != is_async: problems.append(f"{cls}.{meth} async={not is_async} expected {is_async}")
        got = [x for x in inspect.signature(f).parameters if x != "self"]
        for x in params:
            if x not in got: problems.append(f"{cls}.{meth} lacks parameter {x} (has {got})")
    for typ, fields in SDK_TYPES.items():
        c = getattr(n, typ, None)
        if c is None: problems.append(f"type {typ} missing"); continue
        got = inspect.signature(c.__init__).parameters
        for x in fields:
            if x not in got: problems.append(f"{typ} lacks field {x}")
    return problems

class CuaBackend:
    """Real backend: cua 0.5.0 SDK, local Docker Desktop sandboxes (runc).
    Handles: client.sandboxes() (sync) -> Sandboxes; await .create(opts)/.connect(name) -> Sandbox;
    await Sandbox.agents() -> Agents; await Agents.run(harness, prompt, opts)/.get(run_id) -> AgentRun."""
    def __init__(self, cfg):
        import cua  # deferred so tests/doctor work without it
        self.cua, self.cfg = cua, cfg
        self.client = cua.embedded()
        self._sb = {}
        self._sdc = {}

    async def _sandbox(self, name):
        if name not in self._sb:  # reattach after restart: connect by name, never get() (SandboxInfo)
            self._sb[name] = await self.client.sandboxes().connect(name)
        return self._sb[name]

    async def _sd(self, sb):
        # Container sandboxes: shell/files go through cua-spacesd (guest_sh is Lume/agentless only).
        key = sb.name()
        if key not in self._sdc: self._sdc[key] = await sb.spacesd(None)
        return self._sdc[key]

    async def _sh(self, sb, line, timeout_ms=120000):
        out = await (await self._sd(sb)).sh(line, timeout_ms)
        dec = lambda v: v.decode("utf-8", "replace") if isinstance(v, (bytes, bytearray)) else str(v or "")
        code = getattr(out.exit, "code", None)
        return dec(out.stdout) + dec(out.pty), dec(out.stderr), code

    async def _seed_project(self, sb, proj, name):
        """Copy an authorized local git repo (HEAD only) into the sandbox; returns (workdir, base_rev)."""
        import base64, subprocess
        src = proj["path"]
        rev = subprocess.run(["git", "-C", src, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        tar = subprocess.run(["git", "-C", src, "archive", "--format=tar", "HEAD"], capture_output=True, check=True).stdout
        home = (await self._sh(sb, "printf %s \"$HOME\""))[0].strip() or "/root"
        wd = f"{home}/work/{name}"
        await self._sh(sb, f"rm -rf '{wd}' /tmp/orbit-src.tar && mkdir -p '{wd}'")
        await (await self._sd(sb)).upload("/tmp/orbit-src.tar", tar, None)
        o, e, c = await self._sh(sb, f"cd '{wd}' && tar -xf /tmp/orbit-src.tar && git init -q && git add -A && "
                                     f"git -c user.name=orbit -c user.email=orbit@local commit -qm 'base {rev}' && git rev-parse HEAD")
        if c not in (0, None): raise RuntimeError(f"seeding project failed: {e[-300:]}")
        return wd, rev

    async def environment(self, a):
        sb = await self._sandbox(a["sandbox"])
        o, _, _ = await self._sh(sb, "printf 'host=%s\\nkernel=%s\\n' \"$(hostname)\" \"$(uname -sr)\"; "
                                     "ls -d $HOME/.cua/tools/opencode/* 2>/dev/null | head -1 | sed 's/^/opencode_install=/'; "
                                     "(command -v opencode >/dev/null && opencode --version || ls $HOME/.cua/tools/opencode 2>/dev/null) | head -1 | sed 's/^/opencode_version=/'")
        env = dict(l.split("=", 1) for l in o.splitlines() if "=" in l)
        env.update({"sandbox_name": a["sandbox"], "sandbox_id": a.get("sandbox_id"), "workdir": a.get("workdir"), "cua_run_id": a.get("run_id")})
        return env

    async def patch(self, a):
        if not a.get("workdir"): return None
        sb = await self._sandbox(a["sandbox"])
        wd = a["workdir"]
        await self._sh(sb, f"cd '{wd}' && git add -A")
        diff = (await self._sh(sb, f"cd '{wd}' && git diff --cached --binary HEAD"))[0]
        names = (await self._sh(sb, f"cd '{wd}' && git diff --cached --name-status HEAD"))[0]
        files = []
        for l in names.splitlines():
            st, _, path = l.partition("\t")
            if not path: continue
            sha = None if st.startswith("D") else ((await self._sh(sb, f"cd '{wd}' && sha256sum -- '{path}' | cut -d' ' -f1"))[0].strip()[:64] or None)
            files.append({"path": path, "status": st, "sha256": sha, "change": "deleted" if st.startswith("D") else ("added" if st.startswith("A") else "changed")})
        return {"diff": diff, "files": files}

    async def start(self, attempt, key):
        cua, cfg, b = self.cua, self.cfg, attempt["brief"]
        name = "orbit-" + attempt["attempt_id"][-12:]
        sb = await self.client.sandboxes().create(cua.SandboxCreateOptions(
            on="local", kind="container", runtime=cfg["runtime"], image=cfg["image"], name=name,
            memory_mb=cfg["memory_mb"], wait_for=[cua.ReadinessProbe(service="env")]))
        self._sb[name] = sb
        proj = cfg["projects"].get(b.get("project", ""), {})
        wd, base = (None, None)
        if proj.get("path"):
            wd, base = await self._seed_project(sb, proj, b["project"])
        opts = cua.AgentRunOptions(
            env={"OPENAI_API_KEY": key, "OPENCODE_CONFIG_CONTENT": json.dumps(WORKER_OPENCODE_CONFIG)},
            model=cfg["model"], base_url=cfg["base_url"], wire=cfg["wire"],
            repo=None if wd else proj.get("repo"), branch=None if wd else b.get("branch"), cwd=wd or b.get("workdir"),
            exit_when_idle=True, label=attempt["attempt_id"])
        agents = await sb.agents()
        run = await agents.run("opencode", render_prompt(b), opts)
        return {"sandbox": name, "sandbox_id": sb.id(), "run_id": run.run_id(), "workdir": wd, "local_base_rev": base}

    async def _run(self, a):
        agents = await (await self._sandbox(a["sandbox"])).agents()
        return await agents.get(a["run_id"])

    async def events(self, a, cursor):
        page = await (await self._run(a)).events(cursor, 200)
        return [{"seq": e.seq, "kind": e.kind, "line": redact(e.line or ""), "stop_reason": e.stop_reason,
                 "text": redact(e.text) if e.kind in ("message", "error", "turn_ended") else None} for e in page.events], page.cursor

    async def interrupt(self, a):
        r = await self._run(a)
        await r.interrupt()
        await r.stop()

    async def result(self, a):
        r = await self._run(a)
        res = await r.result()
        arts = [{"path": x.path, "size": x.size} for x in await r.artifacts()]
        return {"status": res.status, "stop_reason": res.stop_reason, "text": redact(res.text),
                "tool_calls": res.tool_calls, "usage": res.usage_json, "error": redact(res.error), "artifacts": arts}

    async def file_sha256(self, a, path):
        sb = await self._sandbox(a["sandbox"])
        safe = path.replace("'", "'\\''")
        o, _, _ = await self._sh(sb, f"cd '{a.get('workdir') or '.'}' && sha256sum -- '{safe}' 2>/dev/null | cut -d' ' -f1")
        return o.strip()[:64] or None

    async def cleanup(self, a):
        name = a.get("sandbox")
        if not name: return
        try: await self.client.sandboxes().delete(name)
        except Exception: pass
        self._sb.pop(name, None)

class FakeBackend:
    """Scripted backend for tests: brief.fake = {"events":[...], "fail_start":bool, "rate_limit_first":n}."""
    def __init__(self, cfg): self.runs, self.starts = {}, 0
    async def start(self, a, key):
        f = a["brief"].get("fake", {}); self.starts += 1
        if f.get("fail_start"): raise RuntimeError("fake start failure")
        rid = "run-" + uuid.uuid4().hex[:8]
        evs = list(f.get("events") or [{"kind": "turn_started"}, {"kind": "message", "text": "done"}, {"kind": "turn_ended", "stop_reason": "end_turn"}])
        if f.get("rate_limit_first", 0) > a.get("rate_limited", 0):
            evs = [{"kind": "error", "text": "HTTP 429 Too Many Requests"}]
        self.runs[rid] = {"events": [dict(e, seq=i + 1) for i, e in enumerate(evs)], "delay": f.get("delay", 0), "t0": time.time(), "cancelled": False}
        return {"sandbox": "fake", "run_id": rid}
    async def events(self, a, cursor):
        r = self.runs[a["run_id"]]
        if r["cancelled"]: return [], cursor
        if time.time() - r["t0"] < r["delay"]: return [], cursor
        out = [e for e in r["events"] if e["seq"] > cursor]
        return out, (out[-1]["seq"] if out else cursor)
    async def interrupt(self, a): self.runs[a["run_id"]]["cancelled"] = True
    async def result(self, a): return {"status": "completed", "text": "done", "artifacts": [{"path": "out.txt", "size": 2}], "tool_calls": 1}
    async def file_sha256(self, a, path): return hashlib.sha256(path.encode()).hexdigest()
    async def cleanup(self, a): pass

def render_prompt(b):
    parts = [f"# Objective\n{b['objective']}"]
    for k, title in [("deliverables", "Deliverables"), ("acceptance", "Acceptance criteria"), ("assigned_files", "Files you may change"),
                     ("commands", "Tools/commands you may run"), ("deps", "Dependencies/context")]:
        if b.get(k): parts.append(f"# {title}\n" + "\n".join(f"- {x}" for x in b[k]))
    parts.append("# Rules\n- Work only inside the working directory.\n- Do not start subagents.\n- Do not print secrets or environment variables.")
    parts.append("# Return format\nEnd with a JSON block: {\"summary\":..., \"changed_files\":[...], \"checks\":[{\"name\":...,\"command\":...,\"passed\":bool}], \"open_issues\":[...]}")
    return "\n\n".join(parts)

def validate_brief(b):
    if not isinstance(b, dict) or not str(b.get("objective", "")).strip(): return "brief.objective is required"
    for k in ("deliverables", "acceptance", "assigned_files", "commands", "deps"):
        if k in b and not (isinstance(b[k], list) and all(isinstance(x, str) for x in b[k])): return f"brief.{k} must be a list of strings"
    return None

# ---------------------------------------------------------------- launcher core
class Launcher:
    def __init__(self, cfg, backend):
        self.cfg, self.backend = cfg, backend
        self.dir = Path(cfg["data_dir"]); (self.dir / "attempts").mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.attempts = {}
        self.controllers = {}  # attempt_id -> asyncio task (exactly one per attempt)
        self.loop = asyncio.new_event_loop()
        self._load()

    # journal: one JSON per attempt (atomic replace) + append-only events log
    def _path(self, aid): return self.dir / "attempts" / f"{aid}.json"
    def _save(self, a):
        p = self._path(a["attempt_id"]); tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(a, indent=1), "utf-8"); os.replace(tmp, p)
    def _append_events(self, a, evs):
        with open(self.dir / "attempts" / f"{a['attempt_id']}.events.jsonl", "a", encoding="utf-8") as f:
            for e in evs: f.write(json.dumps(e) + "\n")
    def _load(self):
        for p in (self.dir / "attempts").glob("*.json"):
            if p.name.count(".") != 1: continue  # skip <id>.result.json (and any other sidecar)
            try: a = json.loads(p.read_text("utf-8"))
            except Exception: continue
            if isinstance(a, dict) and "attempt_id" in a and "state" in a: self.attempts[a["attempt_id"]] = a
    def events_since(self, aid, cursor):
        p = self.dir / "attempts" / f"{aid}.events.jsonl"
        if not p.exists(): return []
        return [e for e in map(json.loads, p.read_text("utf-8").splitlines()) if e["lseq"] > cursor]

    def public(self, a):
        keys = ("attempt_id", "state", "detail", "run_id", "sandbox", "created_at", "updated_at", "lseq", "queue_position", "retry_at", "rate_limited", "model")
        d = {k: a.get(k) for k in keys}
        if d["state"] == "queued": d["queue_position"] = self._queue().index(a["attempt_id"]) + 1 if a["attempt_id"] in self._queue() else None
        return d

    def _queue(self):
        return sorted([x["attempt_id"] for x in self.attempts.values() if x["state"] in ("queued", "backoff")], key=lambda i: self.attempts[i]["created_at"])

    def submit(self, aid, brief):
        with self.lock:
            if aid in self.attempts: return self.attempts[aid], False  # idempotent: never a second controller
            now = time.time()
            a = {"attempt_id": aid, "brief": brief, "state": "queued", "detail": "waiting for a worker slot", "created_at": now,
                 "updated_at": now, "lseq": 0, "cursor": 0, "rate_limited": 0, "model": self.cfg["model"]}
            self.attempts[aid] = a; self._save(a)
        self.kick(); return a, True

    def cancel(self, aid):
        with self.lock:
            a = self.attempts.get(aid)
            if not a: return None
            if a["state"] in TERMINAL: return a
            if a["state"] in ("queued", "backoff"): self._set(a, "cancelled", "cancelled before start")
            else: a["cancel"] = True; self._set(a, "cancel_requested", "interrupt sent")
        self.kick(); return a

    def _set(self, a, state, detail, ev=None):
        a["state"], a["detail"], a["updated_at"] = state, detail, time.time()
        a["lseq"] += 1
        e = {"lseq": a["lseq"], "ts": a["updated_at"], "kind": "state", "state": state, "detail": detail}
        if ev: e.update(ev)
        self._append_events(a, [e]); self._save(a)

    def _active(self): return [x for x in self.attempts.values() if x["state"] in ("starting", "running", "cancel_requested")]

    def kick(self): asyncio.run_coroutine_threadsafe(self._schedule(), self.loop)

    async def _schedule(self):
        with self.lock:
            # resume controllers for attempts that were live before a restart (reattach, no re-dispatch)
            for a in self._active():
                if a["attempt_id"] not in self.controllers and a.get("run_id"):
                    self.controllers[a["attempt_id"]] = asyncio.ensure_future(self._control(a))
                elif a["attempt_id"] not in self.controllers and a["state"] == "starting":
                    self._set(a, "failed", "launcher restarted during start; no run id recorded (retry from Orbit)")
            free = self.cfg["max_concurrent"] - len(self._active())
            for aid in self._queue():
                if free <= 0: break
                a = self.attempts[aid]
                if a["state"] == "backoff" and time.time() < a.get("retry_at", 0): continue
                free -= 1; self._set(a, "starting", "creating sandbox")
                self.controllers[aid] = asyncio.ensure_future(self._control(a))

    async def _control(self, a):
        aid = a["attempt_id"]
        try:
            if not a.get("run_id"):
                key = read_secret(self.cfg, "ORBIT_WORKER_GO_KEY")
                if not key: self._set(a, "failed", "provider key not configured on this PC"); return
                ids = await self.backend.start(a, key); del key
                a.update(ids); self._set(a, "running", "opencode run started", {"run_id": ids["run_id"]})
            while True:
                if a.get("cancel") and not a.get("interrupted"):
                    await self.backend.interrupt(a); a["interrupted"] = True
                    self._set(a, "cancelled", "interrupt confirmed; run stopped"); await self.backend.cleanup(a); return
                evs, cur = await self.backend.events(a, a["cursor"])
                with self.lock:
                    out = []
                    for e in evs:
                        a["lseq"] += 1; out.append(dict(e, lseq=a["lseq"], kind="worker:" + e["kind"]))
                    a["cursor"] = cur
                    if out: self._append_events(a, out); a["updated_at"] = time.time(); self._save(a)
                for e in evs:
                    if e["kind"] == "error" and RATE_LIMIT.search(e.get("text") or e.get("line") or ""):
                        return await self._backoff(a)
                    if e["kind"] in ("turn_ended", "exited"):
                        return await self._finish(a, e)
                await asyncio.sleep(1.0)
        except Exception as ex:  # noqa
            self._set(a, "failed", f"controller error: {type(ex).__name__}: {redact(str(ex))[:300]}")
            if not a.get("sandbox"): a["sandbox"] = "orbit-" + aid[-12:]  # created but not recorded yet
            try: await self.backend.cleanup(a)
            except Exception: pass
        finally:
            self.controllers.pop(aid, None); self.kick()

    async def _backoff(self, a):
        n = a["rate_limited"]; delays = self.cfg["backoff_s"]
        await self.backend.cleanup(a)
        if n >= len(delays): self._set(a, "failed", "provider rate limit persisted after retries"); return
        a["rate_limited"] = n + 1; a["retry_at"] = time.time() + delays[n]
        for k in ("run_id", "sandbox"): a.pop(k, None)
        a["cursor"] = 0
        self._set(a, "backoff", f"provider returned 429; retry {n + 1}/{len(delays)} in {delays[n]}s (queued)")
        self.loop.call_later(delays[n] + 0.05, self.kick)

    async def _finish(self, a, e):
        res = await self.backend.result(a)
        manifest = await self._manifest(a, res)
        (self.dir / "attempts" / f"{a['attempt_id']}.result.json").write_text(json.dumps(manifest, indent=1), "utf-8")
        ok = e.get("stop_reason") in ("end_turn", None) and not res.get("error") and e["kind"] == "turn_ended"
        self._set(a, "succeeded" if ok else "failed", f"turn ended: {e.get('stop_reason') or e['kind']}")
        await self.backend.cleanup(a)

    async def _manifest(self, a, res):
        b = a["brief"]; files = []
        env = patch = None
        if hasattr(self.backend, "patch"):
            try: env = await self.backend.environment(a)
            except Exception as ex: env = {"error": type(ex).__name__}
            patch = await self.backend.patch(a)
        for art in res.get("artifacts", []):
            files.append({"path": art["path"], "size": art["size"], "sha256": await self.backend.file_sha256(a, art["path"]),
                          "change": "deleted" if art.get("size") is None else "changed",
                          "in_assigned_scope": (not b.get("assigned_files")) or any(art["path"].startswith(x) for x in b["assigned_files"])})
        claims = {}
        m = re.findall(r"\{[\s\S]*\}", res.get("text") or "")
        if m:
            try: claims = json.loads(m[-1])
            except Exception: claims = {"unparsed": True}
        return {"schema": "orbit.local-worker.result/v1", "attempt_id": a["attempt_id"],
                "source": {"project": b.get("project"), "repo_rev": b.get("source_rev"), "input_manifest_sha256": b.get("input_manifest_sha256"),
                           "image": self.cfg["image"], "harness": "opencode", "model": self.cfg["model"], "launcher": VERSION},
                "observed": {"node": platform.node(), "run_id": a.get("run_id"), "sandbox_id": a.get("sandbox_id"), "workdir": a.get("workdir"), "local_base_rev": a.get("local_base_rev"),
                             "result_file": str(self.dir / "attempts" / f"{a['attempt_id']}.result.json"), "status": res.get("status"), "stop_reason": res.get("stop_reason"),
                             "tool_calls": res.get("tool_calls"), "usage": res.get("usage"), "files": (patch or {}).get("files") or files, "artifacts": files, "error": res.get("error")},
                "environment": env, "patch": patch,
                "worker_claims": claims, "checks": claims.get("checks", []) if isinstance(claims, dict) else [],
                "note": "worker_claims are self-reported by the model; only 'observed' was measured by the launcher"}

# ---------------------------------------------------------------- HTTP API
def make_handler(L, token):
    class H(BaseHTTPRequestHandler):
        server_version = "orbit-launcher/" + VERSION
        def log_message(self, *a): pass
        def _send(self, code, obj):
            body = json.dumps(obj).encode(); self.send_response(code)
            self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        def _auth(self):
            h = self.headers.get("Authorization", "")
            if not (h.startswith("Bearer ") and hmac.compare_digest(h[7:].encode(), token.encode())):
                self._send(401, {"error": "unauthorized"}); return False
            return True
        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n > 256_000: raise ValueError("body too large")
            return json.loads(self.rfile.read(n) or b"{}")
        def do_GET(self):
            if not self._auth(): return
            p = self.path.split("?")[0].strip("/").split("/"); q = dict(x.split("=", 1) for x in self.path.partition("?")[2].split("&") if "=" in x)
            if p == ["v1", "health"]:
                return self._send(200, {"ok": True, "version": VERSION, "max_concurrent": L.cfg["max_concurrent"], "active": len(L._active()), "queued": len(L._queue()), "model": L.cfg["model"]})
            if len(p) >= 3 and p[:2] == ["v1", "attempts"]:
                a = L.attempts.get(p[2])
                if not a: return self._send(404, {"error": "unknown attempt"})
                if len(p) == 3: return self._send(200, L.public(a))
                if p[3] == "events": return self._send(200, {"events": L.events_since(p[2], int(q.get("cursor", 0))), "state": a["state"], "cursor": a["lseq"]})
                if p[3] == "result":
                    f = L.dir / "attempts" / f"{p[2]}.result.json"
                    return self._send(200, json.loads(f.read_text("utf-8"))) if f.exists() else self._send(409, {"error": "no result yet", "state": a["state"]})
            self._send(404, {"error": "not found"})
        def do_POST(self):
            if not self._auth(): return
            p = self.path.strip("/").split("/")
            try: b = self._body()
            except Exception: return self._send(400, {"error": "bad json"})
            if p == ["v1", "attempts"]:
                aid = str(b.get("attempt_id", ""))
                if not re.fullmatch(r"[A-Za-z0-9_\-]{8,64}", aid): return self._send(400, {"error": "attempt_id required"})
                err = validate_brief(b.get("brief"))
                if err: return self._send(400, {"error": err})
                if b["brief"].get("project") and b["brief"]["project"] not in L.cfg["projects"]: return self._send(403, {"error": "project not authorized on this PC"})
                a, created = L.submit(aid, b["brief"]); return self._send(201 if created else 200, L.public(a))
            if len(p) == 4 and p[:2] == ["v1", "attempts"] and p[3] == "cancel":
                a = L.cancel(p[2]); return self._send(202, L.public(a)) if a else self._send(404, {"error": "unknown attempt"})
            self._send(404, {"error": "not found"})
    return H

def serve(cfg, backend_name="cua"):
    check_bind(cfg["bind"])
    tok_file = Path(cfg.get("api_token_file") or Path(cfg["data_dir"]) / "orbit-api.token")
    token = tok_file.read_text("utf-8").strip()
    if len(token) < 32: raise SystemExit("api token missing/too short; run scripts/new-token.ps1")
    backend = FakeBackend(cfg) if backend_name == "fake" else CuaBackend(cfg)
    L = Launcher(cfg, backend)
    threading.Thread(target=L.loop.run_forever, daemon=True).start(); L.kick()
    srv = ThreadingHTTPServer((cfg["bind"], cfg["port"]), make_handler(L, token))
    print(f"orbit-launcher {VERSION} on http://{cfg['bind']}:{cfg['port']} max_concurrent={cfg['max_concurrent']} model={cfg['model']}", flush=True)
    srv.serve_forever()

def doctor(cfg):
    ok = True
    def line(name, good, info=""):
        nonlocal ok; ok &= bool(good); print(f"[{'ok' if good else 'FAIL'}] {name} {info}")
    try: check_bind(cfg["bind"]); line("bind", True, cfg["bind"])
    except SystemExit as e: line("bind", False, str(e))
    line("go key present (value not shown)", bool(read_secret(cfg, "ORBIT_WORKER_GO_KEY")))
    tf = Path(cfg.get("api_token_file") or Path(cfg["data_dir"]) / "orbit-api.token"); line("orbit api token file", tf.exists(), str(tf))
    try:
        import cua; line("cua sdk", True, cua.cua_sdk_version())
        probs = sdk_contract_check(); line("cua sdk contract", not probs, "; ".join(probs))
    except Exception as e: line("cua sdk", False, type(e).__name__)
    line("max_concurrent", True, str(cfg["max_concurrent"])); line("model", True, cfg["model"] + " via " + cfg["base_url"])
    return 0 if ok else 1

async def _probe(cfg):
    """Read-only provider check INSIDE a real worker sandbox: same image, harness, endpoint and model as tasks."""
    key = read_secret(cfg, "ORBIT_WORKER_GO_KEY")
    if not key: print("[FAIL] go key not configured"); return 1
    be = CuaBackend(cfg)
    a = {"attempt_id": "probe-" + uuid.uuid4().hex[:8], "brief": {"objective": "Reply with exactly the text ORBIT-PROBE-OK and nothing else. Do not use any tools."}}
    try:
        ids = await be.start(a, key); del key; a.update(ids); cur, t0 = 0, time.time()
        while time.time() - t0 < 300:
            evs, cur = await be.events(a, cur)
            for e in evs:
                if e["kind"] == "error": print("[FAIL] provider error:", e["line"][:300]); return 1
                if e["kind"] in ("turn_ended", "exited"):
                    res = await be.result(a); ok = "ORBIT-PROBE-OK" in (res.get("text") or "")
                    print(f"[{'ok' if ok else 'FAIL'}] model={cfg['model']} endpoint={cfg['base_url']} stop={res.get('stop_reason')} usage={res.get('usage')}")
                    return 0 if ok else 1
            await asyncio.sleep(1)
        print("[FAIL] no reply within 300s"); return 1
    finally:
        await be.cleanup(a)

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("cmd", choices=["serve", "doctor", "probe", "sdkcheck"]); ap.add_argument("--config")
    ap.add_argument("--backend", default="cua", choices=["cua", "fake"])
    a = ap.parse_args(); cfg = load_config(a.config) if a.config else None
    sys.exit((print(json.dumps(sdk_contract_check())) or (1 if sdk_contract_check() else 0)) if a.cmd == "sdkcheck" else doctor(cfg) if a.cmd == "doctor" else asyncio.run(_probe(cfg)) if a.cmd == "probe" else serve(cfg, a.backend))
