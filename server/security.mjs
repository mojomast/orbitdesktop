import { timingSafeEqual } from "node:crypto";
export const publicOrigin = process.env.ORBIT_PUBLIC_ORIGIN || "";
export const publicHost = publicOrigin ? new URL(publicOrigin).host : "";
export function tokenMatches(value, expected) {
  if (typeof value !== "string" || value.length > 256) return false;
  const a = Buffer.from(value),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function geometry(cols, rows) {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= 2 &&
    cols <= 500 &&
    rows >= 1 &&
    rows <= 250
  );
}
const listenHostPattern = /^[A-Za-z0-9_.:-]{1,253}$/;

/** Bind address for the Orbit HTTP server. Defaults to loopback. */
export function resolveListenHost(value = process.env.ORBIT_HOST || "127.0.0.1") {
  const host = String(value).trim();
  if (!listenHostPattern.test(host) || host.includes(".."))
    throw Error("ORBIT_HOST must be a hostname or IP address.");
  return host;
}

function bracketHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Host and Origin values accepted for this process.
 * A specific bind address is allowed. Wildcard binds stay closed until
 * ORBIT_PUBLIC_ORIGIN names the exact browser origin.
 */
export function acceptedHosts(port, devOrigins = [], listenHost = resolveListenHost()) {
  const hosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    ...(publicHost ? [publicHost] : []),
  ]);
  const origins = new Set(
    [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].concat(devOrigins, publicOrigin ? [publicOrigin] : []),
  );
  const wildcard = listenHost === "0.0.0.0" || listenHost === "::" || listenHost === "[::]";
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(listenHost);
  if (!wildcard && !loopback) {
    const shown = bracketHost(listenHost);
    hosts.add(`${shown}:${port}`);
    origins.add(`http://${shown}:${port}`);
  }
  return { hosts, origins };
}

export function allowedRequest(req, port, devOrigins = []) {
  const { hosts, origins } = acceptedHosts(port, devOrigins);
  if (!hosts.has(req.headers.host)) return false;
  return (
    typeof req.headers.origin === "string" && origins.has(req.headers.origin)
  );
}
