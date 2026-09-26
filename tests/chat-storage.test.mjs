import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveChat, validChat, transcript, chatBindingKey } from '../src/chat-storage.ts';
import { randomUUID } from 'node:crypto';
const chat = text => ({session:`orbit-${randomUUID()}`,messages:[{role:'user',text}]});
test('history retains ten unique completed conversations only',()=>{
 let history=[];for(let i=0;i<12;i++) history=archiveChat(history,chat(String(i)));
 assert.equal(history.length,10);assert.equal(history[0].messages[0].text,'11');
 assert.equal(archiveChat(history,history[0]).length,10);
 assert.deepEqual(archiveChat(history,{...chat('active'),run:'run_active'}),history);
});
test('invalid stored chats are rejected and exports remain literal plain text',()=>{
 const s=chat('<script>not HTML</script>');assert.equal(validChat(s),true);
 assert.equal(validChat({...s,session:'../foreign-session'}),false);
 assert.equal(validChat({...s,messages:[{role:'system',text:'bad'}]}),false);
 assert.ok(transcript(s).includes('YOU\n<script>not HTML</script>'));
});
test('server session IDs may contain colons without admitting paths',()=>{
 assert.equal(validChat({...chat('hi'),session:'conversation:one_2'}),true);
 assert.equal(validChat({...chat('hi'),session:'conversation/one'}),false);
});

test('archive identity is profile plus session, with legacy default profile',()=>{
 const session='orbit-12345678-1234-1234-1234-123456789abc';
 const first={session,profile_id:'alpha',messages:[{role:'user',text:'a'}]};
 const second={session,profile_id:'beta',messages:[{role:'user',text:'b'}]};
 let history=archiveChat([],first);history=archiveChat(history,second);
 assert.equal(history.length,2);
 assert.equal(chatBindingKey({session}),chatBindingKey({session,profile_id:'default'}));
 assert.equal(archiveChat(history,{...first,messages:[{role:'user',text:'updated'}]})[1].messages[0].text,'b');
});

test('session/profile identities reject path and control characters, oversized values and invalid revisions',()=>{
 const good=chat('ok');
 for(const session of ['../etc/passwd','a/b','a\\b','bad\nname','', 'x'.repeat(129)]) assert.equal(validChat({...good,session}),false,session);
 for(const profile_id of ['../other','a/b','bad\0id','x'.repeat(129)]) assert.equal(validChat({...good,profile_id}),false,profile_id);
 for(const binding_revision of [-1,1.5,Number.MAX_SAFE_INTEGER+1]) assert.equal(validChat({...good,binding_revision}),false);
 assert.equal(validChat({...good,session:'legacy-orbit-12345678-1234-1234-1234-123456789abc',binding_revision:0}),true);
});
