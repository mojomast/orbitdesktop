import {test} from 'node:test';
import assert from 'node:assert/strict';
import {themes,themePatch} from '../src/themes.ts';
import {themePersonality} from '../src/theme-personality.ts';
import {initial} from '../src/model.ts';
import {applyOperation} from '../src/workspace-ops.ts';
test('all theme personalities validate and preserve window identities',()=>{
 const before=initial();const styles=new Set();
 for(const preset of themes){const patch=themePatch(preset.name);const after=applyOperation(before,{action:'patch_appearance',patch});assert.deepEqual(after.monitors,before.monitors);styles.add(themePersonality(after.appearance));}
 assert.equal(styles.size,themes.length);
});
test('personality requires matching family; custom backgrounds fall back safely',()=>{
 assert.equal(themePersonality({theme:'classic',background:'#102c40'}),'classic');
 assert.equal(themePersonality({theme:'midnight',background:'#102C40'}),'aurora');
 assert.equal(themePersonality({theme:'paper',background:'#112233'}),'paper');
 assert.equal(themePersonality(undefined),'');
});
