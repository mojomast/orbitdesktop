// ONLY imported with node --import in the disposable test server process.
// Never probe or touch a listener at 8787. Run the real proxy/collector HTTP
// exchange on a fresh loopback port; preserve the path, query, method, headers.
const native = globalThis.fetch;
const port = Number(process.env.FIXTURE_COLLECTOR_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port===8787) throw Error('invalid fixture port');
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== 'http://127.0.0.1:8787') return native(input,init);
  if (url.pathname !== '/snapshot' || url.search || init?.method !== 'GET') throw Error('unexpected fixture request');
  url.port=String(port);return native(url,init);
};
