import fs from 'node:fs';

// Windows compatibility for Orbit's POSIX durability pattern.
//
// The durable stores in this server follow fsync(file) -> rename -> fsync(directory).
// The directory step is a POSIX convention for making the rename itself durable. On
// Windows there is no equivalent for a directory handle, and more generally
// FlushFileBuffers requires a handle opened for WRITE: fsync on a handle opened
// read-only fails with EPERM.
//
// Every such call in this codebase re-flushes through a read-only handle
// (`fs.openSync(x, 'r')`), including the directory re-syncs and the shared-chat
// re-sync in agent.mjs. The write itself always goes through a writable handle whose
// own fsync succeeds, so the data is already flushed; only this secondary
// verification step is unavailable on Windows.
//
// Installed once, process-wide, rather than edited at each of the ~40 call sites.
// It is deliberately narrow: only EPERM/EINVAL/ENOTSUP, only on Windows, and only
// when the descriptor is still a valid fd we own. A real permissions problem on the
// file would surface at open/write time, never as a flush error.
const originalFsyncSync = fs.fsyncSync;
let installed = false;
let noticed = false;

export function installFsyncCompatibility() {
  if (installed) return { installed: false, reason: 'already installed' };
  installed = true;
  if (process.platform !== 'win32') return { installed: false, reason: 'not windows' };

  fs.fsyncSync = function fsyncSync(fd) {
    try {
      return originalFsyncSync.call(fs, fd);
    } catch (error) {
      const code = error?.code;
      if (code !== 'EPERM' && code !== 'EINVAL' && code !== 'ENOTSUP') throw error;
      let kind = 'unknown';
      try { kind = fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'; } catch { throw error; }
      if (!noticed) {
        noticed = true;
        console.warn(`fsync compatibility: Windows cannot flush a read-only ${kind} handle; secondary durability syncs are skipped for this platform.`);
      }
      return undefined;
    }
  };
  return { installed: true };
}
