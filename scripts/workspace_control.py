#!/usr/bin/env python3
"""Scoped Comet/Orbit workspace controller for Hermes. No credentials are printed."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import time
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = Path(os.environ.get('ORBIT_RUNTIME_DIR', ROOT / '.runtime'))

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--workspace', required=True)
    sub = p.add_subparsers(dest='command', required=True)
    sub.add_parser('read')
    apply = sub.add_parser('apply'); apply.add_argument('operations', help='JSON operation or array; use @file.json to read a file'); apply.add_argument('--base-revision',type=int)
    preview = sub.add_parser('preview'); preview.add_argument('operations'); preview.add_argument('--base-revision',type=int)
    sub.add_parser('history')
    checkpoint = sub.add_parser('checkpoint'); checkpoint.add_argument('--label',default='Agent checkpoint')
    restore = sub.add_parser('restore'); restore.add_argument('checkpoint_id'); restore.add_argument('--confirm',action='store_true'); restore.add_argument('--base-revision',type=int,required=True)
    pub = sub.add_parser('publish'); pub.add_argument('source'); pub.add_argument('slug'); pub.add_argument('--title'); pub.add_argument('--no-open', action='store_true')
    args = p.parse_args()
    if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', args.workspace): p.error('Invalid workspace ID')
    config = json.loads((RUNTIME / 'workspaces' / (args.workspace + '.json')).read_text())
    def request(action, **fields):
        body = json.dumps({'workspace_id': args.workspace, 'action': action, **fields}).encode()
        req = urllib.request.Request(config['api'] + '/api/workspace/control', data=body, headers={'Authorization': 'Bearer ' + config['capability'], 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=20) as r: return json.load(r)
        except urllib.error.HTTPError as error:
            details = json.loads(error.read())
            raise RuntimeError(f"Workspace request failed ({error.code}): {details.get('error', 'unknown error')}") from None
    current = request('read')
    if args.command == 'read': print(json.dumps(current, indent=2)); return
    if args.command == 'history': print(json.dumps(request('history'),indent=2)); return
    if args.command == 'checkpoint': print(json.dumps(request('checkpoint',label=args.label),indent=2)); return
    if args.command == 'restore':
        if not args.confirm: p.error('Restore requires --confirm and the revision you reviewed')
        result=request('restore',checkpoint_id=args.checkpoint_id,confirm=True,base_revision=args.base_revision)
    elif args.command == 'publish':
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,60}', args.slug): p.error('App slug must use lowercase letters, digits, and hyphens')
        source = Path(args.source).resolve()
        if not (source / 'index.html').is_file(): p.error('Publish a build directory containing index.html')
        apps = RUNTIME / 'apps'; apps.mkdir(parents=True, exist_ok=True, mode=0o700)
        dest = apps / args.slug
        if source == dest.resolve() or apps.resolve() in source.parents: p.error('Use a source directory outside the published app store')
        files = list(source.rglob('*'))
        if any(f.is_symlink() for f in files): p.error('Symlinks are not allowed in published apps')
        if len(files) > 5000 or sum(f.stat().st_size for f in files if f.is_file()) > 50_000_000: p.error('App exceeds 5000 entries or 50MB')
        stage = Path(tempfile.mkdtemp(prefix='publish-', dir=apps))
        try:
            shutil.copytree(source, stage, dirs_exist_ok=True, ignore=shutil.ignore_patterns('.*', 'node_modules'))
            backup = apps / (args.slug + '.previous')
            if backup.exists(): shutil.rmtree(backup)
            if dest.exists(): dest.rename(backup)
            stage.rename(dest)
        finally:
            if stage.exists(): shutil.rmtree(stage)
        url = '/apps/' + args.slug + '/'
        if args.no_open: print(json.dumps({'published': True, 'url': url, 'opened': False})); return
        operations = [{'action': 'add_window', 'name': args.title or args.slug, 'kind': 'browser', 'url': url}, {'action': 'set_view', 'view': 'windows'}]
        # Updating an already-open app reuses its window rather than duplicating it.
        def contains(layout):
            if layout['type'] == 'pane': return layout['pane'].get('url') == url
            return contains(layout['first']) or contains(layout['second'])
        for m in current['state']['monitors']:
            if contains(m['layout']):
                operations = [{'action': 'select', 'window_id': m['id']}, {'action': 'set_view', 'view': 'windows'}]
                break
    else:
        raw = Path(args.operations[1:]).read_text() if args.operations.startswith('@') else args.operations
        operations = json.loads(raw)
        if isinstance(operations, dict): operations = [operations]
    if args.command != 'restore':
        base=getattr(args,'base_revision',None)
        result = request('preview' if args.command=='preview' else 'apply', base_revision=current['revision'] if base is None else base, operations=operations)
    if args.command=='preview': print(json.dumps(result,indent=2)); return
    revision = result['revision']
    for _ in range(40):
        result = request('read')
        if result['observed_revision'] >= revision: break
        time.sleep(0.25)
    result['browser_applied'] = result['observed_revision'] >= revision
    if args.command == 'publish': result['published_url'] = url
    print(json.dumps(result, indent=2))

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(json.dumps({'error': str(error)}))
        raise SystemExit(1)
