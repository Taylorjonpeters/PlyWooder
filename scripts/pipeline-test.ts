// Runs the STEP -> parts -> nesting pipeline in Node against a file: npm test -- path/to/file.step
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { partsFromStep } from '../src/parts';
import { regionArea } from '../src/geom';

const require = createRequire(import.meta.url);
const occtimportjs = require('occt-import-js');
const file = process.argv[2] ?? 'public/samples/RrReid_YarnStorage.step';

const occt = await occtimportjs();
const t0 = performance.now();
const parts = partsFromStep(occt, new Uint8Array(readFileSync(file)));
console.log(`parsed ${parts.length} parts in ${(performance.now() - t0).toFixed(0)} ms`);
for (const p of parts) {
  console.log(
    p.name.padEnd(22), `${p.w.toFixed(1)} x ${p.h.toFixed(1)} x ${p.thickness.toFixed(2)}`.padEnd(24),
    `regions=${p.regions.length} holes=${p.regions.reduce((s, r) => s + r.holes.length, 0)} outerPts=${p.regions[0]?.outer.length}`,
    `pockets=${p.pockets.map((k) => `${k.side}:${k.depth.toFixed(1)}`).join(',') || '-'}`,
    `fill=${(regionArea(p.regions[0]) / (p.w * p.h) * 100).toFixed(0)}%`, p.isPanel ? '' : '(not a panel)');
}

// --- nesting -----------------------------------------------------------------
import { nest, type NestItem, type NestSettings, type Placement } from '../src/nest';
import { applyXform, offsetRegions, unionAll, regionArea as rArea } from '../src/geom';
import ClipperLib from 'clipper-lib';
import { cutNetwork, type CutNetwork } from '../src/cutpaths';
import { placedShapes } from '../src/layout';

const panels = parts.filter((p) => p.isPanel);
const items: NestItem[] = panels.map((p) => ({ key: `${p.id}`, partId: p.id, regions: p.regions, hull: p.hull, w: p.w, h: p.h, area: p.area }));
const base: NestSettings = { sheetW: 2440, sheetH: 1220, edgeMargin: 10, kerf: 6.35, errorGap: 3, shareCuts: false, mode: 'optimal', shape: 'true', rotation: 'free90', effort: 'quick' };

/** Verify no two parts come closer than the requested gap and all stay on the sheet. */
function check(placements: Placement[], s: NestSettings) {
  const gap = s.kerf + (s.shareCuts ? 0 : s.errorGap);
  const placed = placements.map((pl) => {
    const p = parts[pl.partId];
    const shape = s.shape === 'hull' ? [{ outer: p.hull, holes: [] }] : p.regions;
    return shape.map((r) => ({ outer: applyXform(r.outer, pl.xform), holes: r.holes.map((h) => applyXform(h, pl.xform)) }));
  });
  let worst = 0;
  for (let i = 0; i < placed.length; i++) {
    const pts = placed[i].flatMap((r) => r.outer);
    for (const q of pts) {
      if (q.x < s.edgeMargin - 0.01 || q.y < s.edgeMargin - 0.01 || q.x > s.sheetW - s.edgeMargin + 0.01 || q.y > s.sheetH - s.edgeMargin + 0.01) {
        if (s.mode === 'easy' || q.x < -0.01 || q.y < -0.01 || q.x > s.sheetW || q.y > s.sheetH) throw new Error(`part ${placements[i].key} off sheet at ${q.x},${q.y}`);
      }
    }
    for (let j = i + 1; j < placed.length; j++) {
      // Grow each by just under half the gap; any overlap means the gap was violated.
      const a = unionAll(offsetRegions(placed[i], gap / 2 - 0.05));
      const b = unionAll(offsetRegions(placed[j], gap / 2 - 0.05));
      const c = new ClipperLib.Clipper();
      const S = (rs: typeof a) => rs.flatMap((r) => [r.outer, ...r.holes]).map((p) => p.map((q) => ({ X: Math.round(q.x * 1000), Y: Math.round(q.y * 1000) })));
      c.AddPaths(S(a), ClipperLib.PolyType.ptSubject, true);
      c.AddPaths(S(b), ClipperLib.PolyType.ptClip, true);
      const sol = new ClipperLib.PolyTree();
      c.Execute(ClipperLib.ClipType.ctIntersection, sol, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
      const paths = ClipperLib.Clipper.PolyTreeToPaths(sol);
      const ov = paths.reduce((s, p) => s + Math.abs(ClipperLib.Clipper.Area(p)), 0) / 1e6;
      worst = Math.max(worst, ov);
    }
  }
  return worst;
}

for (const shareCuts of [false, true]) for (const mode of ['optimal', 'easy'] as const) for (const shape of ['true', 'hull'] as const) {
  if (mode === 'easy' && shape === 'hull') continue;
  const s = { ...base, mode, shape, shareCuts };
  const r = nest(items, s);
  const overlaps = r.sheets.map((sh) => check(sh.placements, s));
  const nets = r.sheets.map((sh) => cutNetwork(placedShapes(parts, sh.placements, 'true').map((p) => p.regions), s.kerf, s.sheetW, s.sheetH, s.edgeMargin));
  const sum = (f: (n: CutNetwork) => number) => nets.reduce((a, n) => a + f(n), 0);
  console.log(`${shareCuts ? 'SHARED ' : 'spaced '}${mode}/${shape}: cuts ${sum((n) => n.strokes.length)} plunges ${sum((n) => n.plunges)} (separate ${sum((n) => n.separate.loops)} loops), cut ${(sum((n) => n.length) / 1000).toFixed(1)} m (separate ${(sum((n) => n.separate.length) / 1000).toFixed(1)} m), shared ${(sum((n) => n.sharedLength) / 1000).toFixed(1)} m`);
  console.log(`  ${mode}/${shape}: ${r.sheets.length} sheets, util ${r.sheets.map((sh) => ((sh.usedArea / (s.sheetW * s.sheetH)) * 100).toFixed(0) + '%').join(' ')}, unplaced ${r.unplaced.length}, ${r.ms.toFixed(0)} ms, worst overlap ${Math.max(...overlaps).toFixed(3)} mm²`);
  if (mode === 'easy' && !shareCuts) console.log(r.sheets.map((sh, i) => `Sheet ${i + 1}\n` + sh.steps.join('\n')).join('\n'));
}
void rArea;

// --- DXF export --------------------------------------------------------------
import { writeFileSync, mkdirSync } from 'node:fs';
import { toDxf, toSvg } from '../src/dxf';
{
  const s = { ...base, mode: 'easy' as const };
  const r = nest(items, s);
  const sheets = r.sheets.map((sh, i) => ({ w: s.sheetW, h: s.sheetH, shapes: placedShapes(parts, sh.placements, 'true'), cuts: sh.cuts, strokes: sh.network?.strokes ?? [], title: `sheet ${i + 1}` }));
  mkdirSync('scripts/out', { recursive: true });
  writeFileSync('scripts/out/all.dxf', toDxf(sheets, 'mm'));
  writeFileSync('scripts/out/sheet1.svg', toSvg(sheets[0]));
  console.log('wrote scripts/out/all.dxf');
}
