import assert from 'node:assert/strict';
import {defaults,ranges,presets,validateRecipe,variation,brief} from '../apps/cocs-graphics-lab/recipe.mjs';
for(const p of Object.values(presets))assert.deepEqual(validateRecipe({...defaults,...p}),{...defaults,...p});
for(let i=0;i<300;i++){const r=variation(defaults,i);for(const [k,[min,max]] of Object.entries(ranges))assert.ok(r[k]>=min&&r[k]<=max);assert.deepEqual(r,variation(defaults,i));}
for(const v of [null,[],{bloom:Infinity},{fov:0},{tint:'bad'},{warp:'0.1'}])assert.throws(()=>validateRecipe(v));
const text=brief({...defaults,...presets['Shield frost']},{situation:'pickup',trigger:'powerup:shield',duration:10,fadeIn:.2,fadeOut:.7,prompt:'Keep HUD legible',scene:'studio'});
assert.ok(text.includes('Fragment shader:'));assert.ok(text.includes('powerup:shield'));assert.ok(text.includes('death, respawn'));assert.ok(text.length<8000);
console.log('PASS presets, 300 reproducible bounded variations, invalid recipes, lifecycle/shader brief');
