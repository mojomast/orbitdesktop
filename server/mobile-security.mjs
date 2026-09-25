import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export const pixelNode = 'nZ5x4zzBKX11CNTRL';
export const pixelAddresses = new Set(['100.90.5.126', 'fd7a:115c:a1e0::5901:597']);
export function normalizeAddress(value = '') { return value.replace(/^::ffff:/, ''); }
export async function isPixel(address, lookup = async ip => JSON.parse((await exec('/usr/bin/tailscale', ['whois', '--json', ip], {timeout: 3000})).stdout)) {
  const ip = normalizeAddress(address);
  if (!pixelAddresses.has(ip)) return false;
  try { const identity = await lookup(ip); return identity.Node?.StableID === pixelNode; } catch { return false; }
}
export function validMobileOrigin(req, origin) {
  return req.headers.host === new URL(origin).host && (!req.headers.origin || req.headers.origin === origin) && !['cross-site'].includes(req.headers['sec-fetch-site']);
}
