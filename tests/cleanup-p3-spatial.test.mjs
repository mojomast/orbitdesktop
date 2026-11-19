// Phase 3 (rizzstack cleanup): the spatial (3D) workspace view is cut from Orbit; the windows/docking view stays.
// AC-001: the spatial renderer files are deleted.
// AC-002: the contract drops the spatial operations; the server rejects them.
// AC-003: nothing references the spatial renderer; the word 'spatial' survives only in legacy-compat loaders (saved state keeps loading).
// AC-004: saved workspaces that still carry spatial fields load as a windows workspace (no data loss for kept fields).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateWorkspaceRequest} from '../server/workspace-contract.mjs';
import {contract} from '../contracts/workspace-v1.mjs';
import {validate, initial} from '../src/model.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const self = fileURLToPath(import.meta.url);
// Legacy compatibility: persisted workspaces, checkpoints, saved layouts, recipes and plugin settings may still carry
// spatial fields; these files accept and ignore them. Workbench and Observatory files are cut/moved by later slices.
const legacyAllowed = new Set(['src/model.ts','contracts/workspace-v1.mjs','contracts/workspace-v1.json','src/workspace-contract.generated.ts',
  'src/saved-workspace-layouts-plan.ts','src/layout-presets.ts','src/workspace-recipe-import.ts','server/workspace-arrangements.mjs','server/workspace-diff.mjs',
  'src/plugins.ts','tests/docking-renderer.test.mjs','tests/sqlite-migration.test.mjs','tests/workspace-contract.test.mjs','tests/workspace-recipe-import.test.mjs',
  'tests/workspace-arrangements.test.mjs','tests/plugin-editor.test.mjs','src/plugin-window-editor.ts']);
// Files leased to the parallel P3-TECH slice; their spatial strings go in the P3 docs/strings sweep.
const laterSlices = /^(src\/onboarding\.ts$|examples\/plugins\/orbit-showcase\/|tests\/everyday-ux\.browser\.py$|tests\/command-palette\.browser\.py$|src\/workbench-|contracts\/workbench-|tests\/workbench-|tests\/hive-|src\/hive-|server\/jev|tests\/jev|tests\/browser-jev)/;
function walk(dir, out=[]) {
  for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    if (['node_modules','.git','dist','docs','experiments','vendor','pc-launcher'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(mjs|js|ts|json|py|css|html)$/.test(entry.name) && !/^(orbit-inventory\.json|package-lock\.json|package\.json)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('AC-001 spatial renderer files are deleted', () => {
  for (const file of ['src/scene.ts','src/spatial-controls.ts','src/spatial-layout.ts','src/spatial.css','tests/browser-spatial-live.py'])
    assert.equal(fs.existsSync(path.join(root,file)), false, `${file} still exists`);
});

test('AC-002 spatial operations are not part of the workspace contract', () => {
  for (const op of ['set_spatial_camera','arrange_spatial','set_view'])
    assert.equal(Object.hasOwn(contract.operations, op), false, `${op} must not be a contract operation`);
  for (const op of [{op:'set_view',view:'spatial'},{op:'set_spatial_camera',camera:{x:0,y:0,z:5,azimuth:0,elevation:0,distance:5}}])
    assert.throws(() => validateWorkspaceRequest({action:'apply', workspace_id:'w', base_revision:0, action_id:'a', operations:[op]}), /does not match/);
  for (const keep of ['arrange_windows','update_window','select']) assert.ok(Object.hasOwn(contract.operations, keep), `${keep} must stay`);
});

test('AC-003 nothing references the spatial view outside legacy load', () => {
  const hits = [];
  for (const file of walk(root)) {
    if (file === self || /tests\/cleanup-[^/]*\.test\.mjs$/.test(file)) continue;
    const rel = path.relative(root,file);
    if (laterSlices.test(rel)) continue;
    const text = fs.readFileSync(file,'utf8');
    for (const re of [/DesktopScene|CSS3DRenderer|from ['"]three|installSpatialControls|tileSpatial/, /['"]\.\/(scene|spatial-controls|spatial-layout)(\.ts)?['"]|spatial\.css/])
      if (re.test(text)) hits.push(`${rel}: ${re}`);
    if (!legacyAllowed.has(rel) && /spatial/i.test(text)) hits.push(`${rel}: spatial`);
  }
  assert.deepEqual(hits, []);
  const main = fs.readFileSync(path.join(root,'src/main.ts'),'utf8');
  assert.ok(!/spatial|sceneButton|Spatial view/i.test(main), 'main.ts must not offer the spatial view');
  assert.ok(!/Spatial desktop/i.test(fs.readFileSync(path.join(root,'index.html'),'utf8')), 'index.html title must not say Spatial');
});

test('AC-004 saved workspaces with spatial fields load as windows', () => {
  const saved = initial();
  saved.view = 'spatial';
  saved.spatialCamera = {x:0,y:0,z:5,azimuth:0,elevation:0,distance:5};
  saved.monitors[0].spatial = {x:0,y:0,z:0,width:2,height:1.2,yaw:0,pitch:0,resolution:1920};
  saved.monitors[0].spatialFontSize = 18;
  saved.monitors[0].name = 'Kept name';
  const loaded = validate(JSON.parse(JSON.stringify(saved)));
  assert.notEqual(loaded.view, 'spatial');
  assert.equal(Object.hasOwn(loaded,'spatialCamera'), false);
  assert.equal(Object.hasOwn(loaded.monitors[0],'spatial'), false);
  assert.equal(Object.hasOwn(loaded.monitors[0],'spatialFontSize'), false);
  assert.equal(loaded.monitors[0].name, 'Kept name');
  assert.deepEqual(loaded.monitors[0].layout, saved.monitors[0].layout);
  assert.equal(loaded.selected, saved.selected);
  assert.throws(() => validate({...saved, view:'bogus'}), /view/i);
});
