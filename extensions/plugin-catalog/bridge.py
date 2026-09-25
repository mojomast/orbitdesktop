"""Run with the configured Hermes Python, not the web server's interpreter.
Only static metadata and the ordinary Hermes installer are used; no plugin imports.
"""
import json
import sys
from hermes_cli import plugins_cmd as cli

if __name__ == '__main__':
    action = sys.argv[1]
    if action == 'compatible':
        from hermes_cli import __version__
        from packaging.specifiers import SpecifierSet
        requirement = sys.argv[2]
        if requirement and __version__ not in SpecifierSet(requirement):
            raise SystemExit(f'This entry requires Hermes {requirement}; installed version is {__version__}. Update Hermes separately before installing.')
        print(__version__)
    elif action == 'metadata':
        enabled, disabled = cli._get_enabled_set(), cli._get_disabled_set()
        data = []
        for name, entry in cli._read_install_metadata().items():
            target = cli._plugins_dir() / name
            if target.is_dir():
                data.append(dict(entry, name=name, status='enabled' if name in enabled and name not in disabled else 'disabled'))
        print(json.dumps(data))
    elif action == 'install':
        # Never honor a local scan_on_install:false for a web-initiated install.
        cli._scan_on_install_enabled = lambda: True
        cli.cmd_install(sys.argv[2], ref=sys.argv[3], enable=False, force=False)
        source = cli._canonical_source(*cli._resolve_git_url(sys.argv[2]))
        for name, record in cli._read_install_metadata().items():
            if record.get('source') == source and record.get('revision') == sys.argv[3]:
                # A stale allow-list entry must not turn a new install on implicitly.
                cli.cmd_disable(name)
                break
    elif action == 'enable':
        cli.cmd_enable(sys.argv[2], allow_tool_override=False)
    elif action == 'disable':
        cli.cmd_disable(sys.argv[2])
    else:
        raise SystemExit('Unsupported operation')
