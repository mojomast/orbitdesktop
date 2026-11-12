# Adding SSH hosts to Orbit — best-practice research (Nov 12, 2026)

Research only; no Orbit code changed. Kyle: "i want to be able to add hosts to orbit easily for ssh access for deploying infrastructure or workers." No secrets, tailnet hosts or private URLs in this doc.

## Recommendation

1. **Use the system OpenSSH client, not a Node SSH library.** Ship `openssh-client` (10.x) in the Orbit image and drive it with an Orbit-owned config file (`ssh -F runtime/ssh/config`). This gives post-quantum key exchange (`mlkem768x25519-sha256`, the OpenSSH 10 default; ssh2 1.17.0 lacks it and OpenSSH 10.1+ warns), ProxyJump, ControlMaster multiplexing, certificates, `docker context` over SSH (which shells out to `ssh`), and standard known_hosts semantics. Keep `ssh2` out of the default path.
2. **One Orbit-generated ed25519 key per install by default (per-host keys optional).** The private key stays in `runtime/ssh/keys/` (0600, dir 0700), is write-only from the UI, and never reaches the browser, logs or agents. The user gets either a restricted `authorized_keys` line or a reviewable one-line bootstrap that creates a dedicated `orbit` user.
3. **Verified first use, then strict pinning.** The bootstrap prints the host's ed25519 fingerprint; the add-host test shows the fingerprint Orbit saw and asks the user to confirm they match. Pin to Orbit's own `known_hosts`, `StrictHostKeyChecking yes` afterwards, and hard-fail on a changed key with a re-verify flow. Never `StrictHostKeyChecking=no`.
4. **Agents never hold keys.** They call Orbit's host API (`hosts.run`, `hosts.deploy(recipe)`). Orbit enforces per-agent, per-host permission levels, prefers named idempotent recipes over raw shell, asks the user before destructive commands, and writes an append-only audit log of every command per host.
5. **SSH is for install, upgrade and removal only.** bundlebees workers still dial out to Orbit with a pairing code and scoped token (chapter 14). Revoking a worker token and removing the host key are separate, both one click.
6. **Phase 2: Orbit as a tiny SSH CA** (`ssh-keygen -s`) issuing short-lived user certificates per agent session (principal, `source-address`, optional `force-command`), with hosts trusting it via `TrustedUserCAKeys`. Support Tailscale SSH and Teleport as "bring your own access" options, not defaults.

## How mature tools do it

| Tool | Access model | Keys | Host key check | Least privilege | Worth copying |
|---|---|---|---|---|---|
| Coolify | Server stores key, SSH per action | Generate ed25519 in UI (no passphrase) or import; stored in its DB | Saves host key on "Validate connection" | Root default; non-root with sudo supported | Generate-in-UI, Validate step that also installs Docker, server roles (deploy/build) |
| Dokploy | ssh2 library, exec per action | Generate or paste; private key unreadable after creation | Not prominent | Detects sudo for non-root | Write-only private key, friendly auth/connect error hints, "Enter terminal" test |
| CapRover | SSH only to join Swarm nodes | Paste manager key | Minimal | Root typical | SSH only for bootstrap, runtime over the cluster protocol |
| Kamal | net-ssh honoring ~/.ssh/config | Agent or key files | known_hosts (hashed entries break) | `user:` non-root | `proxy:` jump host, roles, idempotent deploy; avoid its agent-forward default |
| Ansible | System OpenSSH + ControlPersist | User's keys / agent | `host_key_checking` on by default | `become` with scoped sudo | ControlPersist, inventory groups/tags, idempotent tasks, check mode |
| Teleport | Short-lived certs via proxy | CA-issued certs | Host certs | RBAC, access requests | Short-lived certs, per-session audit, access requests as approval gates. Binaries now commercial-licensed (free under 100 staff and $10M revenue) |
| Tailscale SSH | Tailnet identity, no keys | None to manage | WireGuard node identity | ACL `users`, `check` re-auth | `check` mode as an approval model; optional transport/auth for tailnet users |
| step-ca (Smallstep) | SSH CA | Short-lived user + host certs | `@cert-authority` host certs | Principals per cert | Host certificates and short expiry instead of key sprawl |
| Termius | Client with synced vault | Local or vault keys | Prompts on first use | n/a | Import from ~/.ssh/config, host groups and tags, clean test-connection UX |

## Add-host UX (wizard step and Settings → Hosts)

1. **Address** — paste `user@host[:port]` (default user `orbit`, port 22), or "Import from ssh config": upload/paste a config snippet; Orbit resolves each entry with `ssh -G <alias>` and imports HostName, User, Port, ProxyJump, IdentityFile path (path only, never the key unless the user explicitly imports it). Name, tags (free) and roles (`worker`, `infra`, `build`).
2. **Reach** — transport: `direct` | `proxyJump` (pick another Orbit host) | `tailscale` (user's tailnet, MagicDNS name) | `tailcat` (paste a `tc…` address; ProxyCommand through tailcat, pending a test that it works as a netcat-style ProxyCommand) | `cloudflare` (`ProxyCommand cloudflared access ssh --hostname %h`).
3. **Authorize** — show either:
   - the restricted line: `restrict,pty ssh-ed25519 AAAA… orbit-<installId>` (drop `pty` for hosts without a terminal; add `from="<orbit egress>"` when known), or
   - a bootstrap one-liner the user pastes as root once: creates user `orbit`, installs that line, optionally adds `orbit` to the `docker` group (warn: root-equivalent) and writes a scoped `/etc/sudoers.d/orbit`, then prints the host's ed25519 fingerprint. The script is shown in full, inlined (no remote download), and is idempotent.
4. **Test connection** — Orbit runs `ssh -o BatchMode=yes … true`, shows the host key fingerprint it saw next to "compare with the fingerprint the bootstrap printed", pins on confirm, then preflights: OS/arch, disk, Docker/Compose versions, sudo scope, clock skew. Friendly errors (auth refused vs unreachable vs host key changed).
5. **Permissions** — per agent (setup, Pi, OpenCode, Hermes, bundlebees deployer): `none | read | deploy | admin`. Default: setup agent `deploy`, others `none`.
6. **Done** — host card with status, last seen, roles, transport, key in use, Remove/Rotate buttons.

## Key handling compared

| Option | Verdict | Why |
|---|---|---|
| Orbit-generated ed25519, per install | Default | Simple, one line to authorize, easy rotate-all; unattended (no passphrase) but 0600 + optionally encrypted at rest with an Orbit master key |
| Per-host generated keys | Option | Blast radius per host; more rotation work |
| Import existing key | Advanced, warned | Reuses the user's personal key inside a server; prefer a dedicated key |
| ssh-agent forwarding | Off (`ForwardAgent no`) | A compromised remote host can use the forwarded agent; Orbit runs unattended anyway |
| Passphrase keys | Not for unattended use | Orbit can't answer prompts (same as Coolify); protect with file perms / encryption at rest |
| SSH certificates (Orbit CA or step-ca) | Phase 2 | Short-lived per-agent identity, principals, `force-command`/`source-address`, expiry instead of revocation |
| Tailscale SSH | Option for tailnet users | No keys to manage, ACL + check mode; ties to Tailscale account |
| Teleport | Bring-your-own | Strong but heavy and commercially licensed binaries |

## Host key verification

- Orbit-owned `runtime/ssh/known_hosts` (`UserKnownHostsFile`), `GlobalKnownHostsFile /dev/null`, unhashed entries keyed by host id alias.
- First use: verified TOFU — fingerprint shown in UI, compared with the bootstrap's printed fingerprint (or pasted from provider console).
- After pin: `StrictHostKeyChecking yes`. Changed key ⇒ hard fail, host marked "key changed", all agent actions blocked, re-verify needs a user action with old/new fingerprints shown.
- `UpdateHostKeys yes` is acceptable (new keys are only learned over an already-authenticated connection).
- Optional: trust a host CA via `@cert-authority` line for fleets.

## Least privilege on the host

- Dedicated `orbit` user; no root login, password auth off (bootstrap can offer to set these, never silently).
- `authorized_keys` with `restrict` (no port/agent/X11 forwarding, no pty) plus `pty` only where the terminal is enabled; optional `from=`.
- Scoped sudo: `/etc/sudoers.d/orbit` limited to e.g. `systemctl * orbit-*`, `/usr/bin/install` into `/opt/orbit`. Validate with `visudo -cf`.
- Docker group is root-equivalent: say so; offer rootless Docker for worker-only hosts.
- Optional forced command (`command="/opt/orbit/bin/orbit-shell"`) for "worker-only" hosts that permits only a fixed verb set (install/upgrade/status/remove worker).

## Agent access, approvals and audit

- Agents call Orbit tools, not `ssh`: `hosts.list`, `hosts.run(hostId, argv, {cwd, timeout})`, `hosts.put(hostId, path, content)`, `hosts.deploy(hostId, recipeId, params)`.
- Permission check per agent × host × level. `read` = status/logs; `deploy` = recipes and allow-listed commands; `admin` = raw shell with approvals.
- Approval gate: commands matching destructive patterns (`rm -r`, `docker system prune`, `docker volume rm`, `compose down -v`, `reboot`/`shutdown`, `userdel`, `iptables`/`ufw`, package removal, writes outside `/opt/orbit`, sudo outside the allow-list) pause and ask the user in the UI with host, agent, exact command.
- Audit log: `runtime/audit/hosts/<hostId>.jsonl`, append-only, 0600: time, agent, host, argv (secrets redacted), approval id, exit code, duration, output size + truncated tail. Shown per host in Settings.

## Execution

- Generated `runtime/ssh/config` per host alias:
  `HostName, User, Port, IdentityFile, IdentitiesOnly yes, BatchMode yes, StrictHostKeyChecking yes, UserKnownHostsFile …, ForwardAgent no, ControlMaster auto, ControlPath runtime/ssh/cm/%C, ControlPersist 10m, ServerAliveInterval 15, ConnectTimeout 10, ProxyJump/ProxyCommand per transport`.
- Spawn with an argv array (no shell interpolation of user/agent text), `timeout`, low priority for long jobs.
- File transfer: `sftp`/`scp` (sftp protocol) or `rsync -e "ssh -F …"`.
- Docker: `docker context create orbit-<hostId> --docker "host=ssh://orbit-<hostId>"` (uses the same ssh config), then `docker --context orbit-<hostId> compose -p orbit-worker up -d`. Works under `restrict` (no forwarding needed).

## Idempotent bundlebees worker deploy (recipe `bundlebees-worker`)

1. Preflight: arch, Docker ≥ required, disk, time sync.
2. Ensure `/opt/orbit/worker` exists with correct owner.
3. Issue a fresh **pairing code** in Orbit; write `compose.yaml` + `.env` (0600) with the worker image pinned by digest and the pairing code (not the SSH key, not a long-lived token).
4. `docker compose pull && up -d` via the host's context.
5. Wait for the worker to dial out and pair; mark host role `worker` healthy.
6. Re-running converges (same digest ⇒ no-op); upgrade = new digest; remove = `compose down` + delete dir + revoke worker token.

## Revoke, rotate, clean up

- **Remove host**: optional cleanup run first (uninstall worker, remove the `orbit-<installId>` line by its comment marker, remove sudoers file, optionally delete user) → revoke worker tokens → `docker context rm` → close ControlMaster (`ssh -O exit`) → delete known_hosts entry → delete per-host key if any → keep audit log (archived).
- **Rotate key**: generate new key → push new line using the old key → test with new key → remove old line → delete old key. Batch across hosts; report per-host result. Suggested every 90 days and immediately on suspicion.
- **Unreachable host**: mark revoked locally; show the exact line the user must delete manually.
- With certificates: short expiry makes revocation mostly automatic; keep a KRL for emergencies.

## Config schema (orbit-config.json, no secrets)

```json
{
  "components": { "hosts": true },
  "ssh": {
    "defaultKey": { "id": "orbit-default", "type": "ed25519", "keyRef": { "file": "ssh/keys/orbit-default" }, "publicKey": "ssh-ed25519 AAAA… orbit-<installId>", "createdAt": "2026-11-12T00:00:00Z" },
    "rotationDays": 90,
    "ca": { "enabled": false, "keyRef": { "file": "ssh/ca/orbit-user-ca" }, "certTtl": "1h" }
  },
  "hosts": [
    {
      "id": "build-01",
      "label": "Build box",
      "address": "203.0.113.10",
      "port": 22,
      "user": "orbit",
      "tags": ["eu"],
      "roles": ["worker", "infra"],
      "transport": { "kind": "direct | proxyJump | tailscale | tailcat | cloudflare", "jumpHostId": null, "tailcatAddrRef": null, "cloudflareHostname": null },
      "auth": { "kind": "orbit-key | host-key | imported | certificate | tailscale-ssh", "keyId": "orbit-default" },
      "hostKey": { "fingerprints": ["SHA256:…"], "pinnedAt": "…", "verifiedBy": "bootstrap-fingerprint | manual | host-ca" },
      "privilege": { "sudo": "none | scoped | full", "docker": "group | rootless | none", "forcedCommand": false, "terminal": false },
      "permissions": { "setup": "deploy", "pi": "none", "opencode": "none", "hermes": "none", "bundlebees": "deploy" },
      "docker": { "context": "orbit-build-01" },
      "status": { "state": "verified | key-changed | unreachable | revoked", "lastSeen": "…" }
    }
  ]
}
```
Rules: private keys, CA keys and tailcat addresses (bearer capabilities) live only in `runtime/` files at 0600; the config holds refs and public material only. Example address uses the documentation range 203.0.113.0/24.

## Security checklist

- [ ] System OpenSSH ≥ 10.x in the image; PQ kex on; keep it patched (10.6p2 fixed a PAM-less password bypass on musl).
- [ ] Private keys 0600 in a 0700 dir, write-only from the UI, never in API responses, logs, events, agent context or orbit-config.json.
- [ ] Dedicated key comment `orbit-<installId>` so lines can be found and removed.
- [ ] `StrictHostKeyChecking yes` after verified pin; never `no`/`accept-new` silently; changed key blocks everything.
- [ ] `ForwardAgent no`, `IdentitiesOnly yes`, `BatchMode yes`, Orbit-owned config/known_hosts only.
- [ ] Dedicated non-root user, `restrict` on the key, scoped sudo, docker-group risk disclosed.
- [ ] Agents use Orbit's host API only; per-agent per-host levels; destructive-command approvals; argv spawning, no shell string building.
- [ ] Append-only per-host audit log of every command.
- [ ] tailcat addresses treated as secrets (bearer capability); use `--allow` where possible.
- [ ] Remove/rotate flows tested; worker tokens revoked independently of SSH.
- [ ] Bootstrap script shown in full, inlined, idempotent, prints fingerprint; no `curl | sh` from a remote URL.

## Plugging in

- **Wizard**: step 1 "Choose what to install" gets "Remote hosts (optional)". If chosen, an "Add your first host" step follows providers/models; skippable.
- **Setup agent**: gets `hosts.*` tools with `deploy` on hosts the user approved; its checklist (SETUP_CHECKLIST.md) adds "verify host", "install worker recipe", "report audit summary".
- **bundlebees**: the `bundlebees-worker` recipe above; WorkerBackend stays transport-independent; SSH only installs/upgrades/removes.

## Sources
- OpenSSH post-quantum: https://www.openssh.org/pq.html
- OpenSSH release notes (10.5, 10.6, 10.6p2): https://www.openssh.org/releasenotes.html
- ssh2 npm (1.17.0): https://www.npmjs.com/package/ssh2 ; ML-KEM PR: https://github.com/mscdex/ssh2/pull/1471
- Coolify add server: https://coolify.io/docs/core/infrastructure/servers/add-server ; SSH keys: https://coolify.io/docs/core/security/credentials/ssh-keys
- Dokploy SSH keys: https://docs.dokploy.com/docs/core/ssh-keys ; remote servers: https://docs.dokploy.com/docs/core/remote-servers/instructions
- CapRover multi-node: https://caprover.com/docs/scaling/multi-node
- Kamal SSH: https://kamal-deploy.org/docs/configuration/ssh/ ; hashed known_hosts issue: https://github.com/basecamp/kamal/issues/1814
- Tailscale SSH: https://tailscale.com/docs/features/tailscale-ssh
- Smallstep SSH certificates: https://smallstep.com/docs/tutorials/ssh-certificate-login/
- Teleport community license: https://goteleport.com/blog/teleport-community-license/
