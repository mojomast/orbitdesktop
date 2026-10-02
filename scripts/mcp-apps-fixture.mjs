// Disposable two-origin fixture; never start against an owner runtime.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { build, createServer } from 'vite';
import { createMcpApps } from '../server/mcp-apps.mjs';
import { createMcpAppsSandbox } from '../server/mcp-apps-sandbox.mjs';
const root = fs.mkdtempSync(path.join('/tmp/opencode/', 'mcp-apps-fixture-'));
const repo = process.cwd();
const appEntry = path.join(root, 'app.ts');
fs.writeFileSync(appEntry, `import {App} from ${JSON.stringify(path.join(repo, 'node_modules/@modelcontextprotocol/ext-apps/dist/src/app.js'))};
const app=new App({name:'Orbit reference snapshot',version:'1.0.0'},{});
document.body.innerHTML='<h1>Reference MCP App</h1><output id="result"></output><button id="local">Local interaction</button><button id="resize">Resize app</button><button id="deny">Try forbidden authority</button><output id="denied"></output>';
document.querySelector('#local').onclick=()=>document.querySelector('#local').textContent='Local interaction works';
app.ontoolresult=r=>{document.querySelector('#result').textContent=JSON.stringify(r);void app.sendLog({level:'info',data:'Reference result rendered'});};
document.querySelector('#resize').onclick=()=>app.sendSizeChanged({height:550});
app.ontoolcancelled=()=>document.querySelector('#result').textContent='Cancelled';
app.onteardown=async()=>({});
document.querySelector('#deny').onclick=async()=>{let n=0,id=1000;for(const [method,params] of [['ui/message',{role:'user',content:[{type:'text',text:'deny'}]}],['ui/update-model-context',{content:[]}],['ui/open-link',{url:'https://example.com'}],['ui/download-file',{contents:[]}],['tools/call',{name:'blocked',arguments:{}}],['resources/read',{uri:'ui://blocked'}],['sampling/createMessage',{messages:[],maxTokens:1}]]){const callId=++id;const reply=await new Promise(resolve=>{const listener=e=>{if(e.source===parent&&e.data?.id===callId){removeEventListener('message',listener);resolve(e.data);}};addEventListener('message',listener);parent.postMessage({jsonrpc:'2.0',id:callId,method,params},'*');});if(reply.error?.code===-32601)n++;}document.querySelector('#denied').textContent='Denied '+n;};
void app.connect();`);
const bundle = await build({ configFile: false, logLevel: 'error', build: { write: false, minify: 'esbuild', lib: { entry: appEntry, formats: ['iife'], name: 'ReferenceApp' }, rollupOptions: { output: { inlineDynamicImports: true } } } });
const code = (Array.isArray(bundle) ? bundle[0] : bundle).output.find(item => item.type === 'chunk').code;
const snapshot = { title: 'Reference snapshot', resource_uri: 'ui://orbit/reference', html: `<script type="module">${code.replaceAll('</script', '<\\/script')}</script>`, arguments: { fixture: true }, result: { content: [{ type: 'text', text: 'Exact saved result' }] } };
const sandbox = http.createServer(); await new Promise(resolve => sandbox.listen(0, '127.0.0.1', resolve));
const sandboxOrigin = `http://127.0.0.1:${sandbox.address().port}`;
const vite = await createServer({ configFile: false, root: repo, logLevel: 'error', server: { middlewareMode: true, hmr: false, fs: { allow: [repo, root] } } });
let service;
const server = http.createServer(async (req,res) => {
  if (req.url === '/' || req.url.startsWith('/?')) { res.setHeader('Content-Type','text/html'); res.end(`<button id="unlock">Unlock fixture host</button><button id="lock">Lock fixture host</button><button id="rotate">Rotate fixture token</button><div id="host"></div><script type="module">import {mountMcpApps} from '/src/mcp-apps-host.ts';import {connectWorkspace} from '/src/workspace-sync.ts';let credential=new URL(location.href).searchParams.has('locked')?'':'fixture-token';const connection=connectWorkspace(()=>({version:1,monitors:[]}),()=>{},()=>credential,()=>{});const mounted=mountMcpApps(document.querySelector('#host'),()=>credential);for(const [id,value]of [['unlock','fixture-token'],['lock',''],['rotate','fixture-token-rotated']])document.querySelector('#'+id).onclick=()=>{credential=value;if(id!=='rotate')window.dispatchEvent(new Event('orbit-host-connected'));};document.querySelector('#host').addEventListener('detach',()=>mounted.dispose());</script>`); return; }
  if (req.url === '/fixture-snapshot') { res.setHeader('Content-Type','application/json');res.end(JSON.stringify(snapshot));return; }
  if (req.url.startsWith('/api/')) {
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    try {
      if(!['Bearer fixture-token','Bearer fixture-token-rotated'].includes(req.headers.authorization))throw Error('Forbidden');
      const body=JSON.parse(Buffer.concat(chunks));
      const value=req.url==='/api/mcp-apps'? service.dispatch(body) : {state:{version:1,monitors:[]},revision:1,observed_revision:1};
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));
    }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}return;
  }
  vite.middlewares(req,res);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
service=createMcpApps({root,workspaceRead:()=>true,sandboxOrigin});
sandbox.on('request',createMcpAppsSandbox({hostOrigins:[origin]}).handler);
console.log(JSON.stringify({origin,sandboxOrigin}));
async function close(){await vite.close();server.close();sandbox.close();fs.rmSync(root,{recursive:true,force:true});process.exit();}
process.on('SIGTERM',close);process.on('SIGINT',close);
