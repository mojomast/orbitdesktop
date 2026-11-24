// check-kits: sniper + heavy segmented enemy kits (baba_booey, t_ffa2e601eaff4a36).
// Kits are cut but not registered in enemy-rigs.js yet; this verifies the parts, the
// paste-ready KIT.md tables, that MANIFEST.md still generates the live enemy-rigs.js, and
// that the real rig.js draws both kits (preview harness) with no errors.
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const GAME = new URL('../pizza-panic/', import.meta.url).pathname, DEV = new URL('./', import.meta.url).pathname;
const PY = '/workspace/pizza-victory/venv/bin/python';
let pass = 0, fail = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); c ? pass++ : fail++; };
const PARTS = ['head', 'torso', 'uarm', 'farm', 'thigh', 'shin', 'weapon'];
const ROW = /^\|\s*(\w+)\s*\|\s*([\w.]+)\s*\|\s*(\d+)x(\d+)\s*\|\s*(\d+),(\d+)\s*\|\s*([\w-]+)\s*\|\s*(?:(\d+),(\d+)|-)\s*\|/;
const HEAD = /^##\s+(\w+)\s+\((.+)\)/;
// pixel probe via python/PIL: [w,h, alpha at points..., magenta-ish opaque px count]
const probe = (file, pts) => JSON.parse(execFileSync(PY, ['-c', `
import sys,json; from PIL import Image
im=Image.open(sys.argv[1]).convert('RGBA'); w,h=im.size; px=im.load(); pts=json.loads(sys.argv[2])
def near(x,y,r=3): return max((px[i,j][3] for i in range(max(0,x-r),min(w,x+r+1)) for j in range(max(0,y-r),min(h,y+r+1))),default=0)
mag=sum(1 for y in range(h) for x in range(w) if px[x,y][3]>128 and px[x,y][0]>180 and px[x,y][2]>120 and px[x,y][1]<70)
red=sum(1 for y in range(h) for x in range(w) if px[x,y][3]>128 and px[x,y][0]>170 and px[x,y][1]<60 and px[x,y][2]<80)
print(json.dumps([w,h,[near(x,y) for x,y in pts],mag,red]))`, file, JSON.stringify(pts)]).toString());
for (const kind of ['sniper', 'heavy']) {
  const dir = path.join(GAME, 'assets/enemies', kind);
  const md = fs.existsSync(path.join(dir, 'KIT.md')) ? fs.readFileSync(path.join(dir, 'KIT.md'), 'utf8').split('\n') : [];
  const h = md.map(l => l.match(HEAD)).find(Boolean);
  ok(h && h[1] === kind, `${kind}: KIT.md has a generator-parseable "## ${kind} (...)" heading`);
  ok(md.some(l => /Mov[^:]*:/.test(l)) && md.some(l => /Behavior:/.test(l)), `${kind}: KIT.md carries Moves + Behavior lines for the follow-up wiring`);
  const rows = Object.fromEntries(md.map(l => l.match(ROW)).filter(Boolean).filter(r => r[1] !== 'part').map(r => [r[1], r]));
  ok(PARTS.every(p => rows[p]), `${kind}: table rows for ${PARTS.join('/')}`);
  const kit = JSON.parse(fs.readFileSync(path.join(dir, 'kit.json'), 'utf8'));
  let bytes = 0, sizeOk = true, pivOk = true, attOk = true, mag = 0, nameOk = true; const bad = [];
  for (const p of PARTS) {
    const r = rows[p]; if (!r) continue; const f = path.join(dir, r[2]);
    if (r[2] !== `${kind}_${p}.png` || !fs.existsSync(f)) { nameOk = false; continue; }
    bytes += fs.statSync(f).size;
    const parent = r[7] !== '-' ? rows[r[7]] : null;
    const [w, hh, [aPiv], m, red] = probe(f, [[+r[5], +r[6]]]);
    if (w !== +r[3] || hh !== +r[4]) { sizeOk = false; bad.push(`${p} size ${w}x${hh}`); }
    if (aPiv < 40) { pivOk = false; bad.push(`${p} pivot alpha ${aPiv}`); }
    if (parent) { const [, , [aAtt]] = probe(path.join(dir, parent[2]), [[+r[8], +r[9]]]); if (aAtt < 40) { attOk = false; bad.push(`${p} attach on ${r[7]} alpha ${aAtt}`); } }
    mag += m;
    if (kind === 'sniper' && p === 'weapon') ok(red < 60, `sniper: rifle laser line removed (${red} bright-red px left, scope glints only)`);
    const k = kit[p]; if (!k || k.w !== +r[3] || k.px !== +r[5] || k.parent !== (r[7] === '-' ? null : r[7]) && !(r[7] === '-' && !k.parent)) bad.push(`${p} kit.json mismatch`);
  }
  ok(nameOk, `${kind}: all 7 part PNGs exist as ${kind}_<part>.png`);
  ok(sizeOk, `${kind}: PNG sizes match the table ${bad.filter(b => b.includes('size')).join(', ')}`);
  ok(+rows.torso?.[4] === 68, `${kind}: torso is 68 px tall (got ${rows.torso?.[4]})`);
  ok(pivOk, `${kind}: every pivot sits on opaque pixels ${bad.filter(b => b.includes('pivot')).join(', ')}`);
  ok(attOk, `${kind}: every attach point lands on its parent's opaque pixels ${bad.filter(b => b.includes('attach')).join(', ')}`);
  ok(!bad.some(b => b.includes('kit.json')), `${kind}: kit.json agrees with KIT.md`);
  ok(mag < 20, `${kind}: no magenta key spill (${mag} px)`);
  ok(bytes < 40 * 1024, `${kind}: lean (${(bytes / 1024).toFixed(1)} KB < 40 KB)`);
  ok(rows.uarm && rows.head && +rows.uarm[3] < 80, `${kind}: no stray parts (bracer/laser not shipped): ${fs.readdirSync(dir).filter(f => f.endsWith('.png')).length} PNGs`);
  ok(fs.readdirSync(dir).filter(f => f.endsWith('.png')).length === 7, `${kind}: exactly 7 PNGs in assets/enemies/${kind}/`);
}
ok(!fs.readdirSync(GAME, { recursive: true }).some(f => /sheet\.jpg$/.test(f) && /sniper|heavy|kits/.test(f)), 'source sheets kept out of the published game (live in pizza-panic-dev/kits/)');
// MANIFEST stays generator-neutral: no parsed kinds / rows / moves were added.
const man = fs.readFileSync(path.join(GAME, 'assets/enemies/MANIFEST.md'), 'utf8').split('\n');
// the publish-budget trim (hermes, t_01bda4bf651d4653) moves *.bak files out to ~/backups/<run>/ with their paths kept
const BAKREL = 'assets/enemies/MANIFEST.md.bak-kits', HOME = process.env.HOME || '/home/box';
const bakPath = [path.join(GAME, BAKREL), ...(fs.existsSync(path.join(HOME, 'backups')) ? fs.readdirSync(path.join(HOME, 'backups')).sort().reverse().map(d => path.join(HOME, 'backups', d, BAKREL)) : [])].find(f => fs.existsSync(f));
const bak = bakPath ? fs.readFileSync(bakPath, 'utf8').split('\n') : [];
const sig = ls => ls.filter(l => HEAD.test(l) || ROW.test(l) || /Mov[^:]*:/.test(l) || /Behavior:/.test(l)).join('\n');
ok(!!bakPath && bak.length > 100, `MANIFEST.md backed up as .bak-kits (${bakPath ? bakPath.replace(HOME, '~') : 'missing'})`);
ok(sig(man) === sig(bak), 'MANIFEST.md note adds no generator-visible headings/rows/move lines (rigsync stays exact)');
ok(/sniper\/KIT\.md/.test(man.join('\n')) && /heavy\/KIT\.md/.test(man.join('\n')), 'MANIFEST.md points at sniper/KIT.md and heavy/KIT.md');
ok(/face \*\*right\*\* natively/.test(man.join('\n')), 'MANIFEST.md keeps the "face **right** natively" rule');
const live = fs.readFileSync(path.join(GAME, 'enemy-rigs.js'), 'utf8');
ok(!/^\s*['\"]?(sniper|heavy)['\"]?\s*:\s*\{/m.test(live), 'enemy-rigs.js untouched (kits await registration by its owner)');
// real rig.js draws both kits via the preview harness
try {
  const out = execFileSync('node', [path.join(DEV, 'tools/kit_preview.mjs'), '/workspace/pizza-kits/check-kits-preview.png'], { timeout: 60000 }).toString().trim().split('\n').pop();
  const r = JSON.parse(out); ok(r.drawn === r.expected, `rig.js draws sniper + heavy in all ${r.expected / 2} preview poses (${r.drawn}/${r.expected})`); ok(!r.errors.length, `preview: 0 console/page errors ${r.errors.join(' | ')}`);
} catch (e) { ok(false, 'preview harness ran: ' + String(e.stdout || e).slice(0, 300)); }
console.log(`${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
