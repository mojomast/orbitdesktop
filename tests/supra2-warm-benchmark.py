"""Real local inference timing; no remote calls, one worker at a time."""
import hashlib
import json
from pathlib import Path
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'extensions/supra2-studio'))
from warm import WarmWorker, BASE
results = []
for threads in (4, 8, 16):
    worker = WarmWorker(threads=threads)
    try:
        for iteration in range(3):
            path = BASE / f'bench-{threads}-{iteration}.png'
            start = time.monotonic()
            result = worker.generate(dict(prompt='a small red sailboat on a turquoise sea, watercolor', seed=42, steps=20, cfg=3, out=str(path)))
            result.update(threads=threads, iteration=iteration, total_seconds=round(time.monotonic()-start,3), sha256=hashlib.sha256(path.read_bytes()).hexdigest())
            assert path.read_bytes()[:8] == b'\x89PNG\r\n\x1a\n'
            results.append(result)
            print(json.dumps(result), flush=True)
    finally:
        worker.close()
(BASE / 'warm-benchmark.json').write_text(json.dumps(results, indent=2)+'\n')
