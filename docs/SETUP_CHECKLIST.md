# Orbit setup checklist

Use this as the human checklist that mirrors the built-in setup agent. Work one
step at a time, show the command before running it, and ask before installing
anything. Keep Orbit on loopback unless the person explicitly says to expose it.
Never paste a secret into chat.

The setup agent reads `orbit-config.json` when the wizard provides it. The view
contains selected `components`, `providers` with masked key status only,
`roles`, `router` and `installState`; it never contains key values. Install only
the chosen components, in this order: core (already running), chosen agent
adapters, bundlebees and worker pairing, then Colab and optional apps. Record
each confirmed step with `PUT /api/onboarding/install-state` (served by the
onboarding route in the OF2 slice), for example:

```sh
curl -fsS -X PUT http://127.0.0.1:4318/api/onboarding/install-state \
  -H 'Content-Type: application/json' \
  --data '{"id":"pi","state":"installed"}'
```

Valid states are `pending`, `running`, `installed`, `failed` and `skipped`.

## Checklist

- [ ] **Core health.** Confirm the running Orbit service before changing work.
  - Verify: `curl -fsS http://127.0.0.1:4318/api/health`
- [ ] **Workflow protocol.** Clone and read the briefs, leases, evidence and
  approvals in the workflow repository, then run the offline reference demo.
  - Clone: `git clone https://github.com/mojomast/workflow`
  - Verify: `python3 reference/run_demo.py`
- [ ] **Chosen agent adapters.** Install only the adapters selected in the
  wizard (Pi, OpenCode, Hermes, or another adapter from `docs/ADAPTERS.md`).
  - Verify Pi: `pi --version`
  - Verify OpenCode: `opencode --version`
  - Verify Hermes: `hermes --version`
  - Verify any OpenAI-compatible adapter: `curl -fsS http://127.0.0.1:4318/api/health`
- [ ] **Bundlebees execution layer.** Install bundlebees and point it at the
  loopback local-workers API. Keep its token in a private file or environment
  variable, never in chat.
  - Verify: `curl -fsS http://127.0.0.1:4318/api/local-workers`
- [ ] **Workers.** Pair a local worker first; add a remote launcher only if the
  person chose it.
  - Verify: `curl -fsS http://127.0.0.1:4318/api/local-workers`
- [ ] **Colab, if chosen.** Enable the orchestrator only after the person
  approves its plan and result boundaries.
  - Verify: `curl -fsS http://127.0.0.1:4318/api/health`
- [ ] **Optional apps, if chosen.** Install only the selected apps.
  - Verify: `curl -fsS http://127.0.0.1:4318/api/health`

## Router checks

The built-in router is `components.router`; Bifrost is the default engine and
LiteLLM is an advanced engine. The onboarding wizard and Settings call the router
supervisor. The setup agent never starts the router on its own.

- **External router:** if `router.mode` is `external`, point router-backed agents
  at the external base URL from the config view. Nothing runs locally.
  - Verify: `curl -fsS <external-base-url>/models`
- **Built-in router:** wait for the wizard or Settings to report it healthy.
  - Verify: `curl -fsS http://127.0.0.1:8080/v1/models`

### Per-role virtual keys

Give each role its own virtual key, for example `setup`, `chat`, `workers` and
`summarize`. Orbit generates the key, stores it as a `0600` file under the
runtime key directory, injects the matching key into that role, and shows only
masked status. Never paste a virtual key into chat or a tracked file.

OpenCode free models stay direct to OpenCode. They cannot be fronted by the
router; only paid or self-hosted OpenCode endpoints can use the router base URL.

## Local LiteLLM proxy (documented, advanced, opt-in)

Only follow this section when `components.litellmLocal` is explicitly true. It is
not the default and it is not started automatically. The setup agent asks first,
shows these commands, and never asks for a key in chat.

1. Bind only to loopback.
2. Render `runtime/router/litellm.yaml` from the chosen upstream providers. Keys
   must be references such as `os.environ/OPENAI_API_KEY`, loaded from `0600`
   key files under the runtime key directory. Never inline an upstream key.
3. Generate a master key into a `0600` file under `runtime/router` and load it
   from the environment. Never put the value on a command line.
4. Start one of these paths:

   ```sh
   docker compose --profile router up -d router
   ```

   or:

   ```sh
   pipx install 'litellm[proxy]'
   litellm --config <runtime>/router/litellm.yaml --host 127.0.0.1 --port 4000
   ```

5. Set `providerMode` to `router` and the base URL to
   `http://127.0.0.1:4000/v1` in the wizard.
6. Verify: `curl -fsS http://127.0.0.1:4000/health`

## Finish

Report what is installed, what was skipped, and the verify command for every
completed step. List remaining optional work and ask before starting it. Keep the
UI dark; use the existing theme variables and do not add a light theme.
