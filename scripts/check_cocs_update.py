"""Offline candidate build from an exported review. Never activates or executes game code."""
import argparse
import hashlib
import json
import re
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True, stderr=subprocess.STDOUT)


def validate(review):
    if review.get('schema') != 'cocs.sdk-update-review/v1':
        raise ValueError('Unsupported review schema')
    for key in ('baseline', 'target'):
        if not re.fullmatch(r'[0-9a-f]{40}', review[key]['commit']):
            raise ValueError('Expected full lowercase commit SHA')
    if review['baseline'].get('repository') != 'mojomast/cocs':
        raise ValueError('Unexpected source repository')


def check(repo, review, output):
    validate(review)
    repo = Path(repo).resolve()
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    baseline, target = (review[k]['commit'] for k in ('baseline', 'target'))
    for sha in (baseline, target):
        if run('git', '-C', str(repo), 'rev-parse', sha + '^{commit}').strip() != sha:
            raise ValueError('Commit identity mismatch')
    changed = run('git', '-C', str(repo), 'diff', '--no-ext-diff', '--name-only', '-z', baseline, target).rstrip('\0').split('\0')
    changed = [p for p in changed if p]
    report = {'schema': 'cocs.sdk-candidate/v1', 'baseline': baseline, 'target': target,
              'changedFiles': changed, 'builds': [], 'activation': 'NOT UPDATED',
              'limitations': ['Build compatibility is not runtime or semantic compatibility',
                             'No adapters rewritten; no remote services changed',
                             'Browser regression tests and owner activation approval still required']}
    for label, sha in (('baseline', baseline), ('candidate', target)):
        with tempfile.TemporaryDirectory(prefix='cocs-candidate-') as tmp:
            checkout = Path(tmp) / 'source'
            run('git', 'clone', '--no-checkout', '--no-hardlinks', str(repo), str(checkout))
            run('git', '-C', str(checkout), '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', sha)
            metadata = output / (label + '-dependencies.json')
            artifact = output / (label + '.html')
            item = {'label': label, 'commit': sha, 'passed': False}
            try:
                run('node', str(ROOT / 'sdk/cocs/bundle.mjs'), str(checkout),
                    str(ROOT / 'sdk/cocs/diagnostics-adapter.mjs'), str(artifact),
                    str(ROOT / 'apps/cocs-viewer'), str(metadata), cwd=ROOT)
                inputs = json.loads(metadata.read_text())['inputs']
                dependencies = []
                for name in inputs:
                    p = (ROOT / name).resolve()
                    if p.is_relative_to(checkout):
                        dependencies.append(str(p.relative_to(checkout)))
                item.update(passed=True, dependencies=sorted(dependencies),
                            affectedDependencies=sorted(set(dependencies) & set(changed)),
                            sha256=hashlib.sha256(artifact.read_bytes()).hexdigest())
                metadata.unlink()  # Temporary paths are not useful persisted evidence.
            except subprocess.CalledProcessError as exc:
                item['error'] = exc.output[-12000:]
            report['builds'].append(item)
    report['buildCompatible'] = all(b['passed'] for b in report['builds'])
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True, help='Trusted local repository with both commits fetched')
    parser.add_argument('--review', required=True)
    parser.add_argument('--output', required=True, help='New private candidate directory')
    args = parser.parse_args()
    report = check(args.repo, json.loads(Path(args.review).read_text()), args.output)
    print(json.dumps(report, indent=2))
    return 0 if report['buildCompatible'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
