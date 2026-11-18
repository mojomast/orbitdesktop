// Inputs outside src/ needed by a copied host UI. Follow only the static JS
// dependencies of the reviewed projection. Never discover apps from a runtime,
// copy the whole app, execute these modules, or resolve imports outside it.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';

export function projectionInputs(source) {
  const root = fs.realpathSync(source);
  // Some comparison fixtures build historical sources from before Hive.
  const host = path.join(root, 'src/hive-host.ts');
  if (!fs.existsSync(host)) return [];
  const app = 'apps/rizzstack-hive';
  const required = new Set(JSON.parse(fs.readFileSync(path.join(root, 'scripts/portable-product.json'), 'utf8')).required);
  const files = new Set();
  function visit(name) {
    const file = `${app}/${name}`;
    if (files.has(file)) return;
    const absolute = path.join(root, file);
    if (!/^[a-z0-9-]+\.js$/.test(name) || !required.has(file) || fs.realpathSync(absolute) !== absolute) {
      throw Error(`Unreviewed projection input: ${file}`);
    }
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.nlink !== 1) throw Error(`Not a regular release file: ${file}`);
    files.add(file);
    for (const {fileName} of ts.preProcessFile(fs.readFileSync(absolute, 'utf8'), true, true).importedFiles) {
      if (!fileName.startsWith('./')) throw Error(`Non-local projection import: ${fileName}`);
      visit(fileName.slice(2));
    }
  }
  // Keep the scratch layout aligned with the real literal host imports. Do
  // not follow the shell's other (src/ or npm) imports into the fixture.
  const prefix = `../${app}/`;
  for (const {fileName} of ts.preProcessFile(fs.readFileSync(host, 'utf8'), true, true).importedFiles) {
    if (fileName.startsWith(prefix)) visit(fileName.slice(prefix.length));
  }
  return [...files].sort();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  console.log(JSON.stringify(projectionInputs(process.argv[2])));
}
