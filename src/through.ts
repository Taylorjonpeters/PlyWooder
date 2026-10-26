import { bbox, type BBox, type Region } from './geom';

/**
 * Through cuts: straight lines that run edge to edge across the sheet (or across a piece
 * already cut free) without touching any part. Splitting recursively gives the order you'd
 * break a sheet down with a track saw or table saw. Parts left sharing a piece with others
 * once no straight line separates them need a CNC or jigsaw.
 */

/** `offset`: distance in from the piece's left (vertical cut) or bottom (horizontal) edge. */
export type ThroughCut = {
  x1: number; y1: number; x2: number; y2: number;
  depth: number; label: string; vertical: boolean; offset: number; length: number;
};
export type ThroughPlan = { cuts: ThroughCut[]; freed: number; locked: string[] };

type Item = { key: string; bb: BBox };

export function throughCuts(parts: { key: string; regions: Region[] }[], w: number, h: number, kerf: number): ThroughPlan {
  const items: Item[] = parts.map((p) => ({ key: p.key, bb: bbox(p.regions.flatMap((r) => r.outer)) }));
  const cuts: ThroughCut[] = [];
  const locked: string[] = [];
  let freed = 0;
  let n = 0;

  // Free bands across x (vertical cuts) or y (horizontal cuts) between parts in a piece.
  const bands = (its: Item[], axis: 'x' | 'y') => {
    const lo = axis === 'x' ? 'minX' : 'minY', hi = axis === 'x' ? 'maxX' : 'maxY';
    const sorted = [...its].sort((a, b) => a.bb[lo] - b.bb[lo]);
    const out: number[] = [];
    let reach = sorted[0].bb[hi];
    for (const it of sorted.slice(1)) {
      // A gap of one kerf (shared cut) is enough; allow for float noise from compaction.
      if (it.bb[lo] - reach >= kerf - 0.05) out.push((reach + it.bb[lo]) / 2);
      reach = Math.max(reach, it.bb[hi]);
    }
    return out;
  };

  const split = (rect: BBox, its: Item[], depth: number) => {
    if (its.length <= 1) { freed += its.length; return; }
    const vx = bands(its, 'x'), hy = bands(its, 'y');
    if (!vx.length && !hy.length) { locked.push(...its.map((i) => i.key)); return; }
    // Take the direction that frees more pieces; on a tie, cut across the long side first.
    const rw = rect.maxX - rect.minX, rh = rect.maxY - rect.minY;
    const vertical = vx.length > hy.length || (vx.length === hy.length && rw >= rh);
    const at = vertical ? vx : hy;
    for (const c of at) {
      n++;
      cuts.push(vertical
        ? { x1: c, y1: rect.minY, x2: c, y2: rect.maxY, depth, label: String(n), vertical, offset: c - rect.minX, length: rh }
        : { x1: rect.minX, y1: c, x2: rect.maxX, y2: c, depth, label: String(n), vertical, offset: c - rect.minY, length: rw });
    }
    const edges = [vertical ? rect.minX : rect.minY, ...at, vertical ? rect.maxX : rect.maxY];
    for (let i = 0; i < edges.length - 1; i++) {
      const sub: BBox = vertical
        ? { minX: edges[i], maxX: edges[i + 1], minY: rect.minY, maxY: rect.maxY }
        : { minX: rect.minX, maxX: rect.maxX, minY: edges[i], maxY: edges[i + 1] };
      const inside = its.filter((it) => (vertical
        ? it.bb.minX >= sub.minX && it.bb.maxX <= sub.maxX
        : it.bb.minY >= sub.minY && it.bb.maxY <= sub.maxY));
      split(sub, inside, depth + 1);
    }
  };

  if (items.length) split({ minX: 0, minY: 0, maxX: w, maxY: h }, items, 0);
  return { cuts, freed, locked };
}
