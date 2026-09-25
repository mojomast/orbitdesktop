"""Add/select the catalog in the explicitly supplied owner workspace."""
from pathlib import Path
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
if len(sys.argv) != 2:
    raise SystemExit('Usage: open_plugin_catalog.py WORKSPACE_ID')
controller = ['python3', str(ROOT / 'scripts/workspace_control.py'), '--workspace', sys.argv[1]]
state = json.loads(subprocess.check_output(controller + ['read'], text=True))
config = json.loads((ROOT / '.runtime/plugin-catalog/config.json').read_text())
url = config['public_origin'] + '/'
def panes(node):
    if node['type'] == 'pane':
        return [node['pane']]
    return panes(node['first']) + panes(node['second'])
existing = next((w for w in state['state']['monitors'] if any(p.get('url') == url for p in panes(w['layout']))), None)
if existing:
    operation = {'action': 'select', 'window_id': existing['id']}
else:
    operation = {'action': 'add_window', 'kind': 'browser', 'name': 'Hermes · Plugin Catalog', 'url': url,
                 'frame': {'x': 280, 'y': 90, 'width': 1440, 'height': 1100,
                           'z': max(w.get('frame', {}).get('z', 0) for w in state['state']['monitors']) + 1}}
result = json.loads(subprocess.check_output(controller + ['apply', json.dumps(operation), '--base-revision', str(state['revision'])], text=True))
(ROOT / '.runtime/plugin-catalog/workspace-result.json').write_text(json.dumps(result, indent=2))
print(json.dumps({k: v for k, v in result.items() if k not in ('state', 'app_versions')}, indent=2))
