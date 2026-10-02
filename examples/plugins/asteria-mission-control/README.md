# Asteria Mission Control

A self-contained, synthetic mission-planning simulator for Orbit's sandboxed
plugin lifecycle. The interactive dashboard, comparisons and exported decision
brief all use the same canonical calculation model in `scenario.mjs`.

## Try it

Publish this directory with the repository publisher, then install and enable the
returned manifest through the workspace controller:

```sh
python3 scripts/plugin_publish.py "$PWD/examples/plugins/asteria-mission-control" \
  --id asteria-mission-control --version 1.0.0 \
  --title 'Asteria Mission Control' --runtime /absolute/orbit-runtime
```

Follow [the plugin lifecycle](../../../docs/PLUGINS.md) for validated preview,
install/enable, browser acknowledgement and updates. Keep previous bundles.

1. Start with the reconciled equipment baseline.
2. Choose **Add both reliability upgrades**: reliability improves, and the cost
   rises by the actual $184,000 uplift.
3. Choose **Apply 15% budget cut**: the budget becomes $1,700,000 and the unchanged
   upgraded equipment has a $437,000 gap.
4. Change relay availability and crew arrival; inspect the actual constraints.
5. Compare alternatives and export the current decision brief or scenario JSON.

Source text and the exact original CSV are bundled under `data/`. All content is
synthetic. The suspected duplicate is an explicit reconciliation assumption.
The engineering source resolves the crew threshold to 4.7 kW; average generation
does not establish night-time continuous supply. Missing evidence stays unknown.
Deferring the required laboratory does not erase its total-programme cost.

The simulator computes locally and needs no model call, host token, Desktop
connection, file picker or privileged parent bridge. In-page edits are transient;
downloads are explicit exports, not saved Orbit documents. Reload starts a fresh
scenario. The mission-analysis model is illustrative, not an engineering tool.

## Verify

```sh
node --test tests/asteria-scenario.test.mjs
python3 tests/asteria-simulator.browser.py
```

The browser test needs Python Playwright and Chromium. It publishes into a
disposable runtime and uses Orbit's real `/apps/` handler plus the opaque-origin
iframe sandbox. It checks coupled arithmetic, actual interactive changes, exports,
reset/recovery and a 390px viewport. Evidence is written outside the repository.

See [the feature guide](../../../docs/ASTERIA_MISSION_CONTROL.md) for scope and
acceptance criteria. This example is distributed in the source checkout and
published independently; it is not automatically installed by the Hermes archive.
