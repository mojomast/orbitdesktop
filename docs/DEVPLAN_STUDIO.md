# Devplan Studio

Bundled since Orbit Hermes plugin 0.2.2. Open Hermes tools → Devplan Studio. The launcher reuses its existing window. The guided interview, complexity assessment, editable specification, review gates, phased devplan, checkpoints and ZIP export work without a model or extra service. ZIP includes spec.md, devplan.md, phase documents and handoff.md, a starting prompt for bounded circular implementation/testing/correction.

Original implementation inspired by mojomast/devussy's planning workflow; no upstream implementation copied. Planning is deterministic scaffolding, not automatic semantic AI review. Export project before closing: the embedded app is sandboxed and drafts may be memory-only. Workspace checkpoints do not back up answers or documents.

## Optional conversational interview

The complete interactive frontend and trusted Python service are bundled in extensions/devplan-interview. It asks adaptive model-driven follow-ups and proposes brief updates for explicit human acceptance. Accepted changes feed the same planning/export pipeline. It is not automatically started or exposed on the network.

Configure using scripts/setup_devplan_interview.py --help. Supply your Orbit origin, the interview service's public origin, loopback Orbit auth endpoint (default http://127.0.0.1:4318/api/auth), Hermes home, source checkout and Hermes Python executable. No Tailscale host, machine path or credential is baked into the release. HTTPS Orbit requires an HTTPS interview origin; configure your own authenticated/private reverse proxy. Local HTTP deployments can use a loopback service origin.

Read docs/EXTENSIONS.md, then stage extensions/devplan-interview with scripts/extensions.py stage. Activate its returned release with an unused loopback --port and explicit --trust-host-code. Run health before opening the configured public origin in an Orbit browser window. No automatic proxy setup or reboot supervision is included. Stop through the extension runner when not needed.

Unlock in the interview UI with the Orbit host token, never in chat. The token is validated through the configured loopback auth endpoint and exchanged for a four-hour in-memory session. Exact Host/Origin checks and one model turn at a time apply. The configured Hermes provider receives your accepted brief and bounded conversation. Provider charges and privacy policies apply. Tools, memory and context-file loading are disabled for these requests, but the service runs as the owner, not an OS sandbox. Hermes diagnostics may retain project text privately.

A working Hermes provider login is required. The original deployment's live model test failed with expired Codex authentication; no successful end-to-end AI interview is claimed for this release. Run hermes auth if needed. Failed turns leave the accepted brief unchanged. Guided planning works independently. Export/import transfers drafts between the guided and conversational apps; never close an unsaved original to migrate it.
