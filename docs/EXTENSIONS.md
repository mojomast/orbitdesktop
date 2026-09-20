# Trusted backend extension deployments

This is a working owner-only CLI deployment runner, separate from sandboxed app plugins and from Orbit's core service. It does not turn arbitrary code into a safe plugin. Python 3 and Linux /proc are required. No production core service restart is needed.

## Contract

A clean bundle contains extension.json with apiVersion:1, id (lowercase identifier), version, runtime:"python3", entry:"main.py", and main.py. Standard-library Python is supported; dependency installation, custom interpreters and Node backends are not implemented. See examples/extensions/example-service.

Listen on 127.0.0.1 at ORBIT_EXTENSION_PORT. GET /health must return {"ok":true,"release":ORBIT_EXTENSION_RELEASE}. The release field prevents a different release's listener from passing the health gate. This is cooperative trusted-code identification, not cryptographic process attestation. Bind only loopback, add authentication for sensitive endpoints, and do not enable CORS indiscriminately. The manager does not impose network isolation.

## Workflow

Use `python3 scripts/extensions.py stage /absolute/clean/build` to copy a content-addressed release without executing it. Hidden files/symlinks and oversized bundles are rejected. Review the source before execution.

Use `activate ID RELEASE --port 4401 --trust-host-code` to launch a candidate on a distinct free port. The old process remains active during the health probe. Only a healthy candidate is recorded as active, then the prior process group is stopped. Failed candidates are stopped and the active record is retained. Files are SHA-256 verified before launch. The store is owner-only but not immutable against the owner or trusted extension itself.

Use `request ID /health` as an agent-facing stable GET facade: it resolves the active port at request time, disables redirects/proxy inheritance, bounds response size and time, and reports the release. It is CLI-only, not a browser-accessible gateway. Do not use GET for destructive operations.

Use `status` to inspect active/previous releases and process identity; `rollback ID --port 4402 --trust-host-code` launches the retained previous version through the same health gate. Use `stop ID` to stop one extension; `safe-mode` stops active managed extensions and blocks activation until explicit `resume`. Resuming does not auto-start stopped releases.

## Boundaries and recovery

The runtime store defaults to .runtime/extensions (override ORBIT_EXTENSIONS_DIR). A lock serializes manager commands; state writes are atomic. Logs stay there and can contain extension-generated secrets: do not publish them. Rotation is not implemented. Environment inheritance is limited to a minimal PATH plus runtime parameters; extensions still run with owner filesystem privileges and can read owner files. This is NOT a permission sandbox.

Processes have separate process groups and do not intentionally share Orbit's terminal lifecycle. No restart supervision, reboot persistence, process resource quotas, multi-user isolation, core UI hot replacement, dependency resolver, browser API bridge or database migrations are provided. A manager/host crash between process launch and state commit can leave an untracked candidate; safe-mode covers recorded processes only. Systemd/container supervision and an authenticated browser bridge are future work, not implied by the runner.

Rollback restores extension code selection only, not database writes/files/network side effects. Extensions should use reversible migrations or their own backups. Do not execute untrusted downloaded bundles, bypass approval, or claim universal rollback. This runner is useful for trusted local services, not a complete production deployment platform.

## Operations and diagnostics

`health ID` probes the active process and verifies the release-specific health response, rather than equating process existence with health. Errors exit nonzero. `logs ID` returns only the last 16KiB, with a truncation flag; logs are untrusted data and may contain secrets. `releases ID` lists stored versions and verifies their hashes without executing code. `restart ID --port NEW_PORT --trust-host-code` launches the same version through the candidate health gate before retiring the old process. It preserves the previous distinct version for rollback. These are manual/agent operations, not continuous supervision.

## Verification

`python3 tests/extensions.test.py` executes real temporary services: stage, denied activation without explicit trust, healthy promotion, active request routing, rollback, failed candidate preservation, safe mode and resume. Tests use an isolated runtime and clean up processes. No fabricated health responses are used.
