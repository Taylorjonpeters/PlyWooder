import { type Region, type Xform, applyXform, bbox } from './geom';
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

const moveRegion = (r: Region, t: Xform): Region => ({ outer: applyXform(r.outer, t), holes: r.holes.map((h) => applyXform(h, t)) });

export function placedShapes(parts: Part[], placements: { key: string; partId: number; xform: Xform }[], shape: 'true' | 'hull'): PlacedShape[] {
  return placements.map((pl) => {
    const part = parts[pl.partId];
    const local: Region[] = shape === 'hull' ? [{ outer: part.hull, holes: [] }] : part.regions;
    const regions = local.map((r) => moveRegion(r, pl.xform));
    const pockets = shape === 'hull' ? [] : part.pockets.map((k) => ({ ...k, regions: k.regions.map((r) => moveRegion(r, pl.xform)) }));
    const bb = bbox(regions.flatMap((r) => r.outer));
    return {
      key: pl.key,
      part,
      copy: Number(pl.key.split('#')[1] ?? 0),
      xform: pl.xform,
      regions,
      pockets,
      label: { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2, size: Math.max(12, Math.min(48, Math.min(part.w, part.h) / 6)) },
    };
  });
}
