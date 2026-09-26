"""Attempt-local authenticated Workbench tools and pinned Hermes runner.

No owner capability, scope ID or channel secret is a model parameter. Registration
uses Hermes PluginContext; an empty native_channel_file leaves this tool absent.
"""
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import socket
import threading

TOOL = "orbit_workbench"
SCHEMA = {
    "name": TOOL,
    "description": "Operate only on this owner-approved Workbench attempt. Inspect first. Read approved context/candidate files; apply expected-hash multi-file changes; run the fixed approved check and inspect its recorded evidence. No host shell or original-project writes.",
    "parameters": json.loads(Path(__file__).with_name('workbench-tool-schema.json').read_text()),
}
# Authoritative model-argument properties are generated from the server contract.
# Server per-action validation remains stricter than this compact tool envelope.


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, filename):
        super().__init__("localhost", timeout=180)
        self.filename = filename

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.filename)


def register(ctx):
    filename = ctx.get_config("native_channel_file", "")
    if not filename:
        return
    channel = json.loads(Path(filename).read_text())
    lock = threading.Lock()
    sequence = 0

    def handle(params, **kwargs):
        nonlocal sequence
        del kwargs  # Hermes request context is not Orbit authorization.
        with lock:
            connection = None
            try:
                if not isinstance(params, dict) or set(params) - set(SCHEMA["parameters"]["properties"]):
                    raise ValueError("unexpected arguments")
                raw = json.dumps(params, separators=(",", ":"), ensure_ascii=False).encode()
                if len(raw) > 300000:
                    raise ValueError("request too large")
                sequence += 1
                mac = hmac.new(channel["secret"].encode(), str(sequence).encode() + b"\n" + raw, hashlib.sha256).hexdigest()
                connection = UnixConnection(channel["socket"])
                connection.request("POST", "/tool", raw, {"Content-Type": "application/json", "X-Orbit-Grant": channel["grant_id"], "X-Orbit-Sequence": str(sequence), "X-Orbit-Mac": mac})
                response = connection.getresponse()
                result = response.read(524289)
                if len(result) > 524288 or channel["secret"].encode() in result:
                    raise ValueError("unsafe response")
                return json.dumps(json.loads(result))
            except Exception:
                # Mutations are never replayed after an ambiguous transport loss.
                return json.dumps({"ok": False, "error": "native_channel_rejected_or_outcome_unknown"})
            finally:
                if connection:
                    connection.close()

    ctx.register_tool(name=TOOL, toolset=TOOL, schema=SCHEMA, handler=handle)


def runtime():
    with os.fdopen(3) as stream:
        config = json.load(stream)
    from hermes_cli.plugins import discover_plugins
    discover_plugins()
    from run_agent import AIAgent
    agent = AIAgent(base_url=config["endpoint"], api_key=config["api_key"], provider="custom", api_mode="chat_completions", model=config["model"], enabled_toolsets=[TOOL], max_iterations=config["max_iterations"], session_id=config["session_id"], quiet_mode=True, save_trajectories=False, verbose_logging=False, skip_context_files=True, skip_memory=True, skip_background_review=True, checkpoints_enabled=False)
    # Pinning alone is insufficient: fail closed if upstream policy adds tools.
    if set(agent.valid_tool_names) != {TOOL}:
        raise RuntimeError("Hermes native tool allowlist mismatch: " + repr(sorted(agent.valid_tool_names)))
    result = agent.run_conversation(config["input"])
    # FD4 is the sole public terminal-result channel. Never serialize Hermes
    # messages, tool transcripts, errors, reasoning or ambient process state.
    text = result.get("final_response")
    if not isinstance(text, str):
        text = ""
    frame = json.dumps({"version": 1, "type": "final_response", "text": text,
                        "completed": result.get("completed") is True and not result.get("error")},
                       ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
    with os.fdopen(4, "wb", buffering=0) as output:
        output.write(frame)
    if result.get("error") or result.get("completed") is not True:
        raise RuntimeError("Hermes conversation failed")
    print(json.dumps({"native_runtime": "completed", "tools": [TOOL]}))


if __name__ == "__main__":
    runtime()
