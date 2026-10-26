import { type Poly, asCircle } from './geom';
import type { PlacedShape } from './layout';
import type { CutLine } from './nest';
import type { Stroke } from './cutpaths';

export type DxfSheet = { w: number; h: number; shapes: PlacedShape[]; cuts: CutLine[]; strokes: Stroke[]; title: string };

/**
 * ASCII DXF (R12) — the format every CNC CAM package imports (VCarve, Fusion, Carbide Create,
 * Easel, LightBurn, SheetCAM). Layers separate toolpaths:
 *   CUT_OUTSIDE  profile cuts, tool outside the line
 *   CUT_INSIDE   through holes, tool inside the line
 *   POCKET_<d>   partial-depth pockets, d = depth
 *   CUT_PATHS    merged tool-centre paths in cutting order (shared edges appear once);
 *                profile these on the line with the same bit
 *   SHEET, LABELS, SAW_CUTS (reference only)
 */
export function toDxf(sheets: DxfSheet[], units: 'mm' | 'in'): string {
  const k = units === 'in' ? 1 / 25.4 : 1;
  const f = (v: number) => (v * k).toFixed(4);
  const out: string[] = [];
  const g = (code: number, value: string | number) => out.push(String(code), String(value));

  const layers = new Map<string, number>([
    ['SHEET', 8], ['CUT_OUTSIDE', 1], ['CUT_INSIDE', 5], ['CUT_PATHS', 4], ['LABELS', 7], ['SAW_CUTS', 6],
  ]);
  const pocketLayer = (d: number, side: string) => {
    const name = `POCKET_${(d * k).toFixed(units === 'in' ? 3 : 1).replace('.', '_')}${units}${side === 'bottom' ? '_BACK' : ''}`;
    layers.set(name, 3);
    return name;
  };
  // Resolve pocket layer names before writing the table.
  for (const s of sheets) for (const sh of s.shapes) for (const p of sh.pockets) pocketLayer(p.depth, p.side);

  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, units === 'in' ? 1 : 4);
  g(9, '$MEASUREMENT'); g(70, units === 'in' ? 0 : 1);
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.size);
  for (const [name, color] of layers) { g(0, 'LAYER'); g(2, name); g(70, 0); g(62, color); g(6, 'CONTINUOUS'); }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'ENTITIES');
  const poly = (p: Poly, layer: string, dy: number, closed = true) => {
    const c = closed ? asCircle(p) : null;
    if (c) { g(0, 'CIRCLE'); g(8, layer); g(10, f(c.cx)); g(20, f(c.cy + dy)); g(30, 0); g(40, f(c.r)); return; }
    g(0, 'POLYLINE'); g(8, layer); g(66, 1); g(10, 0); g(20, 0); g(30, 0); g(70, closed ? 1 : 0);
    for (const q of p) { g(0, 'VERTEX'); g(8, layer); g(10, f(q.x)); g(20, f(q.y + dy)); g(30, 0); }
    g(0, 'SEQEND'); g(8, layer);
  };
  const text = (x: number, y: number, h: number, s: string) => {
    g(0, 'TEXT'); g(8, 'LABELS'); g(10, f(x)); g(20, f(y)); g(30, 0); g(40, f(h)); g(1, s.replace(/[\r\n]/g, ' '));
    g(72, 1); g(73, 2); g(11, f(x)); g(21, f(y)); g(31, 0);
  };

  // Several sheets stack upward with a gap so they never overlap.
  let dy = 0;
  for (const s of sheets) {
    poly([{ x: 0, y: 0 }, { x: s.w, y: 0 }, { x: s.w, y: s.h }, { x: 0, y: s.h }], 'SHEET', dy);
    if (sheets.length > 1) text(s.w / 2, s.h + 40, 40, s.title);
    for (const sh of s.shapes) {
      for (const r of sh.regions) {
        poly(r.outer, 'CUT_OUTSIDE', dy);
        for (const h of r.holes) poly(h, 'CUT_INSIDE', dy);
      }
      for (const pk of sh.pockets) {
        const layer = pocketLayer(pk.depth, pk.side);
        for (const r of pk.regions) { poly(r.outer, layer, dy); for (const h of r.holes) poly(h, layer, dy); }
      }
      text(sh.label.x, sh.label.y + dy, sh.label.size * 0.6, sh.part.name);
    }
    for (const k of s.strokes) poly(k.closed ? k.pts.slice(0, -1) : k.pts, 'CUT_PATHS', dy, k.closed);
    for (const c of s.cuts) {
      g(0, 'LINE'); g(8, 'SAW_CUTS'); g(10, f(c.x1)); g(20, f(c.y1 + dy)); g(30, 0); g(11, f(c.x2)); g(21, f(c.y2 + dy)); g(31, 0);
    }
    dy += s.h + 150;
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\n') + '\n';
}

export function toSvg(s: DxfSheet): string {
  const y = (v: number) => (s.h - v).toFixed(2);
  const path = (p: Poly) => 'M' + p.map((q) => `${q.x.toFixed(2)},${y(q.y)}`).join('L') + 'Z';
  const parts = s.shapes.map((sh) => {
    const d = sh.regions.map((r) => [r.outer, ...r.holes].map(path).join('')).join('');
    const pk = sh.pockets.map((p) => `<path d="${p.regions.map((r) => [r.outer, ...r.holes].map(path).join('')).join('')}" fill="none" stroke="#0a0" stroke-width="1"/>`).join('');
    return `<g><path d="${d}" fill="none" stroke="#e00" stroke-width="1" fill-rule="evenodd"/>${pk}<text x="${sh.label.x.toFixed(1)}" y="${y(sh.label.y)}" font-size="${(sh.label.size * 0.6).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif">${esc(sh.part.name)}</text></g>`;
  });
  const cuts = s.cuts.map((c) => `<line x1="${c.x1.toFixed(2)}" y1="${y(c.y1)}" x2="${c.x2.toFixed(2)}" y2="${y(c.y2)}" stroke="#c0c" stroke-dasharray="8 6"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s.w}mm" height="${s.h}mm" viewBox="0 0 ${s.w} ${s.h}"><rect width="${s.w}" height="${s.h}" fill="none" stroke="#888"/>${parts.join('')}${cuts.join('')}</svg>`;
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
