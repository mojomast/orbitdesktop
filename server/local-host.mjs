import * as pty from "node-pty";
import os from "node:os";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function captureHistory(pane_id, tmuxSocket = 'orbit-persistent') {
  if (typeof pane_id !== 'string' || !/^[a-f0-9-]{36}$/.test(pane_id)) throw new Error('Persistent history unavailable');
  const target = 'pane-' + pane_id + ':0.0';
  const capture = async (extra) => (await exec('/usr/bin/tmux', ['-L', tmuxSocket, 'capture-pane', '-p', '-J', '-t', target, ...extra], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  const history = await capture(['-S', '-']);
  const alternate = await capture(['-a', '-q']);
  return history + (alternate ? '\n\n--- Alternate application screen ---\n' + alternate : '');
}
/** HostProvider boundary: replace this adapter, not the WebSocket protocol, for SSH. */
export class LocalHostProvider {
  constructor({ tmuxSocket = 'orbit-persistent', cwd = process.env.ORBIT_CWD || os.homedir(), home, env = process.env, tmuxConfig } = {}) {
    this.tmuxSocket = tmuxSocket;
    this.cwd = cwd;
    this.home = home;
    this.env = { ...env };
    this.tmuxConfig = tmuxConfig;
  }

  spawn({ cols, rows, pane_id }) {
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
    delete env.ORBIT_TOKEN;
    delete env.HERMES_API_KEY;
    const persistent = typeof pane_id === 'string' && /^[a-f0-9-]{36}$/.test(pane_id);
    return pty.spawn(persistent ? '/usr/bin/tmux' : shell, persistent ? ['-L', this.tmuxSocket, ...(this.tmuxConfig ? ['-f', this.tmuxConfig] : []), 'new-session', '-A', '-s', 'pane-' + pane_id, shell] : [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: this.cwd,
      env,
    });
  }
}
