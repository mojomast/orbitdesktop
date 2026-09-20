"""Read-only aggregate token export. No prompts, credentials, or session IDs published."""
import os
import json
import sqlite3
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = Path('/home/mojo/.hermes-instances/fresh/state.db')
OUTPUT = ROOT / '.runtime/apps/hermes-token-stats/usage.json'

def snapshot():
    with sqlite3.connect(f'file:{DB}?mode=ro', uri=True, timeout=5) as db:
        db.row_factory = sqlite3.Row
        fields = 'count(*) sessions, coalesce(sum(input_tokens),0) input, coalesce(sum(output_tokens),0) output, coalesce(sum(cache_read_tokens),0) cached, coalesce(sum(reasoning_tokens),0) reasoning, coalesce(sum(api_call_count),0) calls'
        profile = dict(db.execute(f'SELECT {fields} FROM sessions').fetchone())
        orbit = dict(db.execute(f"SELECT {fields} FROM sessions WHERE id LIKE 'orbit-%'").fetchone())
    return {'updated_at': time.time(), 'profile': profile, 'orbit': orbit, 'source': 'Hermes saved session counters'}

def main():
    data = snapshot()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    # Live data is not a new app build; keep the app-version watcher stable.
    directory_stat = OUTPUT.parent.stat()
    stamp = (OUTPUT.parent / 'index.html').stat().st_mtime
    temporary = OUTPUT.with_name('.usage.tmp')
    temporary.write_text(json.dumps(data))
    os.utime(temporary, (stamp, stamp))
    temporary.replace(OUTPUT)
    os.utime(OUTPUT.parent, ns=(directory_stat.st_atime_ns, directory_stat.st_mtime_ns))
    print(json.dumps(data))

if __name__ == '__main__':
    main()
