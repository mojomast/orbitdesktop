"""Readiness checks for real owner workspace browser fixtures."""
import time
from urllib.parse import urlsplit


def wait_for_workspace_connection(page, timeout=15000):
    """Wait for a browser read that acknowledges the server's current revision.

    The shared save label is transient: a local layout save overwrites it. Polls
    continue after unlock, so this works even when the first response has already
    arrived. It neither injects a token nor makes an independent API request.
    """
    origin = urlsplit(page.url)
    endpoint = f'{origin.scheme}://{origin.netloc}/api/workspace'
    workspace = page.evaluate('localStorage.getItem("orbit.workspace.id")')
    deadline = time.monotonic() + timeout / 1000
    while time.monotonic() < deadline:
        with page.expect_response(lambda response: response.url == endpoint
                and response.status == 200 and response.request.method == 'POST'
                and (response.request.post_data_json or {}).get('action') == 'read'
                and (response.request.post_data_json or {}).get('workspace_id') == workspace,
                timeout=max(1, (deadline - time.monotonic()) * 1000)) as observed:
            pass
        response = observed.value
        state = response.json()
        revision = state.get('revision')
        acknowledged = (response.request.post_data_json or {}).get('observed_revision', -1)
        if state.get('state') and type(revision) is int and type(acknowledged) is int and acknowledged >= revision:
            return state
    raise AssertionError('Browser did not acknowledge the authoritative workspace revision')
