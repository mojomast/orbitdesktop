import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const env=Object.fromEntries(readFileSync(new URL('.env.deploy',import.meta.url),'utf8').trim().split('\n').map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)];}));
const origin=env.ORBIT_PUBLIC_ORIGIN;
const session='orbit-'+randomUUID();
async function api(body) {
 const r=await fetch(origin+'/api/agent',{method:'POST',headers:{Origin:origin,Authorization:`Bearer ${env.ORBIT_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({session_id:session,...body})});
 const data=await r.json(); if(!r.ok) throw Error(JSON.stringify({status:r.status,...data})); return data;
}
async function turn(input) {
 const started=await api({action:'start',input}); console.log('Started:',started.run_id);
 for(let i=0;i<180;i++) {
  const r=await api({action:'status',run_id:started.run_id});
  if(r.status==='completed') {console.log('Reply:',r.output);return r.output;}
  if(['failed','cancelled','interrupted','waiting_for_approval'].includes(r.status)) throw Error(JSON.stringify(r));
  await new Promise(resolve=>setTimeout(resolve,1500));
 }
 await api({action:'stop',run_id:started.run_id});throw Error('Test timed out; stop requested');
}
const a=await turn('This is a harmless Orbit chat integration test. Remember the code orbit-cobalt-729 for the next turn. Reply exactly: ORBIT_CHAT_CONNECTED');
assert.equal(a.trim(),'ORBIT_CHAT_CONNECTED');
const b=await turn('What code did I ask you to remember? Reply with only that code.');assert.equal(b.trim(),'orbit-cobalt-729');
const c=await turn('Integration test: use your terminal tool to run printf ORBIT_TOOL_VERIFIED and return only its output. Do not modify any files or run any other commands.');assert.equal(c.trim(),'ORBIT_TOOL_VERIFIED');
writeFileSync(new URL('live-agent-verification.json',import.meta.url),JSON.stringify({session,first:a,memory:b,tool:c,passed:true},null,2));
console.log('LIVE HERMES CHAT, SESSION MEMORY, AND TOOL EXECUTION: PASSED');
