import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import {WebSocketServer,WebSocket} from 'ws';
import {isPixel,validMobileOrigin} from './mobile-security.mjs';
const origin='https://kimi.tailec998.ts.net:4367';
const workspace='eed047a8-e519-495e-a7ca-1c8c150a6ef4';
const port=Number(process.env.MOBILE_UPSTREAM_PORT || 4335);
const token=process.env.ORBIT_TOKEN;
if(!token)throw Error('Missing upstream credential');
const tlsRoot=new URL('../.runtime/mobile/',import.meta.url);
const accepted=new Map();
async function authorized(req){
  if(!validMobileOrigin(req,origin))return false;
  const ip=req.socket.remoteAddress;
  if((accepted.get(ip)||0)>Date.now())return true;
  if(!await isPixel(ip))return false;
  accepted.set(ip,Date.now()+10000);return true;
}
function reply(res,status,data){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'});res.end(JSON.stringify(data));}
async function body(req){let s='';for await(const part of req){s+=part;if(s.length>1048576)throw Error('Request too large');}return JSON.parse(s);}
function headers(req){return {'host':`127.0.0.1:${port}`,'origin':`http://127.0.0.1:${port}`,'authorization':`Bearer ${token}`,...(req.headers['content-type']?{'content-type':req.headers['content-type']}:{})};}
const server=https.createServer({cert:fs.readFileSync(new URL('cert.pem',tlsRoot)),key:fs.readFileSync(new URL('key.pem',tlsRoot))},async(req,res)=>{
  try{
    if(!await authorized(req))return reply(res,403,{error:'Only the authorized Pixel 8 Pro Tailscale device can access Orbit Pocket.'});
    let url=new URL(req.url,origin);
    if(url.pathname==='/api/mobile'&&req.method==='GET')return reply(res,200,{workspace_id:workspace});
    let payload;
    if(url.pathname.startsWith('/api/')){
      if(req.method!=='POST'||req.headers.origin!==origin)return reply(res,403,{error:'Same-origin POST required'});
      payload=await body(req);
      if(payload.workspace_id!==workspace)return reply(res,403,{error:'Workspace rejected'});
      if(url.pathname==='/api/workspace'){
        if(payload.action!=='read')return reply(res,403,{error:'Mobile layout is read-only'});
        delete payload.observed_revision; // The phone is not acknowledgement of the desktop display.
      }else if(url.pathname==='/api/agent'){
        if(!['shared_chat','start','status','stop','steer','approval','activity','events','capabilities','shared_browser_connection'].includes(payload.action))return reply(res,403,{error:'Action unavailable on mobile'});
        if(payload.action==='shared_chat'){delete payload.initial;delete payload.replace;}
        if(!payload.pane_id)return reply(res,400,{error:'A linked pane is required'});
      }else return reply(res,404,{error:'Not found'});
    }else if(!['GET','HEAD'].includes(req.method))return reply(res,405,{error:'Method rejected'});
    if(url.pathname==='/')url.pathname='/mobile.html';
    const data=payload?JSON.stringify(payload):null;
    const upstream=http.request({hostname:'127.0.0.1',port,path:url.pathname+url.search,method:req.method,headers:{...headers(req),...(data?{'content-length':Buffer.byteLength(data)}:{})}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
    upstream.on('error',()=>{if(!res.headersSent)reply(res,502,{error:'Desktop unavailable'});else res.end();});
    res.on('close',()=>upstream.destroy());if(data)upstream.end(data);else upstream.end();
  }catch{if(!res.headersSent)reply(res,400,{error:'Invalid request'});}
});
const wss=new WebSocketServer({noServer:true,maxPayload:32768});
server.on('upgrade',async(req,socket,head)=>{
  if(req.url!=='/api/terminal'||req.headers.origin!==origin||!await authorized(req)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  wss.handleUpgrade(req,socket,head,client=>{
    let upstream,authed=false;const timeout=setTimeout(()=>client.close(1008,'Authentication timeout'),5000);
    client.on('message',async(raw)=>{
      try{
        const message=JSON.parse(raw.toString());
        if(!authed){
          if(message.type!=='auth'||!/^[a-f0-9-]{36}$/.test(message.pane_id||''))return client.close(1008);
          const record=JSON.parse(fs.readFileSync(new URL(`../.runtime/workspaces/${workspace}.json`,import.meta.url),'utf8'));
          const contains=l=>l.type==='pane'?l.pane.id===message.pane_id&&l.pane.kind==='terminal':contains(l.first)||contains(l.second);
          if(!record.state.monitors.some(m=>contains(m.layout)))return client.close(1008);
          authed=true;clearTimeout(timeout);message.token=token;
          upstream=new WebSocket(`ws://127.0.0.1:${port}/api/terminal`,{headers:{Origin:`http://127.0.0.1:${port}`}});
          upstream.on('open',()=>upstream.send(JSON.stringify(message)));
          upstream.on('message',data=>{if(client.readyState===WebSocket.OPEN)client.send(data.toString());});
          upstream.on('ping',()=>{if(client.readyState===WebSocket.OPEN)client.ping();});
          upstream.on('close',()=>client.close());upstream.on('error',()=>client.close(1011));
        }else if(message.type!=='auth'&&upstream?.readyState===WebSocket.OPEN)upstream.send(raw.toString());
      }catch{client.close(1008);}
    });
    client.on('close',()=>{clearTimeout(timeout);upstream?.close();});client.on('error',()=>upstream?.close());
  });
});
server.listen(4367,'100.125.104.79',()=>console.log('Orbit Pocket listening on tailnet TLS :4367; Pixel-only device authentication'));
