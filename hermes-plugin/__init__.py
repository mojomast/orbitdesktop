"""Hermes adapter for an existing Orbit deployment; no import-time I/O."""
import ipaddress
import json
from pathlib import Path
import re
import uuid
import urllib.error
import urllib.parse
import urllib.request

UUID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")
# BEGIN GENERATED WORKSPACE LIMITS
maxOperations = 32
maxRequestBytes = 150000
maxResponseBytes = 2000000
maxLabelCharacters = 120
# END GENERATED WORKSPACE LIMITS
ACTIONS = ("read", "preview", "apply", "history", "checkpoint", "restore")
MUTATIONS = ("apply", "checkpoint", "restore")
OPERATION_ID = re.compile(r"[a-zA-Z0-9_.:-]{1,128}")
SCHEMA = {
    "name": "orbit_workspace",
    "description": (
        "Read or edit the Orbit workspace explicitly configured for this Hermes profile. "
        "Read first; use actual IDs and revision. Preview before large edits. "
        "Apply/restore require base_revision; do not retry conflicts blindly. "
        "Restore requires the user's explicit rollback request and confirm=true. "
        "State does not expose terminal buffers or iframe contents. observed_revision "
        "acknowledges synchronization, not visual correctness. Browser display may lag."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": list(ACTIONS)},
            "base_revision": {"type": "integer", "minimum": 0},
            "operations": {"type": "array", "items": {"type": "object"}, "minItems": 1, "maxItems": maxOperations},
            "label": {"type": "string", "maxLength": maxLabelCharacters},
            "checkpoint_id": {"type": "string"},
            "confirm": {"type": "boolean"},
            "operation_id": {"type": "string", "pattern": "^[a-zA-Z0-9_.:-]{1,128}$"},
            "intent": {"type": "string", "minLength": 1, "maxLength": 160},
        },
        "required": ["action"],
        "additionalProperties": False,
    },
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def endpoint(api):
    """Only numeric loopback destinations; never forward a capability remotely."""
    url = urllib.parse.urlsplit(api)
    if url.scheme not in ("http", "https") or url.username or url.password:
        raise ValueError("Orbit API must be an HTTP(S) numeric loopback origin")
    if not ipaddress.ip_address(url.hostname or "").is_loopback:
        raise ValueError("Orbit API must be a numeric loopback origin")
    if url.path not in ("", "/") or url.query or url.fragment:
        raise ValueError("Orbit API must be an origin without path, query or fragment")
    _ = url.port  # Validate malformed/out-of-range ports.
    return api.rstrip("/") + "/api/workspace/control"


def invoke(ctx, params):
    if not isinstance(params, dict) or params.get("action") not in ACTIONS:
        raise ValueError("Unknown workspace action")
    action = params["action"]
    allowed = {"action"}
    if action in ("apply", "preview"):
        allowed |= {"base_revision", "operations"}
    elif action == "restore":
        allowed |= {"base_revision", "checkpoint_id", "confirm"}
    elif action == "checkpoint":
        allowed |= {"label", "base_revision"}
    if action in MUTATIONS:
        allowed |= {"operation_id", "intent"}
    if set(params) - allowed:
        raise ValueError("Unexpected fields for workspace action")
    if action in MUTATIONS and ctx.get_config("allow_mutations", False) is not True:
        raise ValueError("Workspace mutations are disabled in this profile's plugin settings")
    if action in ("apply", "preview", "restore") or (action == "checkpoint" and "base_revision" in params):
        revision = params.get("base_revision")
        if type(revision) is not int or revision < 0:
            raise ValueError("Read the workspace first and supply its base_revision")
    if action in MUTATIONS and action != "checkpoint" and type(params.get("base_revision")) is not int:
        raise ValueError("Read the workspace first and supply its base_revision")
    if action in ("apply", "preview"):
        ops = params.get("operations")
        if not isinstance(ops, list) or not 1 <= len(ops) <= maxOperations or not all(isinstance(op, dict) for op in ops):
            raise ValueError("Provide 1–32 operation objects; Orbit validates each operation")
    if action == "restore" and (params.get("confirm") is not True or not isinstance(params.get("checkpoint_id"), str) or not params["checkpoint_id"]):
        raise ValueError("Restore requires checkpoint_id and explicit confirm=true")
    if action == "checkpoint" and (not isinstance(params.get("label", ""), str) or len(params.get("label", "")) > maxLabelCharacters):
        raise ValueError("Checkpoint label must be a string of at most 120 characters")
    if "operation_id" in params and (not isinstance(params["operation_id"], str) or not OPERATION_ID.fullmatch(params["operation_id"])):
        raise ValueError("Invalid operation_id")
    if "intent" in params and (not isinstance(params["intent"], str) or not 1 <= len(params["intent"]) <= 160):
        raise ValueError("Invalid intent")
    if "operation_id" in params and ("intent" not in params or "base_revision" not in params):
        raise ValueError("operation_id requires intent and base_revision")
    workspace = ctx.get_config("workspace_id", "")
    runtime = ctx.get_config("runtime_dir", "")
    if not isinstance(workspace, str) or not UUID.fullmatch(workspace):
        raise ValueError("Configure this profile's explicit workspace_id; workspaces are never auto-discovered")
    if not isinstance(runtime, str) or not Path(runtime).is_absolute():
        raise ValueError("Configure this profile's absolute runtime_dir")
    projection = Path(runtime) / "workspace-access" / (workspace + ".json")
    if not projection.exists() and (Path(runtime) / "workspace.sqlite").exists():
        raise ValueError("Invalid Orbit connection projection; restart/reconcile the server")
    record = projection if projection.exists() else Path(runtime) / "workspaces" / (workspace + ".json")
    config = json.loads(record.read_text())
    target = endpoint(config["api"])
    capability = config["capability"]
    if not isinstance(capability, str) or not capability or "\n" in capability or "\r" in capability:
        raise ValueError("Invalid Orbit capability record")
    request_params = dict(params)
    if action in MUTATIONS:
        request_params.setdefault("operation_id", str(uuid.uuid4()))
        request_params.setdefault("intent", action)
        if action == "checkpoint" and "base_revision" not in request_params:
            read_body = json.dumps({"action": "read", "workspace_id": workspace}).encode()
            read_request = urllib.request.Request(target, data=read_body, headers={
                "Authorization": "Bearer " + capability, "Content-Type": "application/json",
            })
            try:
                with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(read_request, timeout=20) as response:
                    read_raw = response.read(maxResponseBytes + 1)
            except urllib.error.HTTPError as error:
                return {"ok": False, "status": error.code, "error": "Orbit rejected the request; check authorization and operation schema"}
            if len(read_raw) > maxResponseBytes or capability.encode() in read_raw:
                raise ValueError("Invalid Orbit read response")
            request_params["base_revision"] = json.loads(read_raw)["revision"]
    body = json.dumps({**request_params, "workspace_id": workspace}).encode()
    if len(body) > maxRequestBytes:
        raise ValueError("Workspace request is too large")
    request = urllib.request.Request(target, data=body, headers={
        "Authorization": "Bearer " + capability, "Content-Type": "application/json",
    })
    # Disable ambient proxy settings and redirects so credentials stay on loopback.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=20) as response:
            raw = response.read(maxResponseBytes + 1)
    except urllib.error.HTTPError as error:
        # Server error bodies may contain sensitive material; do not echo them.
        return {"ok": False, "status": error.code, "error": (
            "Revision conflict: read and reconsider the requested change" if error.code == 409
            else "Orbit rejected the request; check authorization and operation schema"
        )}
    except (urllib.error.URLError, TimeoutError, OSError):
        if action in MUTATIONS:
            return {"ok": False, "outcome": "unknown", "operation_id": request_params["operation_id"], "base_revision": request_params["base_revision"], "error": "Mutation outcome unknown. Reuse the exact key and payload or read before reconsidering; never blindly create a new mutation."}
        return {"ok": False, "error": "Orbit unavailable"}
    if len(raw) > maxResponseBytes:
        raise ValueError("Workspace response exceeds the size limit")
    if capability.encode() in raw:
        raise ValueError("Refusing a response containing the workspace capability")
    return {"ok": True, "result": json.loads(raw)}


def register(ctx):
    def handle(params, **kwargs):
        del kwargs
        try:
            result = invoke(ctx, params)
        except ValueError as error:
            # Only our validation messages are safe; JSON and URL parser errors are not.
            result = {"ok": False, "error": "Invalid workspace request or configuration"}
            if type(error) is ValueError and str(error).startswith(("Unknown ", "Unexpected ", "Workspace mutations", "Read the ", "Provide ", "Restore requires", "Checkpoint label", "Configure this", "Orbit API must", "Workspace request", "Workspace response", "Refusing ", "Invalid Orbit")):
                result["error"] = str(error)
        except Exception:
            result = {"ok": False, "error": "Orbit unavailable or runtime record invalid; check the local deployment"}
        return json.dumps(result)

    ctx.register_tool(name="orbit_workspace", toolset="orbit_desktop", schema=SCHEMA, handler=handle)
