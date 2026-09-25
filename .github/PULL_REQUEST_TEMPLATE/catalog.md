## Orbit catalog submission

Entry: `plugin-catalog/<id>.json`
Upstream repository:
Pinned commit (full 40-character SHA):
Old → new commit comparison (updates):

- [ ] I own or substantially contribute to this plugin (or am a curating maintainer).
- [ ] The built static app is committed at the declared path, including index.html.
- [ ] All executable assets are included; no CDN scripts, remote modules, self-updaters, build or install hooks.
- [ ] The declared network/storage use matches the pinned code; no host access or secrets are required.
- [ ] License permits redistribution; no private data, credentials, or local service URLs are bundled.
- [ ] I tested this pinned version in Orbit's sandbox and described the results below.
- [ ] `python3 scripts/orbit_catalog.py validate --sources` passes.

### Test evidence / screenshots

### Reviewer checklist

- [ ] Read the source at the pin (and upstream diff for updates), dependencies and license.
- [ ] Review network destinations, dynamic code loading, browser storage and data handling.
- [ ] Confirm the submitter's affiliation and capabilities; passing CI is not a security audit.
- [ ] Manually exercise the app in the Orbit sandbox before merging.
