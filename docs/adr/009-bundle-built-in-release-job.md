# ADR 009: build `orbit-source.tar.gz` in a release job instead of committing it

Status: accepted direction (Kyle, chat t1650u); install path decided (Kyle, chat t1659u); implementation not started.

## Context

`hermes-plugin/orbit-source.tar.gz` (about 1.8 MB) is committed. `scripts/bundle_hermes.py` rebuilds it
from tracked source, and `tests/test_orbit_bundle.py` asserts that the rebuilt bytes equal the committed bytes.
Every change under `src/`, `server/`, `scripts/`, `deploy/`, `docs/`, `public/` or `contracts/` therefore has to
regenerate the tarball. Two open PRs touching those paths always conflict on one binary, and the rizzstack
run merge queue carries special code that regenerates the tarball on conflict.

Consumers today:

- `hermes-plugin/orbit.py unpack()` extracts the tarball that sits next to it. This is the plugin's
  explicit `setup` step on a host.
- `tests/test_orbit_bundle.py` and `tests/test_portable_endpoints.py` read the committed file.
- `scripts/release_package.mjs` already excludes it from the release package.

## Decision

1. **Release job.** Add a workflow that runs `python3 scripts/bundle_hermes.py --output dist/orbit-source.tar.gz`
   on the owner's release trigger, writes a `.sha256` next to the tarball, and attaches both as release assets.
   Only the owner creates tags and releases.
2. **Plugin setup: install from a full checkout** (Kyle, chat t1659u). Each host installs Orbit from a full git
   checkout of this repository. `orbit.py setup` builds the bundle in that checkout with
   `bundle_hermes.py --output` into a temporary path, then unpacks it. `--bundle <path>` stays **optional**:
   it is for installing a release asset and is checked against the published sha256. It is never required.
   If there is no `--bundle` and the plugin is not inside a full checkout, setup fails closed with a message
   naming both options. It never downloads anything by itself, which keeps the no-self-update rule.
3. **Tests** build the bundle into a temporary directory. They keep the determinism and inclusion-policy checks:
   two builds give the same bytes, and the policy and credential scans still hold. They stop comparing against a
   committed file.
4. **Untrack** `hermes-plugin/orbit-source.tar.gz` and add it to `.gitignore`.
5. **Merge queue.** Once 1–4 land, the rizzstack run can drop its tarball-conflict resolution. That change is
   proposed to the run owner (MI-29) in the implementation PR, not made here.

## Sequencing

- orbitdesktop #91 (0.4.0) has merged and T2-REV27 (#92) has merged.
- Wave A slices T2a → T2b → T3 each regenerate the tarball. The switch lands after T3 merges, so those slices
  are not rebased onto a moving install contract.
- Implementation is one slice, test-first: the RED tests are the new temp-build bundle tests, an in-checkout `setup` build test and a
  `setup --bundle` sha256 refusal test.

## Decided

- Install path (Kyle, chat t1659u): Orbit installs from a full checkout, because the owner intends to use it more
  intensively. The in-checkout build is the default path and `--bundle` stays optional.

## Open for the owner

- Changing the install on a running host is a deploy. It waits until the owner asks.
