#!/usr/bin/env bash
# Disposable dependency setup; nothing is installed into Orbit's node_modules.
set -euo pipefail
target="${1:-/tmp/opencode/orbit-docking-deps}"
mkdir -p "$target"
target="$(cd "$target" && pwd -P)"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
case "$target/" in "$repo/"*) echo 'Refusing dependency installation inside the Orbit repository' >&2; exit 1;; esac
expected_dockview='sha512-6Loais9hlIRo25sTQSWGWlgbPr22ddoLBzpGDFaTnocawnC45twp5f2S2WxUz5/HPa/a65I4yxKUqZa8xrcc5Q=='
expected_golden='sha512-sIVQCiRWOymHbVD1Aw/T9/ijbPYAVGBlgGYd1N9MRKfcyBNSpjr87Vg9nSHm+RCT8ELrvK8IJYJV0QRJuVUkCQ=='
test "$(npm view dockview-core@8.3.1 dist.integrity)" = "$expected_dockview"
test "$(npm view golden-layout@2.6.0 dist.integrity)" = "$expected_golden"
npm install --prefix "$target" --ignore-scripts --no-save --package-lock=false \
  --no-audit --no-fund --save-exact dockview-core@8.3.1 golden-layout@2.6.0
node - "$target" <<'NODE'
const fs = require('node:fs');
const root = process.argv[2] + '/node_modules';
for (const [name, version, licence] of [
  ['dockview-core', '8.3.1', 'LICENCE.md'],
  ['golden-layout', '2.6.0', 'LICENSE'],
]) {
  const pkg = JSON.parse(fs.readFileSync(`${root}/${name}/package.json`));
  if (pkg.version !== version || pkg.license !== 'MIT' ||
      !fs.readFileSync(`${root}/${name}/${licence}`, 'utf8').includes('MIT License')) {
    throw Error(`Unexpected package version or license for ${name}`);
  }
  console.log(`${name}@${version}: ${licence}; direct dependencies: ${JSON.stringify(pkg.dependencies || {})}`);
}
NODE
printf 'Registry integrity metadata matches pinned values; npm verifies downloads against registry metadata.\n'
