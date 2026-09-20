import * as pty from "node-pty";
import os from "node:os";
/** HostProvider boundary: replace this adapter, not the WebSocket protocol, for SSH. */
export class LocalHostProvider {
  spawn({ cols, rows, pane_id }) {
    const shell =
      process.platform === "win32"
        ? "powershell.exe"
        : process.env.SHELL || "/bin/bash";
    const env = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    };
    delete env.ORBIT_TOKEN;
    delete env.HERMES_API_KEY;
    const persistent = typeof pane_id === 'string' && /^[a-f0-9-]{36}$/.test(pane_id);
    return pty.spawn(persistent ? '/usr/bin/tmux' : shell, persistent ? ['-L', 'orbit-persistent', 'new-session', '-A', '-s', 'pane-' + pane_id, shell] : [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.env.ORBIT_CWD || os.homedir(),
      env,
    });
  }
}
