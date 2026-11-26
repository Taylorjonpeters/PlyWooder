// Toolpath planning and G-code output: npm run test:cam
// Uses small hand-made parts for exact geometry, plus the bundled STEP sample and the hand-made
// DXF from `npm run test:dxf` for realistic sheets. Writes sample files to scripts/out/.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { partsFromStep, type Part } from '../src/parts';
import { partsFromDxf } from '../src/dxfImport';
import { nest, type NestSettings } from '../src/nest';
import { placedShapes, type PlacedShape } from '../src/layout';
import type { Poly, Pt } from '../src/geom';
import { planSheet, tableReach, gordixFit, parseTableCfg, CAM_DEFAULTS, DEFAULT_TOOLS, STUDIO_TABLES, stockKey, type CamSettings, type CamSheet, type Move } from '../src/cam';
import { writeGcode, estimateSeconds } from '../src/gcode';

let failures = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ok    ${name}`); } catch (e) { failures++; console.log(`  FAIL  ${name}\n        ${(e as Error).message}`); }
}
function expect(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }

// --- fixtures -------------------------------------------------------------------
const rect = (x: number, y: number, w: number, h: number): Poly => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const cwRect = (x: number, y: number, w: number, h: number): Poly => [...rect(x, y, w, h)].reverse();
const fakePart = (name: string) => ({ name }) as Part;
/** A 200 × 120 mm panel at (100, 100) with an 18 × 60 mm slot hole and a 6 mm deep 40 × 30 pocket. */
const slotPanel: PlacedShape = {
  key: 'p#0', part: fakePart('Slot panel'), copy: 0, xform: { rot: 0, tx: 0, ty: 0 },
  regions: [{ outer: rect(100, 100, 200, 120), holes: [cwRect(140, 130, 18, 60)] }],
  pockets: [{ regions: [{ outer: rect(220, 140, 40, 30), holes: [] }], depth: 6, side: 'top' }],
  label: { x: 200, y: 200, size: 20 },
};
const sheetOf = (shapes: PlacedShape[], over: Partial<CamSheet> = {}): CamSheet => ({
  w: 600, h: 400, thickness: 18, kerf: 6.35, edgeMargin: 10, shapes, title: 'test', ...over,
});
const cfgWith = (over: Partial<CamSettings> = {}): CamSettings => ({ ...CAM_DEFAULTS, tools: DEFAULT_TOOLS, ...over });
const allMoves = (files: { moves: Move[] }[]) => files.flatMap((f) => f.moves);
const closest = (moves: Move[], p: Pt, op: Move['op']) =>
  Math.min(...moves.filter((m) => m.op === op && !m.rapid).map((m) => Math.hypot(m.x - p.x, m.y - p.y)));
const gcodeOf = (sheet: CamSheet, cfg: CamSettings) => {
  const job = planSheet(sheet, cfg);
  return job.files.map((f, i) => writeGcode(f, { cfg, sheetW: sheet.w, sheetH: sheet.h, title: sheet.title, index: i + 1, count: job.files.length, stock: job.stock, cutDepth: job.cutDepth }));
};
const words = (text: string) => text.split('\n').map((l) => l.replace(/;.*$/, '').trim()).filter(Boolean).map((l) => l.split(/\s+/));

// --- cut order and operations ---------------------------------------------------
console.log('cut order');
test('holes are cut before the outlines around them', () => {
  const job = planSheet(sheetOf([slotPanel]), cfgWith());
  const ops = allMoves(job.files).map((m) => m.op);
  expect(ops.lastIndexOf('hole') >= 0, 'no hole moves');
  expect(ops.lastIndexOf('hole') < ops.indexOf('outline'), `last hole move at ${ops.lastIndexOf('hole')}, first outline move at ${ops.indexOf('outline')}`);
});

test('pockets are cut before holes and outlines', () => {
  const ops = allMoves(planSheet(sheetOf([slotPanel]), cfgWith()).files).map((m) => m.op);
  expect(ops.lastIndexOf('pocket') < ops.indexOf('hole'), 'a pocket move comes after a hole move');
});

test('one bit for everything gives one file', () => {
  const job = planSheet(sheetOf([slotPanel]), cfgWith());
  expect(job.files.length === 1, `got ${job.files.length} files`);
  expect(job.files[0].ops.join() === 'pocket,hole,outline', `ops ${job.files[0].ops.join()}`);
});

test('a different hole bit splits the job into one file per bit change, in cutting order', () => {
  const job = planSheet(sheetOf([slotPanel]), cfgWith({ holeTool: 'flat-3.175' }));
  const desc = job.files.map((f) => `${f.ops.join('+')}@${f.tool?.diameter}`).join(' | ');
  expect(desc === 'pocket@6.35 | hole@3.175 | outline@6.35', desc);
});

// --- depths, ramps, tabs -------------------------------------------------------
console.log('depth and entry');
test('through cuts reach stock + extra and never go deeper', () => {
  const job = planSheet(sheetOf([slotPanel]), cfgWith());
  const zs = allMoves(job.files).map((m) => m.z);
  expect(Math.abs(Math.min(...zs) + 18.5) < 1e-6, `deepest Z ${Math.min(...zs)}, expected -18.5`);
});

test('measured stock thickness sets the cut depth', () => {
  const job = planSheet(sheetOf([slotPanel]), cfgWith({ stockActual: { [stockKey(18)]: 18.6 } }));
  expect(Math.abs(job.cutDepth - 19.1) < 1e-9, `cut depth ${job.cutDepth}, expected 19.1`);
});

test('pockets stop at their own depth', () => {
  const zs = allMoves(planSheet(sheetOf([slotPanel]), cfgWith()).files).filter((m) => m.op === 'pocket').map((m) => m.z);
  expect(Math.abs(Math.min(...zs) + 6) < 1e-6, `deepest pocket Z ${Math.min(...zs)}, expected -6`);
});

test('with ramping on, the bit never plunges straight down into uncut material', () => {
  const moves = allMoves(planSheet(sheetOf([slotPanel]), cfgWith({ ramp: true })).files);
  // Deepest Z already cut at each XY (rounded), so a plunge through cut air is allowed.
  const cut = new Map<string, number>();
  const key = (m: Move) => `${m.x.toFixed(2)},${m.y.toFixed(2)}`;
  let prev = moves[0];
  for (const m of moves.slice(1)) {
    const vertical = Math.hypot(m.x - prev.x, m.y - prev.y) < 1e-6;
    // Stepping back down at the end of a tab is a deliberate short plunge, as Studio does it.
    if (vertical && !m.rapid && m.z < prev.z && m.z < -1e-6 && !prev.tab) {
      const done = cut.get(key(m)) ?? 0;
      expect(m.z >= done - 1e-6, `vertical plunge to Z${m.z.toFixed(3)} at ${key(m)}, only cut to Z${done.toFixed(3)} there`);
    }
    cut.set(key(m), Math.min(cut.get(key(m)) ?? 0, m.z));
    prev = m;
  }
});

test('with ramping off, passes plunge straight down', () => {
  const moves = allMoves(planSheet(sheetOf([slotPanel]), cfgWith({ ramp: false })).files);
  const ramps = moves.filter((m, i) => i > 0 && !m.rapid && m.z < moves[i - 1].z - 1e-6 && Math.hypot(m.x - moves[i - 1].x, m.y - moves[i - 1].y) > 1e-6);
  expect(ramps.length === 0, `${ramps.length} sloped moves`);
});

test('tabs stand at tab height above the bottom of the stock', () => {
  const moves = allMoves(planSheet(sheetOf([slotPanel]), cfgWith({ tabs: true, tabHeight: 3 })).files);
  const tabs = moves.filter((m) => m.tab && m.op === 'outline');
  expect(tabs.length > 0, 'no tab moves on the outline');
  expect(tabs.every((m) => Math.abs(m.z + 15) < 1e-6), `tab moves at Z ${[...new Set(tabs.map((m) => m.z))].join(', ')}, expected -15`);
});

test('tabs on holes can be turned off', () => {
  const moves = allMoves(planSheet(sheetOf([slotPanel]), cfgWith({ tabsOnHoles: false })).files);
  expect(!moves.some((m) => m.tab && m.op === 'hole'), 'hole has tabs');
});

// --- fit -------------------------------------------------------------------------
console.log('fit');
const slotCorners = [{ x: 140, y: 130 }, { x: 158, y: 130 }, { x: 158, y: 190 }, { x: 140, y: 190 }];
test('without dogbones a round bit stays a radius × √2 from slot corners', () => {
  const moves = allMoves(planSheet(sheetOf([slotPanel]), cfgWith({ dogbones: false })).files);
  const d = Math.min(...slotCorners.map((c) => closest(moves, c, 'hole')));
  expect(Math.abs(d - 3.175 * Math.SQRT2) < 0.05, `closest approach ${d.toFixed(3)} mm`);
});

test('dogbones let the bit reach every slot corner', () => {
  const moves = allMoves(planSheet(sheetOf([slotPanel]), cfgWith({ dogbones: true })).files);
  for (const c of slotCorners) {
    const d = closest(moves, c, 'hole');
    expect(d <= 3.175 + 0.3, `bit centre gets ${d.toFixed(3)} mm from corner ${c.x},${c.y}; touching is 3.175`);
  }
});

test('dogbones reach the inside corners of an outline notch', () => {
  // U shape: 100 × 80 with a 20 × 40 notch cut down from the top edge.
  const u: PlacedShape = {
    ...slotPanel, pockets: [],
    regions: [{ outer: [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 180 }, { x: 160, y: 180 }, { x: 160, y: 140 }, { x: 140, y: 140 }, { x: 140, y: 180 }, { x: 100, y: 180 }], holes: [] }],
  };
  const moves = allMoves(planSheet(sheetOf([u]), cfgWith({ dogbones: true })).files);
  for (const c of [{ x: 160, y: 140 }, { x: 140, y: 140 }]) {
    const d = closest(moves, c, 'outline');
    expect(d <= 3.175 + 0.3, `bit centre gets ${d.toFixed(3)} mm from notch corner ${c.x},${c.y}`);
  }
});

test('fit allowance widens the slot by the allowance', () => {
  const moves = allMoves(planSheet(sheetOf([slotPanel]), cfgWith({ fitAllowance: 0.4 })).files).filter((m) => m.op === 'hole' && !m.rapid);
  const width = Math.max(...moves.map((m) => m.x)) - Math.min(...moves.map((m) => m.x)) + 6.35;
  expect(Math.abs(width - 18.4) < 0.02, `slot cut ${width.toFixed(3)} mm wide, expected 18.4`);
});

test('fit allowance narrows the outline by the allowance', () => {
  const moves = allMoves(planSheet(sheetOf([slotPanel]), cfgWith({ fitAllowance: 0.4 })).files).filter((m) => m.op === 'outline' && !m.rapid);
  const width = Math.max(...moves.map((m) => m.x)) - Math.min(...moves.map((m) => m.x)) - 6.35;
  expect(Math.abs(width - 199.6) < 0.02, `panel cut ${width.toFixed(3)} mm wide, expected 199.6`);
});

// --- dialects -------------------------------------------------------------------
console.log('G-code');
test('GORDIX router files use only the commands GORDIX Studio writes', () => {
  for (const text of gcodeOf(sheetOf([slotPanel]), cfgWith())) {
    const bad = words(text).filter((w) => !/^(G0|G1|G21|G90)$/.test(w[0]));
    expect(!bad.length, `unexpected: ${bad.slice(0, 3).map((w) => w.join(' ')).join(' / ')}`);
  }
});

test('GORDIX rapids carry F2000 and plunges use the plunge feed', () => {
  const [text] = gcodeOf(sheetOf([slotPanel]), cfgWith());
  let f = NaN, z = 2;
  for (const w of words(text)) {
    const v = Object.fromEntries(w.slice(1).map((x) => [x[0], Number(x.slice(1))]));
    if (v.F !== undefined) f = v.F;
    if (w[0] === 'G0' && (v.X !== undefined || v.Y !== undefined)) expect(f === 2000, `G0 at F${f}: ${w.join(' ')}`);
    if (w[0] === 'G1' && v.Z !== undefined && v.X === undefined && v.Z < z) expect(f === 300, `plunge at F${f}: ${w.join(' ')}`);
    if (v.Z !== undefined) z = v.Z;
  }
});

test('GORDIX files put X0 Y0 at the sheet centre and end there', () => {
  const [text] = gcodeOf(sheetOf([slotPanel]), cfgWith());
  const xs = words(text).flatMap((w) => w.filter((x) => x[0] === 'X').map((x) => Number(x.slice(1))));
  expect(Math.min(...xs) < 0 && Math.max(...xs) <= 300, `X range ${Math.min(...xs)}..${Math.max(...xs)}`);
  expect(/G0 X0 Y0( F2000)?\s*$/.test(text), 'does not end at X0 Y0');
});

test('laser labels come first, in their own file, with M03 S255 / M05 and no Z', () => {
  const sheet = sheetOf([slotPanel]);
  const cfg = cfgWith({ labels: true });
  const job = planSheet(sheet, cfg);
  expect(job.files[0].kind === 'laser', `first file is ${job.files[0].kind}`);
  const [text] = gcodeOf(sheet, cfg);
  const w = words(text);
  expect(w.some((x) => x.join(' ') === 'M03 S255'), 'no M03 S255');
  expect(w.filter((x) => x[0] === 'M03').length === w.filter((x) => x[0] === 'M05').length, 'M03/M05 unbalanced');
  expect(!w.some((x) => x.some((y) => y[0] === 'Z')), 'laser file moves Z');
});

test('air cut raises every Z by the air-cut height', () => {
  const sheet = sheetOf([slotPanel]);
  const [real] = gcodeOf(sheet, cfgWith());
  const [air] = gcodeOf(sheet, cfgWith({ airCut: 25 }));
  const minZ = (t: string) => Math.min(...words(t).flatMap((w) => w.filter((x) => x[0] === 'Z').map((x) => Number(x.slice(1)))));
  expect(Math.abs(minZ(air) - (minZ(real) + 25)) < 1e-6, `air-cut min Z ${minZ(air)}, real ${minZ(real)}`);
});

test('GRBL files start the spindle, use a corner origin and end with M30', () => {
  const [text] = gcodeOf(sheetOf([slotPanel]), cfgWith({ machine: 'grbl', origin: 'corner', rpm: 18000 }));
  const w = words(text);
  expect(w.some((x) => x.join(' ') === 'M3 S18000'), 'no M3 S18000');
  expect(w[w.length - 1][0] === 'M30', `last line ${w[w.length - 1].join(' ')}`);
  const xs = w.flatMap((x) => x.filter((y) => y[0] === 'X').map((y) => Number(y.slice(1))));
  expect(Math.min(...xs) >= 0, `X goes to ${Math.min(...xs)} with a corner origin`);
});

// --- checks ---------------------------------------------------------------------
console.log('warnings');
test("the GORDIX reach follows its firmware: (S+N)/4 - 140 by (E+W)/4 - 200, just inside", () => {
  // Measured on a real machine: Y 534.9 accepted, Y 541 refused (firmware limits ±535, ±540.5).
  const r = tableReach({ E: 1481, S: 1345, W: 1481, N: 1355 });
  expect(r.x === 534 && r.y === 540, `±${r.x} × ±${r.y}`);
  const d = tableReach(STUDIO_TABLES[1]);
  expect(d.x === 529 && d.y === 529, `table 2 ±${d.x} × ±${d.y}`);
});

test('a safe height above Z+3 or a cut deeper than 30 mm is flagged on the GORDIX', () => {
  const high = planSheet(sheetOf([slotPanel]), cfgWith({ safeZ: 5 }));
  expect(high.warnings.some((w) => /Safe height/.test(w)), high.warnings.join(' | ') || 'no warnings');
  const deep = planSheet(sheetOf([slotPanel], { thickness: 30 }), cfgWith());
  expect(deep.warnings.some((w) => /Cut depth/.test(w)), deep.warnings.join(' | ') || 'no warnings');
});

test('cuts outside the GORDIX work area are flagged', () => {
  const wide: PlacedShape = { ...slotPanel, pockets: [], regions: [{ outer: rect(20, 20, 2400, 100), holes: [] }] };
  const job = planSheet(sheetOf([wide], { w: 2440, h: 1220 }), cfgWith());
  expect(job.warnings.some((w) => /the GORDIX reaches/.test(w)), job.warnings.join(' | ') || 'no warnings');
});

test('an outline bit wider than the layout bit is flagged', () => {
  const job = planSheet(sheetOf([slotPanel], { kerf: 3.175 }), cfgWith());
  expect(job.warnings.some((w) => /wider than the layout/.test(w)), job.warnings.join(' | ') || 'no warnings');
});

test('a job has a run time', () => {
  const job = planSheet(sheetOf([slotPanel]), cfgWith());
  const t = estimateSeconds(job.files[0].moves, 'gordix', { x: 300, y: 200 });
  expect(t > 60 && t < 3600, `${t.toFixed(0)} s`);
});

// --- GORDIX tables ----------------------------------------------------------------
console.log('GORDIX tables');
/** A table.cfg as GORDIX Studio exports it: a 4 x 8 ft table first, then Studio's tables 2-5. */
const TABLE_CFG = [
  'TABLE1E 1219', 'TABLE1S 2438', 'TABLE1W 1219', 'TABLE1N 2438', 'TABLE1D 2724.912', 'TABLE1X 1.0000', 'TABLE1Y 1.0000', '',
  'TABLE2E 1460', 'TABLE2S 1340', 'TABLE2W 1460', 'TABLE2N 1340', 'TABLE2D 1982', 'TABLE2X 1.0000', 'TABLE2Y 1.0000', '',
].join('\r\n');

test('table.cfg: reads every value of every table', () => {
  const t = parseTableCfg(TABLE_CFG);
  expect(JSON.stringify(t[0]) === JSON.stringify({ id: 1, E: 1219, S: 2438, W: 1219, N: 2438, D: 2724.912, X: 1, Y: 1 }), JSON.stringify(t[0]));
  expect(t[1].S === 1340 && t[1].W === 1460, `table 2 is ${t[1].S} x ${t[1].W}`);
});

test("table.cfg: tables the file leaves out keep Studio's defaults", () => {
  const t = parseTableCfg(TABLE_CFG);
  expect(t.length === 5 && t[4].S === STUDIO_TABLES[4].S, `${t.length} tables, table 5 S ${t[4]?.S}`);
});

test('table.cfg: sides are clamped to 600-2600 mm as Studio does', () => {
  const t = parseTableCfg('TABLE1S 3000\nTABLE1W 400');
  expect(t[0].S === 2600 && t[0].W === 600, `S ${t[0].S}, W ${t[0].W}`);
});

test('table.cfg: a file with no tables is rejected', () => {
  let msg = '';
  try { parseTableCfg('hello'); } catch (e) { msg = (e as Error).message; }
  expect(/table\.cfg/.test(msg), msg || 'no error');
});

test("Studio's default table 1 (2560 x 1460) reaches 2278 x 1058", () => {
  const f = gordixFit(STUDIO_TABLES[0]);
  expect(f.x * 2 === 2278 && f.y * 2 === 1058 && !f.rotate, JSON.stringify(f));
});

test('a 4 x 8 ft table (2438 x 1219) reaches 2156 x 818', () => {
  const f = gordixFit(parseTableCfg(TABLE_CFG)[0]);
  expect(f.x * 2 === 2156 && f.y * 2 === 818, `${f.x * 2} x ${f.y * 2}`);
});

test("on a table that reaches further along Y, the sheet's long side runs along machine Y", () => {
  // A near-square table as measured: S 1345, N 1355 (X ±534), E = W = 1481 (Y ±540).
  const tables = parseTableCfg('TABLE2E 1481\nTABLE2S 1345\nTABLE2W 1481\nTABLE2N 1355');
  const f = gordixFit(tables[1]);
  expect(f.rotate, 'table 2 should turn the sheet');
  const sheet = sheetOf([{ ...slotPanel, pockets: [], regions: [{ outer: rect(20, 20, f.x * 2 - 40, 100), holes: [] }] }], { w: f.x * 2, h: f.y * 2 });
  const cfg = cfgWith({ tables, tableId: 2 });
  expect(!planSheet(sheet, cfg).warnings.length, planSheet(sheet, cfg).warnings.join(' | '));
  const [text] = gcodeOf(sheet, cfg);
  const vals = (axis: string) => words(text).flatMap((w) => w.filter((x) => x[0] === axis).map((x) => Number(x.slice(1))));
  expect(Math.max(...vals('X').map(Math.abs)) <= f.machine.x + 0.01, `X reaches ${Math.max(...vals('X').map(Math.abs))}, machine X range ±${f.machine.x}`);
  expect(Math.max(...vals('Y').map(Math.abs)) <= f.machine.y + 0.01, `Y reaches ${Math.max(...vals('Y').map(Math.abs))}, machine Y range ±${f.machine.y}`);
  expect(/Sheet turned 90 degrees/.test(text), 'header does not say the sheet is turned');
});

// --- real sheets ---------------------------------------------------------------
console.log('sample sheets');
const require = createRequire(import.meta.url);
const occt = await require('occt-import-js')();
// placedShapes looks parts up by id, which is their index in the full list, so keep the list whole.
const stepParts = partsFromStep(occt, new Uint8Array(readFileSync('public/samples/RrReid_YarnStorage.step')));
const dxfParts = partsFromDxf(readFileSync('scripts/out/handmade.dxf', 'utf8'), 18).parts;
mkdirSync('scripts/out', { recursive: true });
for (const [name, parts] of [['yarn', stepParts], ['handmade', dxfParts]] as const) {
  const t = parts.find((p) => p.isPanel)!.thickness;
  const same = parts.filter((p) => p.isPanel && Math.abs(p.thickness - t) < 0.3);
  // The 4 × 8 ft GORDIX work area.
  const s: NestSettings = { sheetW: 2160, sheetH: 830, edgeMargin: 10, kerf: 6.35, errorGap: 3, shareCuts: true, mode: 'optimal', shape: 'true', rotation: 'free90', effort: 'quick' };
  const r = nest(same.map((p) => ({ key: `${p.id}`, partId: p.id, regions: p.regions, hull: p.hull, w: p.w, h: p.h, area: p.area })), s);
  const sheet: CamSheet = { w: s.sheetW, h: s.sheetH, thickness: t, kerf: s.kerf, edgeMargin: s.edgeMargin, shapes: placedShapes(parts, r.sheets[0].placements, 'true'), title: `${name} sheet 1` };
  const cfg = cfgWith({ labels: true, dogbones: true, holeTool: 'flat-3.175' });
  test(`${name}: plans on the GORDIX work area without warnings`, () => {
    const job = planSheet(sheet, cfg);
    expect(!job.warnings.length, job.warnings.join(' | '));
    expect(job.files.some((f) => f.ops.includes('outline')), 'no outline file');
  });
  gcodeOf(sheet, cfg).forEach((text, i) => writeFileSync(`scripts/out/${name}-${i + 1}.gcode`, text));
}

console.log(failures ? `\n${failures} failure(s)` : '\nall CAM checks passed; sample files in scripts/out/');
process.exit(failures ? 1 : 0);
