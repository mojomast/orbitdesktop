import * as pty from "node-pty";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
// The persistent path needs a real tmux. It is resolved at spawn time rather than
// hardcoded, so a non-Linux host can point ORBIT_TMUX_BIN at a real binary or fall
// back to a non-persistent shell instead of failing to open the pane at all.
function tmuxBinary() {
  const candidate = process.env.ORBIT_TMUX_BIN || '/usr/bin/tmux';
  try { return fs.existsSync(candidate) ? candidate : null; } catch { return null; }
}
let warnedNoTmux = false;
function validateSocket(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(value)) {
    throw Error('Invalid tmux socket name');
  }
  return value;
}
export async function captureHistory(pane_id, tmuxSocket = process.env.ORBIT_TMUX_SOCKET || 'orbit-persistent') {
  validateSocket(tmuxSocket);
  if (typeof pane_id !== 'string' || !/^[a-f0-9-]{36}$/.test(pane_id)) throw new Error('Persistent history unavailable');
  const tmux = tmuxBinary();
  if (!tmux) throw new Error('Persistent history unavailable');
  const target = 'pane-' + pane_id + ':0.0';
  const capture = async (extra) => (await exec(tmux, ['-L', tmuxSocket, 'capture-pane', '-p', '-J', '-t', target, ...extra], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout;
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
      this.env.ORBIT_HOST_SHELL ||
      (process.platform === "win32"
        ? "powershell.exe"
        : this.env.SHELL || "/bin/bash");
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
    // Windows: the host server's PATH may resolve `ssh` to a bundled Git/MSYS client,
    // which cannot reach the Windows ssh-agent service (named pipe) that holds the
    // owner's keys - a normal shell authenticates and this one does not. Put the
    // Windows OpenSSH client first so panes behave like the owner's own terminal.
    // Inert unless the client is actually present; no-op off Windows.
    if (process.platform === "win32") {
      const openSshDir = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "OpenSSH");
      const openSshExe = path.join(openSshDir, "ssh.exe");
      if (fs.existsSync(openSshExe)) {
        const entries = String(env.PATH ?? env.Path ?? "").split(";").filter(Boolean);
        const alreadyFirst = entries[0] && path.resolve(entries[0]) === path.resolve(openSshDir);
        if (!alreadyFirst) {
          env.PATH = [openSshDir, ...entries.filter((e) => path.resolve(e) !== path.resolve(openSshDir))].join(";");
          delete env.Path;
        }
        if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = openSshExe;
      }
    }
    const persistent = typeof pane_id === 'string' && /^[a-f0-9-]{36}$/.test(pane_id);
    if (tmuxArguments && (!persistent || !Array.isArray(tmuxArguments))) throw Error('Invalid managed attachment');
    // Without tmux there is no way to resume a pane's shell across reconnects, but an
    // explicit shell with a warning beats "Unable to start the configured shell": the
    // pane opens and reconnecting simply starts a fresh shell.
    const tmux = persistent ? tmuxBinary() : null;
    if (persistent && !tmux && !warnedNoTmux) {
      warnedNoTmux = true;
      console.warn(`Host shell: tmux not found at ${process.env.ORBIT_TMUX_BIN || '/usr/bin/tmux'}; persistent shells are unavailable, using ${shell} without resume.`);
    }
    return pty.spawn(tmux || shell, tmux ? ['-L', this.tmuxSocket, ...(this.tmuxConfig ? ['-f', this.tmuxConfig] : []), ...(tmuxArguments || ['new-session', '-A', '-s', 'pane-' + pane_id, shell])] : [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: this.cwd,
      env,
    });
  }
}
