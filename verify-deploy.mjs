import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const env=Object.fromEntries(readFileSync(new URL('.env.deploy',import.meta.url),'utf8').trim().split('\n').map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)];}));
const origin=env.ORBIT_PUBLIC_ORIGIN;
assert.equal((await fetch(origin)).status,200);
console.log('HTTPS frontend: 200');
console.log('Health:',await (await fetch(origin+'/api/health')).text());
for(const [o,t,status] of [[origin,env.ORBIT_TOKEN,200],[origin,'wrong',401],['https://evil.example',env.ORBIT_TOKEN,403]]){
 const r=await fetch(origin+'/api/auth',{method:'POST',headers:{Origin:o,'Content-Type':'application/json'},body:JSON.stringify({token:t})});assert.equal(r.status,status);
}
console.log('Authentication and foreign-origin rejection: passed');
await new Promise((resolve,reject)=>{
 const ws=new WebSocket(origin.replace('https:','wss:')+'/api/terminal',{origin});
 const timeout=setTimeout(()=>{ws.terminate();reject(Error('PTY timeout'));},15000);
 let output='';
 ws.on('open',()=>ws.send(JSON.stringify({type:'auth',token:env.ORBIT_TOKEN,cols:80,rows:24})));
 ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='ready'){assert.equal(m.user,'mojo'); assert.equal(m.cwd,'/home/mojo'); console.log(`Host shell identity: ${m.user}@${m.host} cwd=${m.cwd}`); ws.send(JSON.stringify({type:'input',data:"printf 'ORBIT_%s_OK\\n' VERIFIED; id -un; pwd; test ! -f /.dockerenv && printf 'REAL_HOST_OK\\n'\r"}));}if(m.type==='data'){output+=m.data;ws.send(JSON.stringify({type:'ack',length:m.data.length}));if(output.includes('ORBIT_VERIFIED_OK')&&output.includes('/home/mojo')&&output.includes('\r\nREAL_HOST_OK\r\n')){console.log('Live WSS shell command: passed');clearTimeout(timeout);ws.close();resolve();}}});
 ws.on('error',reject);
});
