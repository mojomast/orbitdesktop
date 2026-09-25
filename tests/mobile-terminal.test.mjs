import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {LocalHostProvider} from '../server/local-host.mjs';
test('desktop and phone clients simultaneously share one tmux shell and output',async()=>{
 const id=randomUUID(),provider=new LocalHostProvider();let a,b;
 const seen=(pty,marker)=>new Promise((resolve,reject)=>{let text='';const timeout=setTimeout(()=>{sub.dispose();reject(Error('Shared output timeout'));},8000);const sub=pty.onData(s=>{text+=s;if(text.includes(marker)){clearTimeout(timeout);sub.dispose();resolve(true);}});});
 try{
  a=provider.spawn({cols:100,rows:30,pane_id:id});b=provider.spawn({cols:40,rows:30,pane_id:id});
  await new Promise(r=>setTimeout(r,350));
  const first=seen(a,'MOBILE_SHARED_ready'),second=seen(b,'MOBILE_SHARED_ready');
  a.write("export ORBIT_PHONE_TEST=ready; printf 'MOBILE_SHARED_%s\\n' \"$ORBIT_PHONE_TEST\"\r");
  assert.deepEqual(await Promise.all([first,second]),[true,true]);
  const phone=seen(b,'PHONE_SEES_ready'),desktop=seen(a,'PHONE_SEES_ready');
  b.write("printf 'PHONE_SEES_%s\\n' \"$ORBIT_PHONE_TEST\"\r");
  assert.deepEqual(await Promise.all([phone,desktop]),[true,true]);
 }finally{a?.kill();b?.kill();try{execFileSync('/usr/bin/tmux',['-L','orbit-persistent','kill-session','-t','pane-'+id]);}catch{}}
});
