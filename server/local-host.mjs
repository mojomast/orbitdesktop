import * as pty from "node-pty";
import os from "node:os";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
function validateSocket(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(value)) {
    throw Error('Invalid tmux socket name');
  }
  return value;
}
export async function captureHistory(pane_id, tmuxSocket = process.env.ORBIT_TMUX_SOCKET || 'orbit-persistent') {
  validateSocket(tmuxSocket);
  if (typeof pane_id !== 'string' || !/^[a-f0-9-]{36}$/.test(pane_id)) throw new Error('Persistent history unavailable');
  const target = 'pane-' + pane_id + ':0.0';
  const capture = async (extra) => (await exec('/usr/bin/tmux', ['-L', tmuxSocket, 'capture-pane', '-p', '-J', '-t', target, ...extra], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  const history = await capture(['-S', '-']);
  const alternate = await capture(['-a', '-q']);
  return history + (alternate ? '\n\n--- Alternate application screen ---\n' + alternate : '');
}
/** HostProvider boundary: replace this adapter, not the WebSocket protocol, for SSH. */
export class LocalHostProvider {
  constructor({ tmuxSocket = process.env.ORBIT_TMUX_SOCKET || 'orbit-persistent', cwd = process.env.ORBIT_CWD || os.homedir(), home, env = process.env, tmuxConfig = process.env.ORBIT_TMUX_CONFIG } = {}) {
    this.tmuxSocket = validateSocket(tmuxSocket);
    this.cwd = cwd;
    this.home = home;
    this.env = { ...env };
    this.tmuxConfig = tmuxConfig;
  }

  spawn({ cols, rows, pane_id }, { tmuxArguments } = {}) {
    const shell =
      process.platform === "win32"
        ? "powershell.exe"
        : this.env.SHELL || "/bin/bash";
    const env = {
      ...this.env,
      ...(this.home ? { HOME: this.home } : {}),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    };
    // Owner/agent credentials must never be inherited by a spawned host shell.
    // HERMES_PROFILES_JSON is a new server-config secret (configured API keys);
    // it is removed here alongside the existing secrets, never passed to tmux or
    // the shell environment.
    delete env.ORBIT_TOKEN;
    delete env.HERMES_API_KEY;
    delete env.HERMES_PROFILES_JSON;
    const persistent = typeof pane_id === 'string' && /^[a-f0-9-]{36}$/.test(pane_id);
    if (tmuxArguments && (!persistent || !Array.isArray(tmuxArguments))) throw Error('Invalid managed attachment');
    return pty.spawn(persistent ? '/usr/bin/tmux' : shell, persistent ? ['-L', this.tmuxSocket, ...(this.tmuxConfig ? ['-f', this.tmuxConfig] : []), ...(tmuxArguments || ['new-session', '-A', '-s', 'pane-' + pane_id, shell])] : [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: this.cwd,
      env,
    });
  }
}
