"""OpenCode saved activity and resolved provider configuration; no transcript export."""
import base64
import json
import sqlite3
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

DB = Path('/home/mojo/.local/share/opencode/opencode.db')


def endpoint(value):
    try:
        u = urlsplit(value)
        if u.scheme not in ('http', 'https') or not u.hostname:
            return None
        # No credentials, queries, fragments or arbitrary potentially-secret paths.
        return u.scheme + '://' + u.hostname + (':' + str(u.port) if u.port else '')
    except (ValueError, TypeError):
        return None


def providers():
    secret = json.loads(Path('/home/mojo/.config/opencode/service.json').read_text())['password']
    auth = base64.b64encode(('opencode:' + secret).encode()).decode()
    req = urllib.request.Request('http://127.0.0.1:49374/api/provider', headers={'Authorization': 'Basic ' + auth})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=3) as response:
        data = json.load(response)['data']
    return {p['id']: endpoint(p.get('settings', {}).get('baseURL')) for p in data}


class Activity:
    def __init__(self):
        self.endpoints = {}
        self.last_provider = 0

    def sample(self):
        now = time.time()
        if now - self.last_provider > 30:
            try:
                self.endpoints = providers()
            except Exception:
                self.endpoints = {}
            self.last_provider = now
        with sqlite3.connect(f'file:{DB}?mode=ro', uri=True, timeout=2) as db:
            rows = db.execute('SELECT model,time_updated,time_idle,time_suspended,time_archived FROM session_v2 ORDER BY time_updated DESC LIMIT 100').fetchall()
        groups = {}
        for raw, updated, idle, suspended, archived in rows:
            if not raw or archived:
                continue
            model = json.loads(raw)
            provider, name = model.get('providerID', 'Unknown'), model.get('id', 'Unknown')
            key = (provider, name)
            row = groups.setdefault(key, {'provider': provider, 'model': name,
                'endpoint': self.endpoints.get(provider), 'last_updated': updated / 1000,
                'recent_sessions': 0, 'possibly_active': 0, 'suspended': 0})
            if now - updated / 1000 <= 300:
                row['recent_sessions'] += 1
                row['possibly_active'] += int(not idle and not suspended)
                row['suspended'] += int(bool(suspended))
        return {'available': True, 'updated_at': now, 'in_flight': None,
                'recent_sessions': sum(r['recent_sessions'] for r in groups.values()),
                'possibly_active': sum(r['possibly_active'] for r in groups.values()),
                'routes': list(groups.values())[:12],
                'coverage': 'Latest 100 V2 sessions; recent = updated within 5 minutes. Active candidates are saved non-idle, non-suspended sessions, not verified live HTTP requests.'}
