import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {themePatch} from '../src/themes.ts';
import {themePersonality} from '../src/theme-personality.ts';
test('Nous preset resolves independently with self-contained wallpaper and local assets',()=>{
 const patch=themePatch('Nous Atelier');
 assert.equal(themePersonality(patch),'nous');
 assert.equal(patch.wallpaper,'/wallpapers/nous.svg');
 assert.equal(themePersonality({...patch,theme:'paper'}),'paper');
 const wallpaper=readFileSync(new URL('../public/wallpapers/nous.svg',import.meta.url),'utf8');
 assert.match(wallpaper,/data:image\/svg\+xml;base64,/);
 assert.doesNotMatch(wallpaper,/(?:href|src)="https?:/);
 for(const role of ['folder','chat','terminal','browser','document','grid','image','key','app']) assert.ok(existsSync(new URL(`../public/icons/nous/${role}.svg`,import.meta.url)));
 const css=readFileSync(new URL('../src/theme-nous.css',import.meta.url),'utf8');
 assert.match(css,/prefers-reduced-motion:reduce/);
 assert.match(css,/counter\(folio,decimal-leading-zero\)/);
 assert.match(css,/counter\(entry,decimal-leading-zero\)/);
});
