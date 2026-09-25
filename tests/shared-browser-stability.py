"""Live opt-in regression: isolated test tab, no user navigation or browser close.
Run using .runtime/browser-venv/bin/python tests/shared-browser-stability.py.
"""
import json
import subprocess
import time
from playwright.sync_api import sync_playwright


def state():
    return json.loads(subprocess.check_output([
        'docker', 'inspect', 'orbit-shared-browser', '--format', '{{json .State}}'
    ]))['StartedAt']


def resources():
    raw = subprocess.check_output([
        'docker', 'exec', 'orbit-shared-browser', 'python3', '-c',
        "import json; from pathlib import Path; print(json.dumps({n:Path('/sys/fs/cgroup/'+n).read_text().strip() for n in ['pids.current','pids.max','pids.events','memory.events']}))"
    ])
    return json.loads(raw)


started = state()
before = resources()
with sync_playwright() as pw:
    browser = pw.chromium.connect_over_cdp('http://127.0.0.1:4345', timeout=10000)
    original = [p.url for p in browser.contexts[0].pages]
    page = browser.contexts[0].new_page()
    try:
        page.set_content('<title>Orbit stability regression</title><p>Temporary worker test</p>')
        # Idle workers consume real threads without a CPU-intensive stress loop.
        count = page.evaluate('''async () => {
            window.workers = [];
            const url = URL.createObjectURL(new Blob([
                "postMessage('ready'); onmessage = () => postMessage('pong')"
            ], {type: 'text/javascript'}));
            await Promise.all(Array.from({length: 96}, () => new Promise((resolve, reject) => {
                const w = new Worker(url); workers.push(w);
                const timer = setTimeout(() => reject(new Error('worker startup timeout')), 15000);
                w.onmessage = () => { clearTimeout(timer); resolve(); };
                w.onerror = () => { clearTimeout(timer); reject(new Error('worker startup failed')); };
            })));
            URL.revokeObjectURL(url);
            return workers.length;
        }''')
        loaded = resources()
        latencies = []
        for _ in range(20):
            t = time.monotonic()
            # Independent CLI processes exercise connect AND disconnect cleanup.
            subprocess.run(['.runtime/browser-venv/bin/python', 'scripts/shared_browser.py', 'tabs'],
                           check=True, stdout=subprocess.DEVNULL, timeout=20)
            latencies.append(time.monotonic() - t)
        assert page.title() == 'Orbit stability regression'
        assert [p.url for p in browser.contexts[0].pages if p != page] == original
    finally:
        page.close()  # Only the test-owned page, never the shared browser/context.
assert state() == started, 'Browser container restarted during test'
after = resources()
assert before['pids.events'] == after['pids.events'], 'PID limit hit during test'
print(json.dumps({'passed': True, 'workers': count, 'connections': len(latencies),
                  'max_connection_seconds': round(max(latencies), 3),
                  'before': before, 'loaded': loaded, 'after': after,
                  'container_restart': False, 'user_tabs_preserved': True}, indent=2))
