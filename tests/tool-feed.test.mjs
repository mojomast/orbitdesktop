import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeToolEvent} from '../src/tool-feed.ts';
test('tool feed allowlists metadata and strips arguments, previews, tokens and results',()=>{
 const safe=sanitizeToolEvent({event:'tool.completed',tool:'terminal',timestamp:123,duration:1.5,error:true,preview:'SECRET',arguments:'SECRET',token:'SECRET',result:'SECRET'});
 assert.deepEqual(safe,{event:'tool.completed',tool:'terminal',timestamp:123,duration:1.5,error:true});
 assert.equal(sanitizeToolEvent({event:'reasoning.available',tool:'terminal'}),null);
 assert.equal(sanitizeToolEvent({event:'tool.started',tool:'<script>secret</script>'}),null);
 assert.equal(sanitizeToolEvent(null),null);
});
test('tool feed represents starts and failures without invalid timing values',()=>{
 const start=sanitizeToolEvent({event:'tool.started',tool:'read_file',timestamp:NaN,duration:Infinity});
 assert.ok(Number.isFinite(start.timestamp));assert.equal(start.duration,undefined);assert.equal(start.error,false);
 assert.equal(sanitizeToolEvent({event:'tool.failed',tool:'terminal'}).error,true);
});
