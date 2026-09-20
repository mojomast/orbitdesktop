#!/usr/bin/env python3
"""Operate ONLY the dedicated shared desktop, never the host X session."""
import argparse
import subprocess
from pathlib import Path

CONTAINER = 'orbit-shared-desktop'
p = argparse.ArgumentParser(description=__doc__)
s = p.add_subparsers(dest='action', required=True)
s.add_parser('windows')
s.add_parser('status')
a = s.add_parser('screenshot'); a.add_argument('--output', required=True, type=Path)
a = s.add_parser('click'); a.add_argument('x', type=int); a.add_argument('y', type=int); a.add_argument('--button', type=int, choices=[1, 2, 3], default=1)
a = s.add_parser('key'); a.add_argument('keys')
a = s.add_parser('type'); a.add_argument('text', nargs='?', help='Omit to read stdin; avoid secrets in arguments')
a = s.add_parser('launch'); a.add_argument('app', choices=['terminal', 'files', 'editor'])
a = p.parse_args()
def run(*args, capture=False):
    return subprocess.run(['docker', 'exec', '-e', 'DISPLAY=:99', CONTAINER, *args], check=True, capture_output=capture)
if a.action == 'status':
    subprocess.run(['docker', 'inspect', '--format', '{{.State.Status}} | restart count={{.RestartCount}} | pids limit={{.HostConfig.PidsLimit}}', CONTAINER], check=True)
    run('xdpyinfo', capture=True)
    print('X display ready')
elif a.action == 'windows':
    run('xdotool', 'search', '--onlyvisible', '--name', '.', 'getwindowname', '%@')
elif a.action == 'screenshot':
    run('scrot', '/tmp/agent-desktop.png')
    a.output.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['docker', 'cp', CONTAINER + ':/tmp/agent-desktop.png', str(a.output)], check=True)
    a.output.chmod(0o600)
    print(a.output)
elif a.action == 'click':
    run('xdotool', 'mousemove', '--sync', str(a.x), str(a.y), 'click', str(a.button))
elif a.action == 'key':
    run('xdotool', 'key', '--clearmodifiers', a.keys)
elif a.action == 'type':
    import sys
    text = a.text if a.text is not None else sys.stdin.read()
    subprocess.run(['docker', 'exec', '-i', '-e', 'DISPLAY=:99', CONTAINER, 'xdotool', 'type', '--clearmodifiers', '--file', '-'], input=text, text=True, check=True)
elif a.action == 'launch':
    app = {'terminal':'xfce4-terminal', 'files':'thunar', 'editor':'mousepad'}[a.app]
    subprocess.run(['docker', 'exec', '-d', '-e', 'DISPLAY=:99', CONTAINER, app], check=True)
