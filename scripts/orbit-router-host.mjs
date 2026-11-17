#!/usr/bin/env node
import { startHostRouter } from '../server/router-host.mjs';

const [command, runtimeDir, manifestFile, ...extra] = process.argv.slice(2);
if (process.getuid?.() === 0) {
  console.error('Run the foreground router as its dedicated unprivileged operator account.');
  process.exitCode = 2;
} else if (command !== 'start' || !runtimeDir || !manifestFile || extra.length) {
  console.error('Usage: node scripts/orbit-router-host.mjs start /absolute/private/runtime /absolute/operator/manifest.json');
  process.exitCode = 2;
} else {
  let session, stopping = false;
  const stop = () => { stopping = true; session?.stop(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    session = await startHostRouter({ runtimeDir, manifestFile, confirmStart: true });
    console.error('Started pinned foreground child; router health has not been verified. Ctrl-C to stop.');
    if (stopping) stop();
    const { code, signal } = await session.done;
    process.exitCode = stopping && signal ? 0 : (code ?? 1);
  } catch {
    // Node JSON/parser/filesystem and child errors can contain owner input.
    console.error('Router launch refused. Check the manifest, private files, governance bindings and existing foreground run.');
    process.exitCode = 1;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
