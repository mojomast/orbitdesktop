// Static trusted relay only. No owner API, credentials or durable HTML storage.
export function createMcpAppsSandbox({ hostOrigins }) {
  if (!Array.isArray(hostOrigins) || !hostOrigins.length || hostOrigins.some(origin => new URL(origin).origin !== origin)) throw Error('Exact host origins required');
  const script = `const allowed=${JSON.stringify(hostOrigins)};
const q=new URLSearchParams(location.hash.slice(1)),host=q.get('host'),nonce=q.get('nonce');
if(allowed.includes(host)&&/^[a-f0-9-]{36}$/.test(nonce||'')){
 let frame=null,ready=false;
 const send=message=>parent.postMessage({...message,orbitNonce:nonce},host);
 addEventListener('message',event=>{
  const m=event.data;
  if(!m||m.jsonrpc!=='2.0')return;
  if(event.source===parent&&event.origin===host&&m.orbitNonce===nonce){
   if(m.method==='ui/notifications/sandbox-resource-ready'){
    if(ready)return;ready=true;
    if(typeof m.params?.html!=='string'||m.params.html.length>2097152)return;
    frame=document.createElement('iframe');frame.sandbox='allow-scripts';frame.title='MCP application';
    frame.srcdoc='<meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; script-src &apos;unsafe-inline&apos;; style-src &apos;unsafe-inline&apos;; img-src data:; connect-src &apos;none&apos;; form-action &apos;none&apos;; base-uri &apos;none&apos;">'+m.params.html;
    document.body.append(frame);
   }else if(frame){const {orbitNonce:_,...message}=m;frame.contentWindow.postMessage(message,'*');}
  }else if(frame&&event.source===frame.contentWindow&&event.origin==='null'){
   // Never relay proxy-only messages from untrusted application code.
   if(m.method==='ui/notifications/sandbox-proxy-ready'||m.method==='ui/notifications/sandbox-resource-ready')return;
   send(m);
  }
 });
 send({jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready',params:{}});
}`;
  return { handler(req, res) {
    if (req.method !== 'GET' || !['/mcp-apps/proxy', '/mcp-apps/proxy.js'].includes(req.url)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Cache-Control', 'no-store');
    // srcdoc inherits this policy; inline scripts are necessary for self-contained
    // app bundles. The inner policy separately removes 'self' script authority.
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; frame-src about: 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${hostOrigins.join(' ')}`);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), clipboard-write=()');
    res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(req.url.endsWith('.js') ? script : '<!doctype html><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style><script src="/mcp-apps/proxy.js"></script>');
  } };
}
