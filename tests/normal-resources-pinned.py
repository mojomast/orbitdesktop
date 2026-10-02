"""Actual pinned gateway run context + tool registry, deterministic agent body.
No AIAgent/provider inference: only the run lifecycle and dispatch seams are real.
Run from normal-resources.test.mjs with an explicitly supplied pinned environment.
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
from contextlib import nullcontext
from types import SimpleNamespace

config = json.load(sys.stdin)
root = Path(__file__).resolve().parents[1]
os.makedirs(os.environ['HERMES_HOME'], mode=0o700, exist_ok=True)
from gateway.platforms.api_server import APIServerAdapter
from gateway.platforms.api_server_runs import _RunLaunch, _run_agent_sync
from tools.registry import registry
from tools.daemon_pool import DaemonThreadPoolExecutor
from tools.thread_context import propagate_context_to_thread
from agent.delegation_context import delegated_child_context

spec = importlib.util.spec_from_file_location('orbit_normal_fixture', root / 'hermes-plugin/__init__.py', submodule_search_locations=[str(root / 'hermes-plugin')])
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)

class Context:
    def get_config(self, key, default=None):
        return config['directory'] if key == 'normal_resource_directory' else default
    def register_tool(self, **kwargs):
        registry.register(**kwargs)

plugin.register(Context())
def call(body):
    # Deliberately forged handler kwargs cannot select a recipient or deny the
    # actual bound one; only gateway-owned ContextVars select the per-run file.
    return json.loads(registry.dispatch('orbit_resources', body, session_id='forged', task_id='forged'))

os.environ['HERMES_SESSION_KEY'] = config['run_id']
os.environ['HERMES_SESSION_ID'] = config['session_id']
os.environ['HERMES_SESSION_PROFILE'] = ''
assert call({'action':'describe'})['code'] == 'normal_grant_unavailable'

gateway = SimpleNamespace(
    _profile_scope=lambda profile:nullcontext(),
    _bind_api_server_session=APIServerAdapter._bind_api_server_session,
    _memory_sessions=SimpleNamespace(checkin=lambda agent:None),
)
api_hooks = SimpleNamespace(_publish_turn_process_ownership=lambda *a:None, _clear_turn_process_ownership=lambda *a:None)

def execute(run_id, session_id, profile, body):
    agent = SimpleNamespace(session_id=session_id, run_conversation=lambda **kwargs:body())
    launch = _RunLaunch(owner=gateway,run_id=run_id,queue=None,session_id=session_id,gateway_session_key=None,
        declared_selected=False,user_message='Synthetic tool journey',conversation_history=[],session_history_delivery=False,
        agent_kwargs={'room_dispatch':None},request_profile=profile,browser_control_principal='',browser_control_transport_family='')
    return _run_agent_sync(gateway, launch, agent, lambda data:None, _api_server=api_hooks)[0]

def journey():
    with DaemonThreadPoolExecutor(max_workers=2) as workers:
        # Same worker propagation functions used by real sequential/concurrent
        # tool executor paths. The actual gateway bound/reset all run contexts.
        found = workers.submit(propagate_context_to_thread(call), {'action':'search','query':'Mars SECRET'}).result()
        assert found['ok'], found
        assert len(found['result']['results']) == 1
        source = found['result']['results'][0]
        exact = workers.submit(call, {'action':'read_source','source_id':source['source_id']}).result()
        assert exact['result']['text'] == 'Mars has two moons.'
        with delegated_child_context(config['other_session']):
            assert workers.submit(call, {'action':'describe'}).result()['code'] == 'normal_grant_unavailable'
        saved = workers.submit(call, {'action':'create_document','op_id':config['op_id'],'title':'Pinned Normal cited brief','text':'Mars has two moons.',
            'citations':[{key:source[key] for key in ('source_id','content_sha256','char_start','char_end')}]}).result()
        assert saved.get('saved'), saved
        return saved

with DaemonThreadPoolExecutor(max_workers=4) as pool:
    good = pool.submit(execute, config['run_id'], config['session_id'], '', journey)
    wrong_session = pool.submit(execute, config['run_id'], config['other_session'], '', lambda:call({'action':'describe'}))
    wrong_profile = pool.submit(execute, config['run_id'], config['session_id'], 'other', lambda:call({'action':'describe'}))
    wrong_run = pool.submit(execute, 'run_other_ungranted', config['session_id'], '', lambda:call({'action':'describe'}))
    saved=good.result()
    for future in (wrong_session, wrong_profile, wrong_run):
        assert future.result()['code'] == 'normal_grant_unavailable', future.result()
assert call({'action':'describe'})['code'] == 'normal_grant_unavailable'
print(json.dumps({'saved':saved,'concurrent_isolation':True,'no_env_fallback':True,'no_child_inheritance':True}))
