/**
 * Orbit host bootstrap.
 *
 * The script is fully inlined, idempotent and reviewable. It never downloads
 * anything. It creates a dedicated `orbit` user, authorizes exactly the Orbit
 * key with a `restrict` prefix and an `orbit-<installId>` comment marker, and
 * prints the host's ed25519 fingerprint so the owner can compare it with the
 * fingerprint Orbit scanned before pinning.
 */

const INSTALL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PUBLIC_KEY = /^(ssh-ed25519) ([A-Za-z0-9+/=]{32,})(?: ([^\r\n]*))?$/;
const MARKER_SAFE = /[\r\n\0'`$\\]/;

function safeInstallId(value) {
  if (typeof value !== 'string' || !INSTALL_ID.test(value)) throw new Error('Invalid Orbit install id.');
  return value;
}

function parsePublicKey(value) {
  if (typeof value !== 'string') throw new Error('An Orbit ed25519 public key is required.');
  const match = value.trim().match(PUBLIC_KEY);
  if (!match) throw new Error('An Orbit ed25519 public key is required.');
  if (match[3] !== undefined && !match[3].startsWith('orbit-')) throw new Error('The public key comment must identify Orbit.');
  return `${match[1]} ${match[2]}`;
}

/** Full bootstrap script, safe to show and paste as root once. */
export function bootstrapScript({ publicKey, installId, docker = 'none', sudo = 'none' } = {}) {
  const id = safeInstallId(installId);
  const key = parsePublicKey(publicKey);
  if (!['group', 'rootless', 'none'].includes(docker)) throw new Error('Invalid docker mode.');
  if (!['none', 'scoped'].includes(sudo)) throw new Error('Invalid sudo mode.');
  if (MARKER_SAFE.test(id)) throw new Error('Invalid Orbit install id.');
  const comment = `orbit-${id}`;
  const authLine = `restrict,pty ${key} ${comment}`;
  const lines = [
    '#!/bin/sh',
    `# Orbit host bootstrap for ${comment}.`,
    '# Idempotent. Run once as root. No remote fetches.',
    '# UNTESTED: nothing here touches the tailcat transport or remote removal.',
    'set -eu',
    'umask 077',
    '',
    'ORBIT_USER=orbit',
    'ORBIT_HOME=/home/orbit',
    '',
    'if ! id -u "$ORBIT_USER" >/dev/null 2>&1; then',
    '  if command -v useradd >/dev/null 2>&1; then',
    '    useradd -m -s /bin/sh "$ORBIT_USER"',
    '  elif command -v adduser >/dev/null 2>&1; then',
    '    adduser -D -s /bin/sh "$ORBIT_USER"',
    '  else',
    '    echo "No useradd or adduser found." >&2',
    '    exit 1',
    '  fi',
    'fi',
    'if [ ! -d "$ORBIT_HOME" ]; then',
    '  ORBIT_HOME=$(getent passwd "$ORBIT_USER" | cut -d: -f6)',
    'fi',
    'if [ -z "$ORBIT_HOME" ] || [ ! -d "$ORBIT_HOME" ]; then',
    '  echo "Could not resolve the orbit home directory." >&2',
    '  exit 1',
    'fi',
    'install -d -m 0700 -o "$ORBIT_USER" -g "$ORBIT_USER" "$ORBIT_HOME/.ssh"',
    'AUTHORIZED_KEYS="$ORBIT_HOME/.ssh/authorized_keys"',
    'touch "$AUTHORIZED_KEYS"',
    'chown "$ORBIT_USER:$ORBIT_USER" "$AUTHORIZED_KEYS"',
    'chmod 600 "$AUTHORIZED_KEYS"',
    `if grep -qF "${comment}" "$AUTHORIZED_KEYS"; then`,
    '  echo "Orbit key already authorized."',
    'else',
    `  printf '%s\\n' '${authLine}' >> "$AUTHORIZED_KEYS"`,
    '  echo "Orbit key authorized."',
    'fi',
  ];

  if (docker === 'group') {
    lines.push(
      '',
      '# WARNING: membership in the docker group is root-equivalent on this host.',
      'if getent group docker >/dev/null 2>&1; then',
      '  usermod -aG docker orbit 2>/dev/null || true',
      '  echo "Added orbit to the docker group (root-equivalent)."',
      'else',
      '  echo "Docker group not found; install Docker first or choose rootless." >&2',
      'fi',
    );
  } else if (docker === 'rootless') {
    lines.push(
      '',
      '# Rootless Docker: no docker group is added.',
      'echo "Rootless Docker selected. Configure rootless Docker for the orbit user."',
    );
  } else {
    lines.push('', '# Docker access not requested.', 'echo "Docker access not requested."');
  }

  if (sudo === 'scoped') {
    lines.push(
      '',
      '# Scoped sudo policy, validated before installation.',
      'SUDOERS_TMP=$(mktemp)',
      'cat > "$SUDOERS_TMP" <<\'ORBIT_SUDOERS\'',
      'Defaults:orbit !requiretty',
      'orbit ALL=(root) NOPASSWD: /bin/systemctl start orbit-*, /bin/systemctl stop orbit-*, /bin/systemctl restart orbit-*, /bin/systemctl status orbit-*, /bin/systemctl enable orbit-*, /bin/systemctl disable orbit-*, /usr/bin/install -m 0755 * /opt/orbit/*',
      'ORBIT_SUDOERS',
      'if visudo -cf "$SUDOERS_TMP" >/dev/null 2>&1; then',
      '  install -m 0440 -o root -g root "$SUDOERS_TMP" /etc/sudoers.d/orbit',
      '  echo "Installed scoped sudo policy at /etc/sudoers.d/orbit."',
      'else',
      '  echo "Refusing to install an invalid scoped sudo policy." >&2',
      '  rm -f "$SUDOERS_TMP"',
      '  exit 1',
      'fi',
      'rm -f "$SUDOERS_TMP"',
    );
  }

  lines.push(
    '',
    'echo "Host ed25519 fingerprint (compare with the fingerprint Orbit shows):"',
    'if [ -f /etc/ssh/ssh_host_ed25519_key.pub ]; then',
    '  ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub',
    'else',
    '  for key in /etc/ssh/ssh_host_*_key.pub; do',
    '    [ -f "$key" ] || continue',
    '    ssh-keygen -lf "$key"',
    '  done',
    'fi',
    '',
  );
  return lines.join('\n');
}

/** One-liner shown beside the readable script. */
export function oneLiner(script) {
  if (typeof script !== 'string' || !script.trim()) throw new Error('Bootstrap script is required.');
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  return `sudo sh -c "printf %s '${encoded}' | base64 -d | sh"`;
}
