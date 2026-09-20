import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveChat, validChat, transcript } from '../src/chat-storage.ts';
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
 assert.equal(validChat({...s,session:'foreign-session'}),false);
 assert.equal(validChat({...s,messages:[{role:'system',text:'bad'}]}),false);
 assert.ok(transcript(s).includes('YOU\n<script>not HTML</script>'));
});
