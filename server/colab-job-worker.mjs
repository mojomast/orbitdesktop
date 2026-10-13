/** One Colab CLI step, detached from Orbit so a restart can keep tailing its log. */
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { redactSecrets } from './colab-plan.mjs';

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const silenceMs = Number(spec.silenceMs);
const wallMs = Number(spec.wallMs);
if (!Number.isFinite(silenceMs) || !Number.isFinite(wallMs) || silenceMs < 1000 || wallMs < 1000) process.exit(1);
if (!spec.bin || !Array.isArray(spec.args) || !spec.log || !spec.exit) process.exit(1);

const log = fs.createWriteStream(spec.log, { flags: 'a', mode: 0o600 });
const decoder = new StringDecoder('utf8');
const child = spawn(spec.bin, spec.args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let silence = setTimeout(stop, silenceMs);
const wall = setTimeout(stop, wallMs);
function stop() { try { child.kill('SIGTERM'); } catch { /* already exited */ } }
function bump() { clearTimeout(silence); silence = setTimeout(stop, silenceMs); }
function write(chunk) {
  bump();
  const text = redactSecrets(decoder.write(chunk));
  if (text) log.write(text);
}
child.stdout.on('data', write);
child.stderr.on('data', write);
child.on('error', error => {
  const message = error?.code === 'ENOENT' ? 'Colab CLI was not found.' : 'Colab CLI could not be started.';
  log.write(`\n[orbit] ${message}\n`);
});
if (spec.stdin) child.stdin.write(String(spec.stdin));
if (spec.holdStdin && spec.socket) {
  try { fs.rmSync(spec.socket, { force: true }); } catch { /* no previous socket */ }
  const server = net.createServer(socket => {
    socket.on('data', chunk => { if (child.stdin.writable) child.stdin.write(chunk); });
  });
  server.listen(spec.socket, () => { try { fs.chmodSync(spec.socket, 0o600); } catch { /* already private */ } });
  child.on('close', () => server.close());
} else child.stdin.end();
child.on('close', (code, signal) => {
  clearTimeout(silence);
  clearTimeout(wall);
  const rest = redactSecrets(decoder.end());
  if (rest) log.write(rest);
  log.end(() => {
    fs.writeFileSync(spec.exit, JSON.stringify({ code: code ?? 1, signal: signal || null }), { mode: 0o600 });
    process.exit(0);
  });
});
