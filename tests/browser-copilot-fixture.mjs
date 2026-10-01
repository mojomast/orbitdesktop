// Isolated real HTTP/SQLite/Vite fixture; no owner runtime, profiles or Hermes.
import {createServer as httpServer} from 'node:http';
import {createServer as viteServer} from 'vite';
import {mkdtemp,rm} from 'node:fs/promises';
import {createWorkspaceService} from '../server/workspace.mjs';
import {createBrowserCopilot} from '../server/browser-copilot.mjs';
import {createPlaywrightDriver} from '../server/browser-copilot-driver.mjs';
import {createBrowserCopilotHandler} from '../server/browser-copilot-route.mjs';

const root=await mkdtemp('/tmp/opencode/browser-copilot-browser-');
const token='synthetic-browser-fixture-token';let workspace,copilot,handler;
const reply=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const vite=await viteServer({configFile:false,server:{middlewareMode:true,hmr:false},appType:'custom'});
const server=httpServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/api/browser-copilot')return handler(req,res);
  if(path==='/api/workspace')return workspace.handle(req,res);
  if(path==='/api/workspace/events')return reply(res,200,{events:[],cursor:0,reset_required:false,has_more:false});
  if(path==='/fixture'){
    res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});
    return res.end(`<!doctype html><title>Synthetic Copilot Target</title><h1>Local test app</h1><p id="value">Counter 0</p><button onclick="document.querySelector('#value').textContent='Counter '+(++window.count)">Increment</button><input aria-label="Note"><a href="/neighbor" target="_blank">Open neighbor</a><p id="note"></p><button onclick="document.querySelector('#note').textContent=document.querySelector('input').value">Apply note</button><div style="height:1400px"></div><p>Bottom</p><script>window.count=0</script>`);
  }
  if(path==='/neighbor'){
    res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});return res.end('<title>Neighbor Target</title><h1>Neighbor untouched</h1><button onclick="document.body.textContent=\'WRONG TARGET MUTATED\'">Increment</button>');
  }
  if(path==='/'){
    const html=`<!doctype html><title>Copilot isolated acceptance</title>
      <nav><button id="unlock">Unlock fixture host</button><button id="lock">Lock fixture host</button><button id="reconnect">Reconnect fixture host</button><button id="hold">Hold next capability response</button><button id="release">Release held response</button><button id="dispose">Dispose fixture pane</button><span id="held"></span></nav>
      <main id="host" style="height:95vh"></main><script type="module">
      import {monitor} from '/src/model.ts';import {connectWorkspace} from '/src/workspace-sync.ts';import {mountBrowserCopilot} from '/src/browser-copilot.ts';
      const paneWindow=monitor(1,'browser');let state={version:1,monitors:[paneWindow],selected:paneWindow.id,arc:14};
      const fixtureToken=${JSON.stringify(token)};let credential=new URL(location.href).searchParams.has('locked')?'':fixtureToken;
      const nativeFetch=window.fetch.bind(window);let holdNext=false,releaseHeld;
      // Delay delivery of an actual authenticated service response, without
      // substituting a response body. Deliberately ignore abort after fetch has
      // completed to exercise the UI's generation fence independently of abort.
      window.fetch=async(...args)=>{const response=await nativeFetch(...args);if(holdNext&&String(args[0])==='/api/browser-copilot'&&JSON.parse(args[1].body).action==='capability'){holdNext=false;document.querySelector('#held').textContent='Capability response held';await new Promise(resolve=>releaseHeld=resolve);}return response;};
      connectWorkspace(()=>state,s=>state=s,()=>credential,()=>{});const pane=mountBrowserCopilot(document.querySelector('#host'),()=>credential);
      const announce=()=>window.dispatchEvent(new Event('orbit-host-connected'));
      document.querySelector('#unlock').onclick=()=>{credential=fixtureToken;announce();};document.querySelector('#lock').onclick=()=>{credential='';announce();};document.querySelector('#reconnect').onclick=announce;
      document.querySelector('#hold').onclick=()=>{holdNext=true;document.querySelector('#held').textContent='';};document.querySelector('#release').onclick=()=>{releaseHeld?.();releaseHeld=undefined;document.querySelector('#held').textContent='Response released';};
      document.querySelector('#dispose').onclick=()=>{pane.dispose();window.fetch=nativeFetch;releaseHeld?.();};
      </script>`;
    res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});return res.end(await vite.transformIndexHtml('/',html));
  }
  vite.middlewares(req,res,()=>{res.writeHead(404);res.end();});
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
workspace=createWorkspaceService({root,token,port,devOrigins:[],reply});
copilot=createBrowserCopilot({root,workspaceRead:workspace.read,driver:createPlaywrightDriver({executablePath:process.env.ORBIT_BROWSER_EXECUTABLE,allowedOrigins:[`http://127.0.0.1:${port}`]})});
handler=createBrowserCopilotHandler({token,port,reply,copilot});
console.log(JSON.stringify({url:`http://127.0.0.1:${port}`,root,token}));
let closing=false;async function close(){if(closing)return;closing=true;await copilot.close();workspace.close();await vite.close();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});process.exit(0);}
process.on('SIGTERM',close);process.on('SIGINT',close);
