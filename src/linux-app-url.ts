// Optional services use the same host and scheme as the Orbit page, never an author's host.
export function linuxAppUrl(origin: string, port: number, path = '/') {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid Orbit origin');
  url.port = String(port);
  url.pathname = '/'; url.search = ''; url.hash = '';
  return new URL(path, url).href;
}
