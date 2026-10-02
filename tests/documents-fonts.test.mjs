import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {CANVAS_FONT_IDS,CANVAS_FONT_FAMILIES,validateDocumentData,EMPTY_CANVAS} from '../contracts/documents-v1.mjs';
import {isPublishedCanvasFont,transformCanvasFontPolicy,canvasFontPolicyPlugin} from '../server/documents-canvas-assets.mjs';
test('exact OFL/MIT asset allowlist excludes old Liberation and all legacy faces',()=>{
  assert.deepEqual(CANVAS_FONT_IDS,[5,6,7,8]);
  assert.deepEqual(CANVAS_FONT_FAMILIES,['Assistant','ComicShanns','Excalifont','Lilita','Nunito','Xiaolai']);
  for(const family of CANVAS_FONT_FAMILIES)assert.equal(isPublishedCanvasFont(`${family}/font-Regular.woff2`),true);
  for(const name of ['Liberation/LiberationSans-Regular.woff2','Cascadia/CascadiaCode-Regular.woff2','Virgil/Virgil-Regular.woff2','Helvetica/font.woff2','Nunito/../../private.woff2','Excalifont/font.js'])assert.equal(isPublishedCanvasFont(name),false);
  const notices=fs.readFileSync(new URL('../docs/licenses/EXCALIDRAW_FONTS.txt',import.meta.url),'utf8');
  for(const phrase of ['SIL OPEN FONT LICENSE Version 1.1','Copyright © 2020 LXGW','Copyright (c) 2024 Kyle Beechly','Reserved Font Names "Lilita One"','Copyright 2010 The Source Sans Pro Authors'])assert.ok(notices.includes(phrase));
});
test('only four actual text families admitted, legacy imports fail before rendering/export',()=>{
  const scene=JSON.parse(EMPTY_CANVAS);
  const element={id:'text-fixture',type:'text',x:0,y:0,width:100,height:30,angle:0,version:1,seed:1,versionNonce:1,isDeleted:false,text:'Font policy',fontSize:20};
  for(const fontFamily of CANVAS_FONT_IDS)assert.equal(validateDocumentData({kind:'scene',format:'excalidraw',content:JSON.stringify({...scene,elements:[{...element,fontFamily}]})}).elements[0].fontFamily,fontFamily);
  for(const fontFamily of [1,2,3,4,9,100])assert.throws(()=>validateDocumentData({kind:'scene',format:'excalidraw',content:JSON.stringify({...scene,elements:[{...element,fontFamily}]})}),e=>e.code==='unsupported'&&e.message.includes('Excalifont (5)')&&e.message.includes('convert legacy text'));
});
test('pinned dev AND prod engine registration is removed rather than CSS-hidden',()=>{
  const root=path.resolve('node_modules/@excalidraw/excalidraw');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version,'0.18.1');
  for(const variant of ['dev','prod']) {
    let transformed=0;
    for(const file of fs.readdirSync(path.join(root,'dist',variant)).filter(n=>n.endsWith('.js'))){
      const id=path.join(root,'dist',variant,file),code=fs.readFileSync(id,'utf8'),result=transformCanvasFontPolicy(code,id);
      if(!result)continue;transformed++;
      assert.ok(result.code.includes('Symbol.for("orbit.canvas-font-policy.v1")'));
      assert.ok(result.code.includes('fallback:"same-origin"'));
      assert.ok(!result.code.includes('https://esm.sh/'));
      execFileSync(process.execPath,['--check','--input-type=module'],{input:result.code});
      assert.ok(!/\b[A-Za-z_$][\w$]*\(\s*"(?:Cascadia|Helvetica|Liberation Sans|Virgil)"\s*,\s*\.\.\./.test(result.code));
      for(const family of ['Comic Shanns','Excalifont','Lilita One','Nunito'])assert.ok(result.code.includes(`"${family}",`));
    }
    assert.equal(transformed,1,`${variant}: exactly one real engine registry module`);
  }
  assert.equal(transformCanvasFontPolicy('const note="Liberation Sans";','/src/owner.js'),null);
  assert.throws(()=>transformCanvasFontPolicy('init("Liberation Sans", ...font);',path.join(root,'dist/dev/test.js')),/fingerprint changed/);
  assert.ok(canvasFontPolicyPlugin().config().optimizeDeps.include.includes('@excalidraw/excalidraw'));
  assert.equal(canvasFontPolicyPlugin().config().optimizeDeps.esbuildOptions.plugins.length,1);
});
