import test from 'node:test';
import assert from 'node:assert/strict';
import {initial,monitor} from '../src/model.ts';
import {captureLayout,applyLayout} from '../src/layout-presets.ts';
test('named layouts restore 2D/3D geometry and fonts without replacing apps or panes',()=>{
 const s=initial();s.view='spatial';s.monitors[0].spatialFontSize=60;
 s.spatialCamera={x:1,y:2,z:3,azimuth:0,elevation:0,distance:12};
 const saved=captureLayout(s,'Scene','scene',[s.monitors[0].id]);
 const newer=structuredClone(s);newer.view='windows';newer.monitors[0].spatialFontSize=20;
 newer.monitors[0].name='New name';newer.monitors[0].layout.pane.url='https://example.com';
 const added=monitor(4,'browser');newer.monitors.push(added);newer.monitors.splice(1,1);
 const restored=applyLayout(newer,saved);
 assert.equal(restored.view,'spatial');assert.equal(restored.monitors[0].spatialFontSize,60);
 assert.equal(restored.monitors[0].name,'New name');assert.deepEqual(restored.monitors[0].layout,newer.monitors[0].layout);
 assert.deepEqual(restored.monitors.at(-1),added);assert.equal(restored.monitors.length,newer.monitors.length);
 assert.deepEqual(restored.spatialCamera,s.spatialCamera);assert.equal(newer.view,'windows');
});
test('invalid saved geometry is rejected without changing current state',()=>{
 const state=initial();const before=JSON.stringify(state);const saved=captureLayout(state,'Desk','desk');
 saved.windows[0].fontSize=900;assert.throws(()=>applyLayout(state,saved));assert.equal(JSON.stringify(state),before);
});
