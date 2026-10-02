import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
async function port(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p;}
function proxyGet(url,host){return new Promise((resolve,reject)=>{http.get(url,{headers:{Host:host}},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,headers:res.headers}));}).on('error',reject);});}
test('public MCP proxy origin can use a loopback listener with exact Host and parent CSP',async t=>{
  const scratch=await fs.mkdtemp('/tmp/opencode/orbit-mcp-proxy-');
  const hostPort=await port(),sandboxPort=await port(),origin=`http://127.0.0.1:${hostPort}`;
  const sandboxOrigin='https://sandbox.example:8804',token='synthetic-proxy-token-not-a-secret-12345';
  const child=spawn(process.execPath,['--experimental-strip-types',path.join(root,'server/index.mjs')],{cwd:root,env:{PATH:process.env.PATH,HOME:scratch,PORT:String(hostPort),ORBIT_RUNTIME_DIR:path.join(scratch,'runtime'),ORBIT_CWD:scratch,ORBIT_TOKEN:token,ORBIT_MCP_APPS:'1',ORBIT_MCP_APPS_SANDBOX_PORT:String(sandboxPort),ORBIT_MCP_APPS_SANDBOX_ORIGIN:sandboxOrigin,ORBIT_PUBLIC_ORIGIN:'https://host.example:8803'},stdio:'ignore'});
  const exited=once(child,'exit');
  t.after(async()=>{child.kill('SIGTERM');await exited;await fs.rm(scratch,{recursive:true,force:true});});
  let healthy=false;
  for(let i=0;i<150;i++){try{healthy=(await fetch(origin+'/api/health')).ok;}catch{}if(healthy)break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(healthy,'disposable server starts with both proxy variables');
  const capabilities=await fetch(origin+'/api/technology-capabilities',{method:'POST',headers:{Origin:origin,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({action:'capabilities'})});
  assert.equal((await capabilities.json()).mcp_apps,true);
  const proxy=`http://127.0.0.1:${sandboxPort}`;
  for(const host of [`127.0.0.1:${sandboxPort}`,'sandbox.example:8804']){
    const response=await proxyGet(proxy+'/mcp-apps/proxy',host);
    assert.equal(response.status,200);assert.match(response.headers['content-security-policy'],/frame-ancestors .*https:\/\/host.example:8803/);
    assert.equal((await proxyGet(proxy+'/api/health',host)).status,404);
  }
  assert.equal((await proxyGet(proxy+'/mcp-apps/proxy','host.example:8803')).status,403);
  assert.equal((await fetch(proxy+'/mcp-apps/proxy',{method:'POST'})).status,404);
});
