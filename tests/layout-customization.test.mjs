import {test} from 'node:test';import assert from 'node:assert/strict';
import {initial,leaves} from '../src/model.ts';import {applyOperation as apply} from '../src/workspace-ops.ts';
test('split resize rotate and swap retain pane identities and leave input unchanged',()=>{
 let s=initial();const id=s.monitors[0].id,pid=leaves(s.monitors[0].layout)[0].id;
 s=apply(s,{action:'split_pane',window_id:id,pane_id:pid,kind:'browser'});const before=leaves(s.monitors[0].layout);
 const next=apply(s,{action:'update_split',window_id:id,path:[],ratio:0.7,axis:'column',swap:true});assert.deepEqual(leaves(next.monitors[0].layout),[before[1],before[0]]);assert.equal(next.monitors[0].layout.ratio,0.7);assert.equal(s.monitors[0].layout.ratio,0.5);
 for(const fields of [{path:['bad']},{path:['first']},{path:[],ratio:2},{path:[],axis:'diagonal'},{path:[],swap:'yes'}])assert.throws(()=>apply(s,{action:'update_split',window_id:id,...fields}));
});
test('appearance patch preserves wallpaper and rejects unsupported styling',()=>{
 let s=apply(initial(),{action:'set_appearance',appearance:{wallpaper:'/wallpaper.svg',background:'#123456'}});
 const next=apply(s,{action:'patch_appearance',patch:{cornerRadius:18}});assert.equal(next.appearance.wallpaper,'/wallpaper.svg');assert.equal(next.appearance.cornerRadius,18);assert.equal(s.appearance.cornerRadius,undefined);
 for(const patch of [null,[],{css:'evil'},{background:'url(x)'}])assert.throws(()=>apply(s,{action:'patch_appearance',patch}));
});
