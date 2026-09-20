import { test } from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {LocalHostProvider} from '../server/local-host.mjs';
test('persistent host shell retains variable and PID across PTY client disconnect',async()=>{
 const pane_id=randomUUID(),provider=new LocalHostProvider();let first,second;
 const attach=()=>provider.spawn({cols:80,rows:24,pane_id});
 const wait=(p,command,marker)=>new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>{sub.dispose();reject(Error('Timed out: '+out));},8000);const sub=p.onData(s=>{out+=s;if(out.includes(marker)){clearTimeout(timer);sub.dispose();resolve(out);}});setTimeout(()=>p.write(command+'\r'),250);});
 try{first=attach();await wait(first,"export ORBIT_PERSIST_TEST=retained; printf 'READY_%s\\n' shell",'READY_shell');first.kill();await new Promise(r=>setTimeout(r,300));second=attach();const out=await wait(second,"printf 'VALUE_%s\\n' \"$ORBIT_PERSIST_TEST\"",'VALUE_retained');assert.ok(out.includes('VALUE_retained'));}
 finally{first?.kill();second?.kill();try{execFileSync('/usr/bin/tmux',['-L','orbit-persistent','kill-session','-t','pane-'+pane_id]);}catch{}}
});
