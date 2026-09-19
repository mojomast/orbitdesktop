import { timingSafeEqual } from "node:crypto";
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
export function allowedRequest(req, port, devOrigins = []) {
  const hosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  if (!hosts.has(req.headers.host)) return false;
  const origins = new Set(
    [...hosts].map((h) => `http://${h}`).concat(devOrigins),
  );
  return (
    typeof req.headers.origin === "string" && origins.has(req.headers.origin)
  );
}
