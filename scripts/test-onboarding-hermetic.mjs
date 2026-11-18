// Run the onboarding/registry slice without inheriting provider credentials,
// a package cache, git configuration or an existing Orbit runtime. Requires
// locked dependencies already installed. Only the fixtures use loopback.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'orbit-onboarding-suite-'));
try {
  const [home, tmp, runtime] = ['home', 'tmp', 'runtime'].map(name => {
    const dir = join(root, name); mkdirSync(dir, { mode: 0o700 }); return dir;
  });
  const cases = readdirSync(join(repo, 'tests')).filter(name => /^(onboarding(?:[-.].*)?|orbit-config(?:[-.].*)?|agent-discovery|agent-registry|quickstart-docs|deploy-config|zero-agents-boot)\.test\.mjs$/.test(name));
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-concurrency=1', ...cases.map(name => join('tests',name))], {
    cwd: repo, stdio: 'inherit', env: {
      HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp,
      PATH: [dirname(process.execPath), ...(process.platform === 'win32' ? [process.env.SystemRoot] : ['/usr/bin','/bin'])].filter(Boolean).join(delimiter),
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
      GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', npm_config_offline: 'true',
      ORBIT_RUNTIME_DIR: runtime, ORBIT_AGENT_DISCOVERY: 'off',
    },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(root, { recursive: true, force: true }); }
