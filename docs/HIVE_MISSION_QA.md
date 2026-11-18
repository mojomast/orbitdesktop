# Reproducing the Hive owner journey

`tests/hive-integration.browser.py` publishes the pane into a new runtime, checks the trusted pin, builds the host, and boots a disposable loopback Orbit, Workflow HTTP collector with a synthetic provider, and R12 reader on a new ledger. `tests/hive-integration.browser.mjs` drives Chromium. The ledger append is `tests/rails-live.browser.py:event(ledger, 2)` for the exact `att-fixture` selected in the owner’s Rails shell. It occurs **after** Inspect and stream readiness. The collector keeps its original observation until the browser has seen both the selected mark and the Hive notice. Only then does the fixture change its snapshot. The following read must change the in-flight count from 4 to 3; an identical subsequent read must not replay a pulse. Finally the upstream credential is rotated and an actual 401/403 must discard the granted document.

The browser separately checks the report grant, owner GET, and actual message-port payload. One matching job title is expected; the second enrolled title is for a job in the reviewed publication but absent from this snapshot. Neither the catalog nor the unmatched title may reach the opaque pane. Only rendered, post-unlock screenshots are saved. Do not enable Playwright tracing, HAR, network debug, or auth request logging for this test.

## Inputs

- Orbit candidate source (including `scripts/portable-product.json`, the report validators and their imports); local matching Node ≥22.12, installed Orbit dependencies and Chromium.
- Workflow checkout containing `contrib/rizzstack-observability/collector.py`. This exercise uses `38f7e360b62fe53284ef6680604bba9d0d2fc230`.
- `HIVE_QUEUE_TEST_PACKET` and `HIVE_QUEUE_TEST_SHA256`: an independently identified **generated** BundleBees PARTIAL docket. The mission sample is `../mission-run/sources/queue.json`, SHA-256 `9f4960dec452525664317be63d43bfa6808e434cbb99153d4e3508b13acb993d` (`F1 / job_a`, 2 of 3 files). See the producing checkout's `tests/test_hive_docket.py` and `../mission-run/queue-contract.md`. Do not edit its collection time; a stale observation still has a date and does not authorize work.
- Optional `HIVE_RELEASE_TEST_PACKET` and `HIVE_RELEASE_TEST_SHA256`: previously collected `../mission-run/sources/release.json`, SHA-256 `8aff2ddd206d37610b0c3f8bef85c6039767adf20b93fc34be5f18b523fc7a2e` (see `../mission-run/release-contract.md`). If omitted, the harness runs the release producer with the fixed offline transport from `tests/test_hive_release_read.py`. Neither mode contacts GitHub. Private label bindings are generated afresh with `publishLabels` from `apps/rizzstack-hive/public-labels.js`; the tests never synthesize a successful reader response.

## Run

On Linux with a service-owned `TMPDIR` satisfying the [reader contract](../server/hive-reports.mjs) (private, no writable or symlinked ancestors and same mount as `/`), set the input paths and hashes above, plus `CHROMIUM_EXECUTABLE`, `HIVE_WORKFLOW_TEST_ROOT` and optional `HIVE_TEST_CAPTURE_DIR`. From Orbit run `python3 -B tests/hive-integration.browser.py`. Allow several real 30-second intervals. The report directory is created under the temporary test root; an operator's enrolled directory is never used. The test fetches no browser or dependencies.

This qualification workspace has group-writable ancestors and an unmapped `/` owner in its user namespace. Here is the equivalent private-root invocation from `orbitdesktop` on this host. All temporary writable files are below `../mission-run/tmp`. The namespace is only for satisfying the reader's real filesystem contract; the reader is not mocked. The example assumes the local `node_modules` symlink resolves outside the checkout.

```bash
set -eu
export run=$(realpath ../mission-run) repo=$PWD wf=$(realpath ../workflow)
export deps=$(realpath node_modules) chrome=$(find "$HOME/.cache/hyperframes/chrome" -type f -name chrome-headless-shell -print -quit)
export nodebin=/var/tmp/orbit-check-kit.veyF2C1x/prefix/bin/node
export jail=$(mktemp -d "$run/tmp/hive-host-root.XXXXXX")
trap 'rm -rf -- "$jail"' EXIT
mkdir -p "$run/host"
unshare -m --propagation private bash -eu <<'PRIVATE'
bind() { mkdir -p "$jail$2"; mount --rbind "$1" "$jail$2"; }
for dir in usr etc proc sys; do bind "/$dir" "/$dir"; done
mkdir -p "$jail/dev/shm"
for device in null zero random urandom; do touch "$jail/dev/$device"; mount --bind "/dev/$device" "$jail/dev/$device"; done
for dir in bin lib lib64 sbin; do cp -P "/$dir" "$jail/$dir"; done
bind "$repo" /src/orbit; bind "$wf" /src/workflow; bind "$deps" "$deps"
bind "$(dirname "$chrome")" /chromium; bind "$run/host" /captures
mkdir -m 700 "$jail/scratch" "$jail/inputs" "$jail/toolbin" "$jail/tmp"
cp "$nodebin" "$jail/toolbin/node"
cp "$run/sources/queue.json" "$run/sources/release.json" "$jail/inputs/"
/usr/sbin/chroot "$jail" /usr/bin/env -i HOME=/scratch TMPDIR=/scratch PATH=/toolbin:/usr/bin:/bin \
  HIVE_QUEUE_TEST_PACKET=/inputs/queue.json HIVE_QUEUE_TEST_SHA256=9f4960dec452525664317be63d43bfa6808e434cbb99153d4e3508b13acb993d \
  HIVE_RELEASE_TEST_PACKET=/inputs/release.json HIVE_RELEASE_TEST_SHA256=8aff2ddd206d37610b0c3f8bef85c6039767adf20b93fc34be5f18b523fc7a2e \
  CHROMIUM_EXECUTABLE=/chromium/chrome-headless-shell HIVE_WORKFLOW_TEST_ROOT=/src/workflow HIVE_TEST_CAPTURE_DIR=/captures \
  /bin/sh -c 'cd /src/orbit && exec python3 -B tests/hive-integration.browser.py'
PRIVATE
```
