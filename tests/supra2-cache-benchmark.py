"""Real CPU inference, paired cached/uncached images; no network access."""
import hashlib
import json
from pathlib import Path
import statistics
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'extensions/supra2-studio'))
from warm import WarmWorker, BASE
w = WarmWorker()
rows = []
try:
    for i, (seed, steps, cfg, enabled) in enumerate([
        (42,20,3,True), (42,20,3,False), (42,20,3,True),
        (43,10,1,True), (43,10,1,False),
        (44,20,3,False), (44,20,3,True),
        (45,20,3,True), (45,20,3,False),
    ]):
        out = BASE / f'cache-bench-{i}.png'
        result = w.generate(dict(prompt='a small red sailboat on a turquoise sea, watercolor', seed=seed, steps=steps, cfg=cfg, prompt_cache=enabled, out=str(out)))
        assert out.read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
        row = dict(result, seed=seed, steps=steps, cfg=cfg, enabled=enabled, sha256=hashlib.sha256(out.read_bytes()).hexdigest())
        rows.append(row)
        print(json.dumps(row), flush=True)
    for seed in (42,43,44,45):
        assert len({r['sha256'] for r in rows if r['seed']==seed}) == 1
    assert not rows[0]['prompt_cache_hit']
    assert all(r['prompt_cache_hit'] == r['enabled'] for r in rows[1:])
    warm20 = [r for r in rows[1:] if r['steps']==20]
    print(json.dumps({str(flag): statistics.median(r['generation_seconds'] for r in warm20 if r['enabled']==flag) for flag in (False,True)}))
finally:
    w.close()
(BASE / 'prompt-cache-benchmark.json').write_text(json.dumps(rows, indent=2)+'\n')
