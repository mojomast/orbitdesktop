import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { createLocalWorkersRoute } from '../../server/local-workers-route.mjs';

// Fresh, explicitly bound fixture; only the two UI assets and the registered
// worker module. Does not load the host workspace, launcher or tmux config.
export async function joinFixture(t,{ tls, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'orbit-worker-test-'));
  const owner = randomBytes(32).toString('base64url'); let handler;
  const listener = (req,res) => {
    if (['/worker-join.html','/worker-join.js'].includes(req.url) && req.method === 'GET') {
      res.writeHead(200,{ 'Content-Type':req.url.endsWith('.js') ? 'text/javascript' : 'text/html' });
      return res.end(fs.readFileSync(new URL('../../public'+req.url,import.meta.url)));
    }
    return handler.handle(req,res);
  };
  const server = tls ? https.createServer(tls,listener) : http.createServer(listener);
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    handler?.close(); fs.rmSync(dir,{ recursive:true,force:true });
  });
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  const { port } = server.address(); const origin = `${tls?'https':'http'}://127.0.0.1:${port}`;
  handler = createLocalWorkersRoute({ runtimeRoot:dir,port,env:{ ORBIT_TOKEN:owner,ORBIT_WORKER_JOIN_ONLY:'1',...env } });
  async function post(body,headers={},suffix='') {
    return fetch(origin + '/api/local-workers' + suffix,{ method:'POST',redirect:'error',headers:{ 'Content-Type':'application/json',...headers }, body:JSON.stringify(body) });
  }
  const auth = { Origin:origin,Authorization:`Bearer ${owner}` };
  const invite = async (scopes = ['presence']) => (await post({ op:'invite',label:'Fixture',scopes },auth)).json();
  return { owner,auth,dir,origin,post,invite };
}
