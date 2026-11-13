# SSH hosts

Orbit can add remote Linux hosts for infrastructure and worker deployment without
putting SSH key material in the browser, model context, events or logs. Kyle's
requirement was: "i want to be able to add hosts to orbit easily for ssh access
for deploying infrastructure or workers." This page describes the SSH core; the
Settings → Hosts wizard and agent-facing `hosts.*` tools are wired by the Orbit
server around these modules.

## System OpenSSH only

There is no Node SSH library in this path. Orbit drives the system tools
`ssh`, `ssh-keygen`, `ssh-keyscan`, `sftp` and the owner's `cloudflared` when the
Cloudflare transport is selected. Every connection uses Orbit's own client
config:

```sh
ssh -F <runtime>/ssh/config orbit-<hostId> ...
```

The owner's `~/.ssh/config` and system user config are never consulted. Every
spawn uses an argv array, an explicit minimal environment, a timeout and no shell
string interpolation. The install id used in the key comment is generated once
into `<runtime>/ssh/install-id` (0600) unless the runtime already has one.

## Keys

- One install key is generated on first use:
  `ssh-keygen -q -t ed25519 -N '' -C orbit-<installId> -f <runtime>/ssh/keys/orbit-default`.
  Re-running is a no-op.
- The private key is a 0600 file in a 0700 directory. Only public material is
  returned to callers or stored in `orbit-config.json`.
- A per-host key (`orbit-host-<hostId>`) is optional. It limits blast radius and
  supports independent rotation.
- Rotate on a schedule (default suggestion: 90 days) and immediately on
  suspicion. `rotatePlan()` returns a plan only; key replacement is an explicit
  reviewed flow.
- The `orbit-<installId>` comment is the marker used by bootstrap and cleanup.

## Host-key verification (verified TOFU)

1. `scanHostKey(hostId)` reads the ed25519 key once with `ssh-keyscan` and
   returns the SHA256 fingerprint Orbit saw. It never accepts a key.
2. The owner compares that fingerprint with the one printed by the bootstrap
   script (or the provider console).
3. `confirmPin(hostId, fingerprint)` pins only if the supplied value equals the
   scanned value. Orbit writes an unhashed entry keyed by the alias
   `orbit-<hostId>` (or `[orbit-<hostId>]:<port>` for a non-default port) into
   `<runtime>/ssh/known_hosts` and sets `HostKeyAlias orbit-<hostId>`.
4. After pinning, the config uses `StrictHostKeyChecking yes`,
   `UserKnownHostsFile <runtime>/ssh/known_hosts` and
   `GlobalKnownHostsFile /dev/null`.

Never use `StrictHostKeyChecking no`, `accept-new` or `ask` preferences. If the
host key later changes, `test()` maps OpenSSH's
`REMOTE HOST IDENTIFICATION HAS CHANGED` / `Host key verification failed` to
state `key-changed`. Every remote action is blocked until the owner scans and
confirms the new fingerprint.

## Generated config

Each host gets an `orbit-<hostId>` block with:

`HostName`, `User`, `Port`, `IdentityFile`, `IdentitiesOnly yes`, `BatchMode yes`,
`StrictHostKeyChecking yes`, `UserKnownHostsFile`, `GlobalKnownHostsFile
/dev/null`, `UpdateHostKeys yes`, `ForwardAgent no`, `ControlMaster auto`,
`ControlPath <runtime>/ssh/cm/%C`, `ControlPersist 10m`, `ServerAliveInterval 15`
and `ConnectTimeout 10`.

Transports:

| Kind | Behaviour |
| --- | --- |
| `direct` | Connect to the stored address. |
| `proxyJump` | `ProxyJump orbit-<jumpHostId>` through another Orbit-managed host. |
| `tailscale` | Connect directly to the host's MagicDNS name. |
| `cloudflare` | `ProxyCommand cloudflared access ssh --hostname %h`. |
| `tailcat` | **UNTESTED.** A 0600 runtime file holds the bearer address; the renderer reads it into the 0600 config as a `ProxyCommand`. Treat the address as a secret. |

The config and known_hosts files are written atomically with mode 0600; the
control-socket directory is 0700.

## Bootstrap script

`bootstrapScript({ publicKey, installId, docker, sudo })` returns a fully inlined,
idempotent shell script. It:

- creates a dedicated `orbit` user with a home directory;
- installs exactly one `restrict,pty ssh-ed25519 ... orbit-<installId>` line in
  `~orbit/.ssh/authorized_keys` (0600, directory 0700);
- optionally adds `orbit` to the `docker` group and prints the root-equivalent
  warning, or leaves rootless Docker to the owner;
- optionally writes a scoped `/etc/sudoers.d/orbit` policy and validates it with
  `visudo -cf` before installing it;
- prints the host's ed25519 fingerprint with
  `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.

The script contains no remote downloads. `oneLiner(script)` base64-encodes the
same script for a `sudo sh -c` invocation; show the readable script first.

## API

`createSshHosts({ runtimeDir, config, exec, log })` returns:

- `parseAddress('user@host[:port]')` — documented IPv4 and bracketed IPv6 input.
- `importFromSshConfig(text)` — sanitizes pasted config to `Host`, `HostName`,
  `User`, `Port`, `ProxyJump` and `IdentityFile`, then resolves each alias with
  `ssh -G -F <temp>`. `Match`, `Include`, `LocalCommand` and `ProxyCommand` are
  dropped before the temp file is written. Only the IdentityFile path is
  reported; key material is never read.
- `add(host)` — validates strictly, creates the install key and optional per-host
  key, writes the config and returns public state plus the exact
  `authorized_keys` line.
- `scanHostKey(hostId)`, `confirmPin(hostId, fingerprint)`.
- `test(hostId)` — `ssh ... true` then preflight (`uname -m`, `df`, Docker,
  Compose, `sudo -n -l`, date). A changed key returns
  `{ ok: false, reason: 'key-changed' }` and blocks future actions.
- `status(hostId?)`, `list()`.
- `revoke(hostId)` — local only: closes the ControlMaster, drops the known_hosts
  entry, deletes a per-host key and returns the exact line to delete by hand if
  the host is unreachable. The audit log is kept.
- `remove(hostId, { cleanup })` — optional remote cleanup first. **UNTESTED**:
  removes the `orbit-<installId>` authorized_keys line and
  `/etc/sudoers.d/orbit`; then the local revoke runs even if the host is
  unreachable.

## Configuration shape

`orbit-config.json` holds references and public material only:

```json
{
  "components": { "hosts": true },
  "ssh": {
    "defaultKey": {
      "id": "orbit-default",
      "type": "ed25519",
      "keyRef": { "file": "ssh/keys/orbit-default" },
      "publicKey": "ssh-ed25519 AAAA… orbit-example01",
      "fingerprint": "SHA256:…",
      "createdAt": "2026-11-12T00:00:00Z"
    },
    "rotationDays": 90,
    "ca": { "enabled": false }
  },
  "hosts": [
    {
      "id": "build-01",
      "label": "Build box",
      "address": "203.0.113.10",
      "port": 22,
      "user": "orbit",
      "tags": ["ci"],
      "roles": ["worker", "infra"],
      "transport": { "kind": "direct", "jumpHostId": null, "tailcatAddrRef": null, "cloudflareHostname": null },
      "auth": { "kind": "orbit-key", "keyId": "orbit-default" },
      "hostKey": {
        "fingerprints": ["SHA256:…"],
        "pinnedAt": "2026-11-12T00:00:00Z",
        "verifiedBy": "bootstrap-fingerprint"
      },
      "privilege": { "sudo": "scoped", "docker": "group", "forcedCommand": false, "terminal": true },
      "permissions": { "setup": "none", "pi": "none", "opencode": "none", "hermes": "none", "bundlebees": "none" },
      "docker": { "context": "orbit-build-01" },
      "status": { "state": "verified", "lastSeen": "2026-11-12T00:00:00Z" }
    }
  ]
}
```

Example addresses use the documentation range 203.0.113.0/24. The merged schema
fragment is `config/orbit-config.hosts.schema.json`; it rejects private-key,
secret, passphrase, password and raw tailcat-address fields. The core config
module remains responsible for the complete file.

## Permissions and audit

The host object carries per-agent permission levels (`none`, `read`, `deploy`,
`admin`) for `setup`, `pi`, `opencode`, `hermes` and `bundlebees`, plus up to 32
validated agent ids (`^[a-z0-9][a-z0-9-]{0,31}$`). Every agent, including setup,
starts at `none`; an unknown or invalid agent id always gets `none`. Raising an
agent to `deploy` or `admin` is an explicit owner choice: the UI asks for
confirmation, the API refuses the change without `confirm: true` (409), and each
permission change is appended to the host audit log as
`orbit-permission <agent> <from> <to>`.

Destructive commands run only when the approval channel returns
`{ approved: true, id: <non-empty string>, authenticated: true }`. A bare id
string, `true`, status or decision strings, a missing id or `authenticated`,
malformed objects, errors and timeouts are refusals and are audited as such.

Docker group membership is root-equivalent on the host, so `privilege.docker:
"group"` is refused unless `privilege.dockerGroupRootEquivalent: true` is set,
and `bootstrapScript` refuses it without the same acknowledgement. Agents never
receive key material; they call Orbit's host API. Every action appends a bounded
JSON line to `<runtime>/audit/hosts/<hostId>.jsonl` (0600) with the action,
outcome, exit code, duration and error reason. Private keys and tailcat addresses
are not recorded.

## UI

The Hosts surface uses the existing dark Orbit theme variables only. There is no
light theme. Show the scanned fingerprint next to the bootstrap's printed value,
keep the key write-only, and label tailcat transport and remote cleanup as
**UNTESTED** in the UI as well as here.

## Tests

- `tests/ssh-hosts.test.mjs` — hermetic unit tests with an injected argv-array
  executor: address parsing, config hardening, `ssh -G` import, schema secrets,
  bootstrap content, key modes, sentinel checks, revoke/remove and changed-key
  handling.
- `tests/ssh-sshd.test.mjs` — starts a throwaway `sshd` from a temp directory
  (generated host key, `-f` temp config, `ListenAddress 127.0.0.1`, random port,
  temp `AuthorizedKeysFile`, `StrictModes no`, `-D -e`). It skips with a clear
  message when no sshd/ssh toolchain is installed. It never touches `~/.ssh` or
  the system sshd. OpenSSH 10 split binaries are supported with
  `ORBIT_TEST_SSHD_SESSION` / `ORBIT_TEST_SSHD_AUTH`.

Run:

```sh
timeout 900 node --experimental-strip-types --test --test-concurrency=1 \
  tests/ssh-hosts.test.mjs tests/ssh-sshd.test.mjs
```
