# Widget configuration schemas

Author-declared **finite** metadata for the existing API-v1 plugin config map.
It is an OPTIONAL `configSchema` field on a plugin manifest. It does not add a
new config contract: every field maps to the existing `string | number | boolean`
primitive config, and schema-less manifests/configs remain valid exactly as
before.

`configSchema` is **public metadata**. It is emitted into the manifest, may be
shown in the workspace, and must never contain secrets or private notes. It
cannot execute code: there is no regex, no template, no `eval`, no arbitrary JSON
Schema and no nested object/array values beyond the finite `enum` list.

## Exact manifest shape

```json
{
  "apiVersion": 1,
  "id": "notes",
  "version": "1.0.0",
  "title": "Workspace notes",
  "entry": "/apps/notes-<digest>/index.html",
  "configSchema": {
    "fields": [
      {
        "key": "title",
        "type": "string",
        "title": "Window title",
        "description": "Shown in the window header.",
        "default": "Notes",
        "required": true
      },
      { "key": "mode", "type": "string", "enum": ["light", "dark"], "default": "light" },
      { "key": "count", "type": "number", "min": 0, "max": 100, "default": 5 },
      { "key": "pinned", "type": "boolean", "default": false }
    ]
  }
}
```

Only `configSchema.fields` is allowed; the schema object is closed. Each field is
closed to the properties below; every other property is rejected.

| Property | Type | Rules |
| --- | --- | --- |
| `key` | string | Required. Must match `^[a-zA-Z][a-zA-Z0-9_-]{0,47}$` and be unique. |
| `type` | `"string" \| "number" \| "boolean"` | Required. |
| `title` | string | Optional label, 1–60 printable characters. Defaults to the key. |
| `description` | string | Optional inline help, ≤ 200 printable characters. |
| `default` | primitive | Optional. Must match `type`, be finite when a number, satisfy `enum`/`min`/`max`. |
| `enum` | primitive[] | Optional single-choice dropdown, 1–32 unique values of the field `type`. Not allowed for booleans. |
| `min` / `max` | number | Optional inclusive bounds, only for `number`; both finite and `min ≤ max`. |
| `required` | boolean | Optional. The effective config must resolve the key; a `default` satisfies it. A required `string` field's `default` must be non-empty, so the effective default always satisfies the same rule as a present value. |

Bounds: at most **32 fields**, serialized schema ≤ **8192** characters, string
values/defaults ≤ **4096** characters, no control characters. The validator is
`validatePluginConfigSchema(value)` in `src/plugin-config-schema.ts`; the
publisher mirrors it in `scripts/plugin_publish.py` (`validate_config_schema`).

## Defaults and owner values

Helpers in `src/plugin-config-schema.ts`:

- `configDefaults(schema)` — declared defaults keyed by field.
- `applyConfigDefaults(config, schema)` — fills only missing keys; a saved value
  always wins, so defaults never silently override owner config.
- `validateConfigAgainstSchema(config, schema)` — per-key messages for declared
  fields. Unknown keys stay allowed, so incremental/extra fields still work.
- `assertValidPluginConfig(config, schema)` — combines the existing primitive
  `validateConfig` contract with the schema.

## Editor behaviour

`showPluginConfigEditor` accepts an optional `schema`. Declared fields render in
author order with labels, help text, locked key/type, a `<select>` for `enum`,
number bounds, a boolean checkbox and a `Default: …` hint/placeholder. A field
that is absent from the saved config is only written when the owner actually
types or checks a value; the shown default is never persisted silently. Required
fields without a default block saving with an inline message, and the advanced
JSON editor runs the exact same declared validation. Cancel and edit conflicts
keep the draft, as before.

## Publisher

```sh
python3 scripts/plugin_publish.py ./build --id notes --version 1.0.0 \
  --title 'Workspace notes' --config-schema ./config-schema.json
```

The schema file is validated **before** any runtime write, and is emitted as
`configSchema` in the printed manifest. It is metadata only and is never copied
into the bundle or used in the content address:

- `entry` / bundle `digest` still hash only the served bundle files.
- Two builds with identical files and different schemas share one bundle folder
  but each emits its own `configSchema`.
- An invalid schema, a symlinked schema file, a duplicate JSON key or an
  oversized file fail before `apps/` is created.

### Worked example: the Notes app

`examples/plugin-config/notes.schema.json` describes exactly the two primitive
keys the Notes app reads (`title`, `message`). It lives **outside** the served
folder `examples/plugins/notes`, so it is never copied, hashed or served. The
matching pinned entry `examples/catalog/notes.json` carries the same
`configSchema` inline, so `orbit_catalog.py sync` materializes it too.

```sh
python3 scripts/plugin_publish.py examples/plugins/notes \
  --id notes --version 1.0.0 --title 'Workspace notes' \
  --config-schema examples/plugin-config/notes.schema.json
```

Publish prints a manifest that includes the exact schema; the published bundle
still contains only `index.html`. The install/configure flow is otherwise the
existing v1 lifecycle (`docs/PLUGINS.md`):

1. Install disabled with the emitted manifest and any owner config, e.g.
   `{"action":"plugin_install","manifest":<emitted manifest>,"config":{"title":"My notes","message":"Hello"}}`.
   The manifest's `configSchema` is validated and stored with the definition.
2. Enable with `{"action":"plugin_enable","plugin_id":"notes"}`. The manager's
   **Configure** form now shows the declared labels/help and prefills shown
   defaults; required fields must be supplied before enable, while install stays
   disabled-first.
3. Edit with `plugin_patch_config` (partial) or `plugin_configure` (whole object).
   Runtime uses the effective config (`applyConfigDefaults`, saved values win) for
   rendering only; stored config is never overwritten by defaults.
4. To change the schema, republish the same files with the new
   `--config-schema` and run `plugin_update`. The bundle folder is reused because
   the files hash unchanged; the new manifest carries the new schema.

## Trusted runtime integration

`configSchema` is accepted by the publisher, catalog, workspace contract, core
manifest validator and plugin manager. The runtime core validates declared config
and applies defaults only to the **effective** rendered config, never overriding
stored owner values. A required field without a default may be omitted on a
disabled instance but must be supplied before enable. Integration points:

1. `src/plugins.ts` — `PluginManifest` and `validateManifest`: accept an optional
   `configSchema` and validate it with `validatePluginConfigSchema`; reject it
   otherwise. `validatePlugins`/`pluginOperation` then carry it automatically.
   Runtime uses `applyConfigDefaults` for the effective config only, and
   `validateConfigAgainstSchema` to gate enable.
2. `contracts/workspace-v1.mjs` — `manifest` is `additionalProperties:false`.
   It includes `configSchema: ref('configSchema')` with an explicit required list:
   `object({...}, ['apiVersion','id','version','title','entry'])`.
3. `contracts/workspace-v1.json` — the matching generated `$defs.manifest` and a
   new `$defs.configSchema` (regenerate with the contract generator so the two
   stay byte-identical).
4. `src/workspace-contract.generated.ts` and `docs/WORKSPACE_OPERATIONS.generated.md`
   — regenerate them from `contracts/workspace-v1.mjs` with
   `node scripts/generate-workspace-contract.mjs`; do not hand-edit.
5. `src/plugin-manager.ts` passes `schema: p?.manifest.configSchema` into
   `showPluginConfigEditor`.

The authoritative `$defs.configSchema` and typed field union are generated in
`contracts/workspace-v1.json`. Semantic validation additionally checks unique
keys, matching default/enum types, valid ranges, effective required defaults and
the serialized-size bound.

## Catalog and Studio

- `plugin-catalog/<id>.json` entries may now carry an optional bounded **inline**
  `configSchema`. `scripts/orbit_catalog.py::validate` runs the publisher's exact
  validator (`scripts/plugin_publish.py::validate_config_schema`), so there is one
  schema definition and one cross-language fixture. `materialize` writes the
  normalized schema to a temporary file **outside** the served bundle and passes it
  with `--config-schema`; `entry`/digest stay file-only and no metadata is injected
  into hash files. External schema URLs, paths and mutable loads are not accepted.
- `plugin-catalog/schema.json` is the machine-readable entry reference and a
  reserved filename: `load_catalog` and `reviewed_catalog` skip it (and
  `removed.json` is the removal list). Contributors follow the catalog `README`.
- Backend manifests (`extension.json` for `scripts/extensions.py`,
  `catalog_backend.py`, `orbit_catalog.py`) are a different exact-shape contract
  (`apiVersion 1, runtime python3, entry main.py`). They must **not** gain
  `configSchema`; leave them unchanged.
- Extension Studio (`contracts/extension-studio-v1.mjs`) references no manifest
  fields and installs through the workspace contract, so it inherits the contract
  update above and needs no Studio-specific edit.

## Tests

- `tests/plugin-config-schema.test.mjs` — JS schema/editor validation and
  defaults, driven by `tests/fixtures/plugin-config-schema.json`.
- `tests/plugin-config-schema.test.py` — the same fixture through the publisher's
  mirrored validator, proving cross-language parity.
- `tests/plugin-publish.test.py` — `--config-schema` emission, bundle/hash
  identity, pre-publication rejection, non-copying and the Notes example schema
  (`examples/plugin-config/notes.schema.json`) staying outside the served bundle.
- `tests/orbit-catalog.test.py` — inline entry `configSchema` validation
  (including invalid enums, defaults and unknown fields), materialize passthrough
  with deterministic file identity and reserved `schema.json` skipping.
- `tests/plugin-config-schema.browser.py` — real editor rendering: labels, help,
  enum dropdowns, shown defaults that never override a saved value, required
  markers, inline invalid handling, cancel, conflict-preserving drafts and
  advanced-JSON schema validation.
