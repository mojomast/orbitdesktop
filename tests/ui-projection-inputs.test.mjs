import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {projectionInputs} from './fixtures/ui-projection-inputs.mjs';

test('a copied UI gets only the local release modules reached by static projection imports', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-inputs-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const app = 'apps/rizzstack-hive';
  const put = (name, content) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, content);
  };
  put('src/hive-host.ts', "import './shell'; export const load = () => import('../apps/rizzstack-hive/read.js');");
  const required = ['read.js', 'validate.js', 'guest.js'].map(name => `${app}/${name}`);
  put('scripts/portable-product.json', JSON.stringify({required}));
  put(`${app}/read.js`, "export {check} from './validate.js';");
  put(`${app}/validate.js`, 'export const check = () => true;');
  put(`${app}/guest.js`, "throw Error('never execute guest code');");
  assert.deepEqual(projectionInputs(root), required.slice(0, 2));
  put(`${app}/read.js`, "import './unlisted.js';");
  assert.throws(() => projectionInputs(root), /Unreviewed projection input/);
  put(`${app}/read.js`, "import '../private.js';");
  assert.throws(() => projectionInputs(root), /Non-local projection import/);
  put(`${app}/read.js`, "import './validate.js';");
  fs.unlinkSync(path.join(root, app, 'validate.js'));
  fs.symlinkSync('guest.js', path.join(root, app, 'validate.js'));
  assert.throws(() => projectionInputs(root), /Unreviewed projection input/);
  fs.unlinkSync(path.join(root, app, 'validate.js'));
  fs.linkSync(path.join(root, app, 'guest.js'), path.join(root, app, 'validate.js'));
  assert.throws(() => projectionInputs(root), /Not a regular release file/);
});
