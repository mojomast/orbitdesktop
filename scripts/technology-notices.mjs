import fs from 'node:fs/promises';
import path from 'node:path';

/** Preserve installed dependency notices alongside the distributable client. */
export function technologyNotices(root) {
  return {
    name: 'orbit-technology-notices',
    async generateBundle() {
      const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
      const sections = [await fs.readFile(path.join(root, 'docs/THIRD_PARTY.md'), 'utf8')];
      const seen = new Set();
      for (const [relative, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
        if (!relative.startsWith('node_modules/') || relative.split('/').includes('..') || entry.dev) continue;
        const folder = path.join(root, relative);
        let names;
        try { names = await fs.readdir(folder); }
        catch (error) { if (error.code === 'ENOENT' && entry.optional) continue; throw error; }
        const pkg = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
        const identity = `${pkg.name}@${pkg.version}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        const notices = [];
        for (const name of names.sort()) {
          if (!/^(?:licen[cs]e|notice|copying|copyright|thirdpartynotices)(?:[._-].*)?$/i.test(name)) continue;
          const file = path.join(folder, name), stat = await fs.stat(file);
          if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
          notices.push(`${name}\n${await fs.readFile(file, 'utf8')}`);
        }
        sections.push(`\n## ${identity}\nPackage license declaration: ${JSON.stringify(pkg.license ?? 'See upstream distribution')}\n\n${notices.join('\n\n') || 'No root notice file is present in this npm archive; see the notices and upstream references above.'}`);
      }
      sections.push(await fs.readFile(path.join(root, 'docs/licenses/EXCALIDRAW_FONTS.txt'), 'utf8'));
      this.emitFile({type:'asset',fileName:'third-party-notices.txt',source:sections.join('\n\n')});
    },
  };
}
