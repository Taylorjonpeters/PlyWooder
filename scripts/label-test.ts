// Part labels: the name must never be written over a hole, and parts without holes keep it centred.
// Self-contained: builds parts from a hand-written DXF, so it needs no STEP sample.
import { partsFromDxf } from '../src/dxfImport';
import { placedShapes } from '../src/layout';
import type { Poly, Pt } from '../src/geom';

const pair = (c: number, v: string | number) => `${c}\n${v}`;
const rect = (x: number, y: number, w: number, h: number) =>
  ['0', 'LWPOLYLINE', pair(8, 'CUT'), pair(90, 4), pair(70, 1), pair(10, x), pair(20, y), pair(10, x + w), pair(20, y), pair(10, x + w), pair(20, y + h), pair(10, x), pair(20, y + h)].join('\n');
const circle = (x: number, y: number, r: number) => ['0', 'CIRCLE', pair(8, 'CUT'), pair(10, x), pair(20, y), pair(40, r)].join('\n');

const dxf = ['0\nSECTION\n2\nENTITIES',
  rect(0, 0, 600, 400), circle(300, 200, 40),                       // A: hole in the middle
  rect(1000, 0, 300, 300), circle(1150, 150, 100),                  // B: hole fills the middle
  rect(2000, 0, 500, 200),                                           // C: no hole
  rect(3000, 0, 200, 700), circle(3100, 175, 30), circle(3100, 525, 30), // D: tall, two holes
  '0\nENDSEC\n0\nEOF'].join('\n') + '\n';

const parts = partsFromDxf(dxf, 18).parts;
let failed = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? '  ok  ' : '  FAIL'}  ${msg}`); if (!ok) failed++; };

const inPoly = (p: Pt, poly: Poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

for (const rot of [0, Math.PI / 2]) {
  console.log(rot ? 'turned 90°' : 'as drawn');
  for (const sh of placedShapes(parts, parts.map((p) => ({ key: `${p.id}#0`, partId: p.id, xform: { rot, tx: 500, ty: 300 } })), 'true')) {
    const outer = sh.regions.flatMap((r) => r.outer);
    const xs = outer.map((p) => p.x), ys = outer.map((p) => p.y);
    const bb = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    const vertical = bb.maxY - bb.minY > (bb.maxX - bb.minX) * 1.25;
    const { x, y, size } = sh.label;
    const along = (Math.max(sh.part.name.length * 0.62, 4.5) * size) / 2, across = size * 1.4;
    const hx = vertical ? across : along, hy = vertical ? along : across;
    const holes = sh.regions.flatMap((r) => r.holes);
    // The text block never touches a hole's bounding box, and every point of it is on material.
    const clear = holes.every((h) => {
      const hxs = h.map((p) => p.x), hys = h.map((p) => p.y);
      return x + hx <= Math.min(...hxs) || x - hx >= Math.max(...hxs) || y + hy <= Math.min(...hys) || y - hy >= Math.max(...hys);
    });
    let onMaterial = true;
    for (let i = 0; i <= 12; i++) for (let j = 0; j <= 6; j++) {
      const p = { x: x - hx + (hx * 2 * i) / 12, y: y - hy + (hy * 2 * j) / 6 };
      if (!sh.regions.some((r) => inPoly(p, r.outer) && !r.holes.some((h) => inPoly(p, h)))) onMaterial = false;
    }
    const centred = Math.abs(x - (bb.minX + bb.maxX) / 2) < 1e-6 && Math.abs(y - (bb.minY + bb.maxY) / 2) < 1e-6;
    check(clear && onMaterial, `${sh.part.name} (${holes.length} hole${holes.length === 1 ? '' : 's'}): label clear of holes and on material, size ${size.toFixed(1)}`);
    if (!holes.length) check(centred, `${sh.part.name}: no holes, so the label stays centred`);
  }
}

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('all passed');
