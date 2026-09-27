import test from 'node:test';
import assert from 'node:assert/strict';
import {applyPatch} from 'diff';
import {calculateDiff} from '../src/candidate-diff-engine.ts';

const file=(old_text,new_text)=>({path:'folder/example.txt',old_hash:old_text===null?null:'old',new_hash:new_text===null?null:'new',old_mode:null,new_mode:null,text_available:true,old_text,new_text});

for(const [label,before,after] of [
  ['empty files','',''],['addition',null,'new\n'],['deletion','old\n',null],
  ['EOF without newline','hello\n','hello'],['CRLF versus LF','a\r\nb\r\n','a\nb\n'],
  ['unicode','café 👩🏽‍💻\n','café 🛰️\n'],['mixed edits','one\ntwo\nthree\nfour\n','one\nTWO\nthree\nfive\n']
]) test(`exact patch: ${label}`,()=>{
  const result=calculateDiff(file(before,after));
  assert.equal(applyPatch(before??'',result.raw),after??'');
  assert.equal(result.rows.filter(row=>row.kind==='context').length===result.rows.length, (before??'')===(after??''));
  for(const hunk of result.hunks){
    assert.ok(hunk.start<hunk.end);
    assert.ok(result.rows.slice(hunk.start,hunk.end).every(row=>row.kind!=='context'));
  }
});

test('aligned line numbers, paired emphasis and contiguous changed blocks',()=>{
  const result=calculateDiff(file('first\nvalue = 1\nthird\n','first\nvalue = 2\nthird\nextra\n'));
  assert.deepEqual(result.rows.map(row=>row.kind),['context','modify','context','add']);
  assert.deepEqual(result.hunks,[{start:1,end:2},{start:3,end:4}]);
  assert.equal(result.rows[1].old.number,2);assert.equal(result.rows[1].new.number,2);
  assert.equal(result.rows[1].old.tokens.map(token=>token.text).join(''),'value = 1');
  assert.ok(result.rows[1].new.tokens.some(token=>token.changed&&token.text==='2'));
  assert.equal(result.additions,2);assert.equal(result.deletions,1);
});

test('ignoring whitespace changes presentation only, not raw or original text',()=>{
  const input=file('a  b\r\nlast\n','a b\nlast\n');
  const strict=calculateDiff(input), ignored=calculateDiff(input,{ignoreWhitespace:true});
  assert.equal(ignored.raw,strict.raw);
  assert.equal(applyPatch(input.old_text,ignored.raw),input.new_text);
  assert.equal(ignored.rows[0].kind,'context');
  assert.equal(ignored.rows[0].old.text,'a  b\r');
  assert.equal(ignored.rows[0].new.text,'a b');
  assert.equal(strict.rows[0].kind,'modify');
});

test('bounded worst-case 5000-line files give explicit fallback, valid exact patch',()=>{
  const before=Array.from({length:5000},(_,i)=>`old-${i}`).join('\n');
  const after=Array.from({length:5000},(_,i)=>`new-${i}`).join('\n')+'\n';
  const start=Date.now(),result=calculateDiff(file(before,after));
  assert.equal(result.limited,true);
  assert.ok(result.notice);
  assert.equal(result.rows.length,10000);
  assert.equal(applyPatch(before,result.raw),after);
  assert.ok(Date.now()-start<10000);
});

test('long modified line skips expensive token highlighting without losing the line',()=>{
  const result=calculateDiff(file('x'.repeat(3000)+'\n','y'.repeat(3000)+'\n'));
  assert.equal(result.rows[0].kind,'modify');
  assert.equal(result.rows[0].old.tokens,undefined);
});

test('unchanged text and mode-only changes do not invent line changes',()=>{
  for (const content of ['', 'same\n', 'same without newline']) {
    const input={...file(content,content),old_hash:'same',new_hash:'same',old_mode:'100644',new_mode:'100755'};
    const result=calculateDiff(input);
    assert.equal(result.additions,0);assert.equal(result.deletions,0);assert.equal(result.hunks.length,0);
    assert.equal(applyPatch(content,result.raw),content);
  }
});

test('single inserted/deleted lines align with empty cells on the opposite side',()=>{
  const inserted=calculateDiff(file('a\nb\n','a\nnew\nb\n'));
  assert.deepEqual(inserted.rows.map(row=>[row.kind,row.old?.number,row.new?.number]),[['context',1,1],['add',undefined,2],['context',2,3]]);
  const removed=calculateDiff(file('a\nold\nb\n','a\nb\n'));
  assert.deepEqual(removed.rows.map(row=>[row.kind,row.old?.number,row.new?.number]),[['context',1,1],['delete',2,undefined],['context',3,2]]);
});

test('binary or unavailable source never becomes a fabricated empty raw patch',()=>{
  for (const reason of ['binary','detail_byte_bound','historical_diff_unavailable']) {
    const result=calculateDiff({...file(null,null),text_available:false,reason});
    assert.equal(result.raw,'');assert.equal(result.limited,true);assert.match(result.notice,/unavailable/);
    assert.equal(result.rows.length,0);
  }
});
