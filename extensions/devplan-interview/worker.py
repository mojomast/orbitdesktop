"""Tool-free planning conversation using the owner's configured Hermes model."""
import contextlib
import json
import sys

payload = json.load(sys.stdin)
with contextlib.redirect_stdout(sys.stderr):
    from gateway.run import _resolve_runtime_agent_kwargs, _resolve_gateway_model
    from run_agent import AIAgent
    runtime = _resolve_runtime_agent_kwargs()
    if runtime.get('provider') == 'openai-codex':
        from hermes_cli.auth import resolve_codex_runtime_credentials
        credentials = resolve_codex_runtime_credentials()
        runtime['api_key'] = credentials['api_key']
    model = runtime.pop('model', None) or _resolve_gateway_model()
    runtime.pop('max_tokens', None)
    agent = AIAgent(**runtime, model=model, enabled_toolsets=[], max_iterations=2,
                    max_tokens=3000, quiet_mode=True, skip_memory=True,
                    skip_context_files=True, skip_background_review=True,
                    save_trajectories=False, load_soul_identity=False)
    if getattr(agent, 'tools', []):
        raise RuntimeError('Interview must have no tools')
    result = agent.run_conversation(payload['input'], system_message=payload['instructions'])
print(json.dumps({'output': result['final_response'], 'model': model}))
