"""Read and preview only in the explicitly supplied live Orbit workspace."""
import importlib.util
import json
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("orbit_plugin", Path(__file__).resolve().parents[1] / "hermes-plugin/__init__.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Context:
    def get_config(self, key, default=None):
        return {"runtime_dir": sys.argv[1], "workspace_id": sys.argv[2]}.get(key, default)

    def register_tool(self, **kwargs):
        self.handler = kwargs["handler"]


ctx = Context()
module.register(ctx)
read = json.loads(ctx.handler({"action": "read"}))
assert read["ok"], read
state = read["result"]
preview = json.loads(ctx.handler({"action": "preview", "base_revision": state["revision"], "operations": [{"action": "sidebar", "hidden": state["state"].get("sidebarHidden", False)}]}))
assert preview["ok"], preview
print(json.dumps({"read": "passed", "preview": "passed", "revision": state["revision"], "observed_revision": state.get("observed_revision"), "mutations": "none"}))
