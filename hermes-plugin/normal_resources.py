"""Pinned gateway ContextVar -> host-issued per-run resource channel.

No env fallback, model-selected identity, shared grant key, or owner capability.
The directory is trusted profile configuration; every key file is run-specific.
"""
import hashlib
import json
from pathlib import Path
import re
import threading
import time

from .resources import SCHEMA, register as register_channel

PINNED_SOURCES = {
    "tools/approval_context.py": "8403ee3127964c14286e527874eea49ca0bdf33bde1c8209752027e73a915869",
    "gateway/session_context.py": "76cb6383168db1c6fd8f70f963e1436b101a9f810f13724cd812bf57a777dbe2",
    "gateway/platforms/api_server_runs.py": "67315fb146f3f5d124675c4dd0e2c5fbe233618c94af2799c438175592dfba97",
    "tools/daemon_pool.py": "e4342132b48d1840d9be69a20677b329b652c87a7644e4be7557e862d050e072",
    "gateway/platforms/api_server.py": "ed8833b0011168234d88126c46008fff70ab06ae47829830d4d0d73457e20297",
    "agent/tool_executor.py": "38585996a589dd87406bd6206e05b49c3e0e1c9fa2321f874c1c4d5c891b0e9e",
    "tools/thread_context.py": "3d9e921fed5fedf8f6cccbd7e8ef9b12659b4c8f6872fcda27ddf81632ee1d12",
    "agent/delegation_context.py": "456d2f7815ba5d81c992810f6d8b4305394cc41056ffa79f71974c63ab89d1fc",
}


def trusted_context():
    from tools import approval_context
    from gateway import session_context
    from agent.delegation_context import is_delegated_child_context
    # These private fields are intentionally source-pinned. Public getters may
    # fall back to process environment and MUST NOT authorize a private resource.
    run = approval_context._approval_session_key.get()
    session = session_context._SESSION_ID.get()
    profile = session_context._SESSION_PROFILE.get()
    platform = session_context._SESSION_PLATFORM.get()
    if (is_delegated_child_context() or platform != "api_server" or session_context._SESSION_KEY.get() != run or
            not isinstance(run, str) or not re.fullmatch(r"run_[a-zA-Z0-9_-]{8,100}", run) or
            not isinstance(session, str) or not session or not isinstance(profile, str)):
        raise ValueError("No trusted Normal run context")
    return run, session, profile


def verify_runtime():
    from tools import approval_context
    root = Path(approval_context.__file__).resolve().parents[1]
    for name, digest in PINNED_SOURCES.items():
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest:
            raise ValueError("Unverified Hermes context contract")


def register(ctx):
    directory = Path(ctx.get_config("normal_resource_directory", ""))
    verified = False
    try:
        if not directory.is_absolute():
            raise ValueError("Absolute private directory required")
        verify_runtime()
        verified = True
    except Exception:
        pass
    channels = {}
    lock = threading.Lock()

    def handle(params, **kwargs):
        del kwargs  # Handler session/task strings never choose authority.
        if not verified:
            return json.dumps({"ok": False, "code": "normal_context_unavailable", "outcome": "not_started"})
        try:
            identity = trusted_context()
            run, session, profile = identity
            filename = directory / (run + ".json")
            # The gateway may begin tool execution before POST /runs reaches the
            # host. Wait only for channel publication; never retry an effect.
            for attempt in range(21):
                if filename.exists():
                    break
                if attempt == 20:
                    raise ValueError("No grant for this run")
                time.sleep(.1)
            with lock:
                stat = filename.lstat()
                if filename.is_symlink() or not filename.is_file() or stat.st_mode & 0o077 or stat.st_size > 8192:
                    raise ValueError("Invalid private channel")
                channel = json.loads(filename.read_text())
                if (channel.get("run_id"), channel.get("session_id"), channel.get("hermes_profile")) != identity:
                    raise ValueError("Run/profile/session mismatch")
                if identity not in channels:
                    if len(channels) >= 64:
                        raise ValueError("Adapter channel retention exhausted")
                    class ChannelContext:
                        def get_config(self, key, default=None):
                            return str(filename) if key == "resource_channel_file" else default
                        def register_tool(self, **tool):
                            self.handler = tool["handler"]
                    local = ChannelContext()
                    register_channel(local)
                    channels[identity] = local.handler
                handler = channels[identity]
            if trusted_context() != identity:
                raise ValueError("Run context changed")
            return handler(params)
        except Exception:
            return json.dumps({"ok": False, "code": "normal_grant_unavailable", "outcome": "not_started"})

    schema = {**SCHEMA, "description": SCHEMA["description"].replace("dedicated local recipient's", "authenticated Normal run's") + " Authority is bound to this exact accepted run by the pinned gateway's private ContextVars. A grant for another run or conversation is unavailable."}
    ctx.register_tool(name="orbit_resources", toolset="orbit_resources", schema=schema, handler=handle)
