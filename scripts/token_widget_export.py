"""Read-only aggregate token export. No prompts, credentials, or session IDs published."""
import os
import json
import sqlite3
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = Path('/home/mojo/.hermes-instances/fresh/state.db')
OUTPUT = ROOT / '.runtime/apps/hermes-token-stats/usage.json'

def snapshot(since=None):
    with sqlite3.connect(f'file:{DB}?mode=ro', uri=True, timeout=5) as db:
        db.row_factory = sqlite3.Row
        fields = 'count(*) sessions, coalesce(sum(input_tokens),0) input, coalesce(sum(output_tokens),0) output, coalesce(sum(cache_read_tokens),0) cached, coalesce(sum(reasoning_tokens),0) reasoning, coalesce(sum(api_call_count),0) calls'
        where = "WHERE id LIKE 'orbit-%'" + (' AND started_at >= ?' if since is not None else '')
        params = (since,) if since is not None else ()
        orbit = dict(db.execute(f'SELECT {fields} FROM sessions {where}', params).fetchone())
        orbit['models'] = [dict(row) for row in db.execute(f"SELECT coalesce(nullif(model,''),'Unknown') model, {fields} FROM sessions {where} GROUP BY model ORDER BY sum(input_tokens)+sum(output_tokens) DESC", params)]
    return {'updated_at': time.time(), 'profile': hermes_all_profiles(since=since), 'orbit': orbit, 'opencode': opencode_snapshot(since=since), 'source': 'Lifetime counters for sessions started in selected period'}


def hermes_all_profiles(home=None, since=None):
    home = home or Path.home()
    keys = {'input': 'input_tokens', 'output': 'output_tokens', 'cached': 'cache_read_tokens', 'reasoning': 'reasoning_tokens', 'calls': 'api_call_count'}
    models, seen, profiles, unavailable = {}, set(), 0, 0
    patterns = ['.hermes/state.db', '.hermes/profiles/*/state.db', '.hermes-instances/*/state.db', '.hermes-instances/*/profiles/*/state.db']
    for path in sorted({p.resolve() for pattern in patterns for p in home.glob(pattern)}):
        stat = path.stat()
        identity = (stat.st_dev, stat.st_ino)
        if identity in seen:
            continue
        seen.add(identity)
        try:
            with sqlite3.connect(f'file:{path}?mode=ro', uri=True, timeout=5) as db:
                db.row_factory = sqlite3.Row
                columns = {row[1] for row in db.execute('PRAGMA table_info(sessions)')}
                if 'model' not in columns:
                    raise sqlite3.OperationalError('Unsupported schema')
                fields = ', '.join(f'coalesce(sum({column}),0) {key}' if column in columns else f'0 {key}' for key, column in keys.items())
                where = ' WHERE started_at >= ?' if since is not None else ''
                rows = db.execute(f"SELECT coalesce(nullif(model,''),'Unknown') model, count(*) sessions, {fields} FROM sessions{where} GROUP BY 1", (since,) if since is not None else ()).fetchall()
            for row in rows:
                target = models.setdefault(row['model'], dict(model=row['model'], sessions=0, **{key: 0 for key in keys}))
                for key in ['sessions', *keys]:
                    target[key] += row[key]
            profiles += 1
        except (sqlite3.Error, OSError):
            unavailable += 1
    rows = sorted(models.values(), key=lambda row: row['input'] + row['output'], reverse=True)
    return dict({key: sum(row[key] for row in rows) for key in ['sessions', *keys]}, models=rows, profiles=profiles, unavailable_profiles=unavailable)


def opencode_snapshot(path=None, since=None):
    path = path or Path('/home/mojo/.local/share/opencode/opencode.db')
    try:
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True, timeout=5) as db:
            db.row_factory = sqlite3.Row
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            sources = []
            columns = 'id,model,tokens_input,tokens_output,tokens_cache_read,tokens_cache_write,tokens_reasoning' + (',time_created' if since is not None else '')
            if 'session_v2' in tables:
                sources.append(f'SELECT {columns} FROM session_v2')
            if 'session' in tables:
                exclusion = ' WHERE NOT EXISTS (SELECT 1 FROM session_v2 n WHERE n.id=session.id)' if 'session_v2' in tables else ''
                sources.append(f'SELECT {columns} FROM session' + exclusion)
            if not sources:
                return {'available': False, 'error': 'No supported session counters'}
            # V2 is authoritative for migrated IDs. Session counters avoid reading
            # tens of GB of message content on every telemetry tick.
            model = "CASE WHEN json_valid(model) THEN coalesce(json_extract(model,'$.id'),json_extract(model,'$.modelID'),'Unknown') ELSE coalesce(nullif(model,''),'Unknown') END"
            provider = "CASE WHEN json_valid(model) THEN coalesce(json_extract(model,'$.providerID'),'Unknown') ELSE 'Unknown' END"
            query = 'WITH usage AS (' + ' UNION ALL '.join(sources) + f') SELECT {model} model, {provider} provider, count(*) sessions, ' + ', '.join(f'coalesce(sum(tokens_{key}),0) {alias}' for key, alias in [('input','input'),('output','output'),('cache_read','cached'),('cache_write','cache_write'),('reasoning','reasoning')]) + ' FROM usage GROUP BY 1,2 ORDER BY input+output+cached+cache_write DESC'
            if since is not None:
                query = query.replace(' FROM usage GROUP BY', ' FROM usage WHERE time_created >= ? GROUP BY')
            models = [dict(row) for row in db.execute(query, (since * 1000,) if since is not None else ())]
            result = {key: sum(m[key] for m in models) for key in ['input','output','cached','cache_write','reasoning','sessions']}
            return dict(result, models=models, available=True, attribution='Saved session model; migrated sessions counted once')
    except (sqlite3.Error, OSError):
        return {'available': False, 'error': 'OpenCode database unavailable'}

def main():
    data = snapshot()
    now = time.time()
    data['periods'] = {key: snapshot(now - days * 86400) for key, days in [('24h', 1), ('7d', 7), ('30d', 30)]}
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
