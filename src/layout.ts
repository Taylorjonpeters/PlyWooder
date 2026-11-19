import { type Poly, type Pt, type Region, type Xform, applyXform, bbox } from './geom';
import type { Part } from './parts';
import type { NestItem, NestResult } from './nest';

/** Parts of one thickness are nested together on their own sheets. */
export type MaterialGroup = { thickness: number; items: NestItem[]; result?: NestResult };

export type PartChoice = { include: boolean; qty: number };

export function groupItems(parts: Part[], choices: Map<number, PartChoice>): MaterialGroup[] {
  const groups: MaterialGroup[] = [];
  for (const p of parts) {
    const c = choices.get(p.id);
    if (!c?.include || c.qty < 1) continue;
    // Treat thicknesses within 0.3 mm as the same stock (CAD export noise).
    let g = groups.find((q) => Math.abs(q.thickness - p.thickness) < 0.3);
    if (!g) { g = { thickness: Math.round(p.thickness * 100) / 100, items: [] }; groups.push(g); }
    for (let k = 0; k < c.qty; k++) {
      g.items.push({ key: `${p.id}#${k}`, partId: p.id, regions: p.regions, hull: p.hull, w: p.w, h: p.h, area: p.area });
    }
  }
  return groups.sort((a, b) => b.thickness - a.thickness);
}

/** What gets drawn and exported for one placed part, in sheet coordinates. */
export type PlacedShape = {
  key: string;
  part: Part;
  copy: number;
  xform: Xform;
  regions: Region[];
  pockets: { regions: Region[]; depth: number; side: 'top' | 'bottom' }[];
  label: { x: number; y: number; size: number };
};

/** Ray-casting point-in-polygon test. */
function inPoly(p: Pt, poly: Poly): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** True when `p` is on material: inside a region's outline and outside its holes. */
const onMaterial = (rs: Region[], p: Pt) => rs.some((r) => inPoly(p, r.outer) && !r.holes.some((h) => inPoly(p, h)));

/**
 * Where to write a part's name. The middle of the part when the text fits there; otherwise the
 * nearest spot (to the middle) where the whole text block stays on material and clear of every
 * hole, shrinking the text if need be. The block is the name plus the size line
 * under it, turned to run up the part when it is tall, exactly as the sheet drawing sets it.
 */
export function labelSpot(regions: Region[], name: string, size: number): { x: number; y: number; size: number } {
  const bb = bbox(regions.flatMap((r) => r.outer));
  const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
  const fallback = { x: cx, y: cy, size };
  const vertical = bb.maxY - bb.minY > (bb.maxX - bb.minX) * 1.25;
  const holes = regions.flatMap((r) => r.holes.map((h) => bbox(h)));
  if (!holes.length) return fallback;
  const N = 17;
  const spots: Pt[] = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    spots.push({ x: bb.minX + ((bb.maxX - bb.minX) * (i + 0.5)) / N, y: bb.minY + ((bb.maxY - bb.minY) * (j + 0.5)) / N });
  }
  spots.unshift({ x: cx, y: cy });
  spots.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
  // Down to 10, the smallest size the sheet drawing will use, before giving up.
  for (const scale of [1, 0.75, 0.55, 0.4, 0.28, 0.2]) {
    const sz = Math.max(10, size * scale);
    const along = (Math.max(name.length * 0.62, 4.5) * sz) / 2, across = sz * 1.4;
    const hx = vertical ? across : along, hy = vertical ? along : across;
    for (const c of spots) {
      if (holes.some((h) => c.x + hx > h.minX && c.x - hx < h.maxX && c.y + hy > h.minY && c.y - hy < h.maxY)) continue;
      let fits = true;
      for (let i = 0; i <= 4 && fits; i++) for (let j = 0; j <= 4 && fits; j++) {
        fits = onMaterial(regions, { x: c.x - hx + (hx * 2 * i) / 4, y: c.y - hy + (hy * 2 * j) / 4 });
      }
      if (fits) return { x: c.x, y: c.y, size: sz };
    }
  }
  return fallback;
}

const moveRegion = (r: Region, t: Xform): Region => ({ outer: applyXform(r.outer, t), holes: r.holes.map((h) => applyXform(h, t)) });

export function placedShapes(parts: Part[], placements: { key: string; partId: number; xform: Xform }[], shape: 'true' | 'hull'): PlacedShape[] {
  return placements.map((pl) => {
    const part = parts[pl.partId];
    const local: Region[] = shape === 'hull' ? [{ outer: part.hull, holes: [] }] : part.regions;
    const regions = local.map((r) => moveRegion(r, pl.xform));
    const pockets = shape === 'hull' ? [] : part.pockets.map((k) => ({ ...k, regions: k.regions.map((r) => moveRegion(r, pl.xform)) }));
    const copy = Number(pl.key.split('#')[1] ?? 0);
    return {
      key: pl.key,
      part,
      copy,
      xform: pl.xform,
      regions,
      pockets,
      label: labelSpot(regions, part.name + (copy ? ` #${copy + 1}` : ''), Math.max(12, Math.min(48, Math.min(part.w, part.h) / 6))),
    };
  });
}
