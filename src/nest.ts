import { cutNetwork, type CutNetwork } from './cutpaths';
import { type Poly, type Region, type Xform, offsetRegions, rotatePoly, bbox, applyXform } from './geom';

export type NestMode = 'optimal' | 'easy';
export type RotationRule = 'free90' | 'grain' | 'deg45' | 'deg15';
export type Effort = 'quick' | 'normal' | 'thorough';

export type NestSettings = {
  sheetW: number; // long side, laid along x
  sheetH: number;
  edgeMargin: number; // keep-out from factory edges
  kerf: number; // bit diameter or blade kerf
  errorGap: number; // extra safety gap between parts for human error
  shareCuts: boolean; // common-line cutting: neighbours sit exactly one bit apart and share a cut
  mode: NestMode;
  shape: 'true' | 'hull';
  rotation: RotationRule;
  effort: Effort;
};

export type NestItem = {
  key: string; // unique per instance
  partId: number;
  regions: Region[]; // true profile in part-local coords
  hull: Poly;
  w: number;
  h: number;
  area: number;
};

export type Placement = { key: string; partId: number; xform: Xform };
export type CutLine = { x1: number; y1: number; x2: number; y2: number; stage: 1 | 2 | 3; label: string };
export type SheetLayout = { placements: Placement[]; cuts: CutLine[]; steps: string[]; usedArea: number; network?: CutNetwork };
export type NestResult = { sheets: SheetLayout[]; unplaced: string[]; ms: number };

export const gapOf = (s: NestSettings) => s.kerf + (s.shareCuts ? 0 : s.errorGap);

const EFFORT = {
  quick: { ms: 700, res: 6 },
  normal: { ms: 2500, res: 4 },
  thorough: { ms: 9000, res: 2.5 },
};

function rotationsFor(rule: RotationRule): number[] {
  const steps = { free90: 4, grain: 2, deg45: 8, deg15: 24 }[rule];
  return Array.from({ length: steps }, (_, i) => (i * 2 * Math.PI) / steps);
}

/** Small seeded PRNG so a given input always produces the same layout. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function nest(items: NestItem[], s: NestSettings): NestResult {
  const t0 = performance.now();
  const res = s.mode === 'easy' ? nestGuillotine(items, s) : nestTrueShape(items, s);
  return { ...res, ms: performance.now() - t0 };
}

// ---------------------------------------------------------------------------
// True-shape nesting on a raster grid (bottom-left fill, with order search).
// Cells are marked conservatively, so parts never overlap by more than 0.
// ---------------------------------------------------------------------------

type Raster = { rot: number; cw: number; ch: number; runs: Int32Array; shiftX: number; shiftY: number; cells: number };

function rasterize(polys: Poly[], res: number, rot: number): Raster {
  const rp = polys.map((p) => rotatePoly(p, rot));
  const bb = bbox(rp.flat());
  const cw = Math.max(1, Math.ceil((bb.maxX - bb.minX) / res));
  const ch = Math.max(1, Math.ceil((bb.maxY - bb.minY) / res));
  const runs: number[] = [];
  let cells = 0;
  for (let j = 0; j < ch; j++) {
    const y = bb.minY + (j + 0.5) * res;
    const xs: { x: number; d: number }[] = [];
    for (const p of rp) {
      for (let i = 0, k = p.length - 1; i < p.length; k = i++) {
        const a = p[k], b = p[i];
        if ((a.y <= y) !== (b.y <= y)) {
          xs.push({ x: a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x), d: b.y > a.y ? 1 : -1 });
        }
      }
    }
    xs.sort((a, b) => a.x - b.x);
    let wind = 0;
    for (let i = 0; i < xs.length - 1; i++) {
      wind += xs[i].d;
      if (wind === 0) continue;
      const c0 = Math.max(0, Math.ceil((xs[i].x - bb.minX) / res - 0.5));
      const c1 = Math.min(cw - 1, Math.floor((xs[i + 1].x - bb.minX) / res - 0.5));
      if (c1 < c0) continue;
      const last = runs.length - 3;
      if (last >= 0 && runs[last] === j && runs[last + 1] + runs[last + 2] === c0) runs[last + 2] += c1 - c0 + 1;
      else runs.push(j, c0, c1 - c0 + 1);
      cells += c1 - c0 + 1;
    }
  }
  // Check long runs first: they fail fastest on a crowded sheet.
  const order = Array.from({ length: runs.length / 3 }, (_, i) => i).sort((a, b) => runs[b * 3 + 2] - runs[a * 3 + 2]);
  const sorted = new Int32Array(runs.length);
  order.forEach((o, i) => sorted.set(runs.slice(o * 3, o * 3 + 3), i * 3));
  return { rot, cw, ch, runs: sorted, shiftX: bb.minX, shiftY: bb.minY, cells };
}

class Grid {
  /** rf[y*W+x] = free cells to the right of (x, y), inclusive. */
  rf: Int32Array;
  used = 0;
  maxX = 0;
  constructor(public W: number, public H: number) {
    this.rf = new Int32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) this.rf[y * W + x] = W - x;
  }
  fits(r: Raster, gx: number, gy: number): boolean {
    const { runs } = r;
    for (let i = 0; i < runs.length; i += 3) {
      if (this.rf[(gy + runs[i]) * this.W + gx + runs[i + 1]] < runs[i + 2]) return false;
    }
    return true;
  }
  /** Leftmost, then lowest, position where the raster fits. */
  find(r: Raster): { gx: number; gy: number } | null {
    for (let gx = 0; gx + r.cw <= this.W; gx++) {
      for (let gy = 0; gy + r.ch <= this.H; gy++) if (this.fits(r, gx, gy)) return { gx, gy };
    }
    return null;
  }
  place(r: Raster, gx: number, gy: number) {
    const { W, rf } = this;
    const { runs } = r;
    const rows = new Set<number>();
    for (let i = 0; i < runs.length; i += 3) {
      const row = (gy + runs[i]) * W;
      for (let c = 0; c < runs[i + 2]; c++) rf[row + gx + runs[i + 1] + c] = 0;
      rows.add(gy + runs[i]);
    }
    for (const y of rows) {
      for (let x = W - 1; x >= 0; x--) if (rf[y * W + x] !== 0) rf[y * W + x] = x === W - 1 ? 1 : rf[y * W + x + 1] + 1;
    }
    this.used += r.cells;
    this.maxX = Math.max(this.maxX, gx + r.cw);
  }
}

function nestTrueShape(items: NestItem[], s: NestSettings) {
  const { ms, res } = EFFORT[s.effort];
  const gap = gapOf(s);
  // Usable region: parts keep `edgeMargin` from the sheet edge; their gap halo may reach into it.
  const inset = Math.max(0, s.edgeMargin - gap / 2);
  const W = Math.floor((s.sheetW - 2 * inset) / res);
  const H = Math.floor((s.sheetH - 2 * inset) / res);
  const rots = rotationsFor(s.rotation);

  // One raster set per distinct part (instances share geometry).
  const rasters = new Map<number, Raster[]>();
  for (const it of items) {
    if (rasters.has(it.partId)) continue;
    const shape = s.shape === 'hull' ? [{ outer: it.hull, holes: [] }] : it.regions;
    const grown = offsetRegions(shape, gap / 2 + res * 0.7072);
    rasters.set(it.partId, rots.map((r) => rasterize(grown, res, r)).filter((r) => r.cw <= W && r.ch <= H));
  }

  type Run = { sheets: { grid: Grid; placed: { item: NestItem; r: Raster; gx: number; gy: number }[] }[]; unplaced: NestItem[] };
  const run = (order: NestItem[]): Run => {
    const out: Run = { sheets: [], unplaced: [] };
    for (const item of order) {
      const rs = rasters.get(item.partId)!;
      if (!rs.length) { out.unplaced.push(item); continue; }
      let done = false;
      for (let si = 0; si <= out.sheets.length && !done; si++) {
        if (si === out.sheets.length) out.sheets.push({ grid: new Grid(W, H), placed: [] });
        const sh = out.sheets[si];
        let best: { r: Raster; gx: number; gy: number; score: number } | null = null;
        for (const r of rs) {
          const f = sh.grid.find(r);
          if (!f) continue;
          const score = (f.gx + r.cw) * 1e5 + f.gy + r.ch;
          if (!best || score < best.score) best = { r, ...f, score };
        }
        if (best) {
          sh.grid.place(best.r, best.gx, best.gy);
          sh.placed.push({ item, r: best.r, gx: best.gx, gy: best.gy });
          done = true;
        } else if (!sh.placed.length) {
          out.sheets.pop();
          out.unplaced.push(item);
          done = true;
        }
      }
    }
    return out;
  };
  const cost = (r: Run) =>
    r.unplaced.length * 1e15 + r.sheets.length * 1e9 + (r.sheets.at(-1)?.grid.maxX ?? 0) * 1e3 - (r.sheets[0]?.grid.used ?? 0) / 1e6;

  const byArea = [...items].sort((a, b) => b.area - a.area);
  const seeds = [
    byArea,
    [...items].sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h)),
    [...items].sort((a, b) => b.w * b.h - a.w * a.h),
    [...items].sort((a, b) => Math.min(b.w, b.h) - Math.min(a.w, a.h)),
  ];
  // Keep a pool of the best distinct layouts; the final pick among them also weighs the cutting.
  const pool = new Map<number, { order: NestItem[]; run: Run; cost: number }>();
  const consider = (order: NestItem[], r: Run) => {
    const c = cost(r);
    if (pool.has(c)) return;
    pool.set(c, { order, run: r, cost: c });
    if (pool.size > 10) pool.delete(Math.max(...pool.keys()));
  };
  let bestOrder = seeds[0];
  let best = run(bestOrder);
  consider(bestOrder, best);
  for (const o of seeds.slice(1)) {
    const r = run(o);
    consider(o, r);
    if (cost(r) < cost(best)) { best = r; bestOrder = o; }
  }
  // Local search: swap or re-insert parts in the order while time allows.
  const rand = rng(items.length * 7919 + Math.round(s.sheetW));
  const t0 = performance.now();
  while (items.length > 1 && performance.now() - t0 < ms) {
    const o = [...bestOrder];
    const i = Math.floor(rand() * o.length);
    const j = Math.floor(rand() * o.length);
    if (rand() < 0.5) [o[i], o[j]] = [o[j], o[i]];
    else o.splice(j, 0, ...o.splice(i, 1));
    const r = run(o);
    consider(o, r);
    if (cost(r) <= cost(best)) { best = r; bestOrder = o; }
  }

  const build = (r: Run): SheetLayout[] => r.sheets.map((sh) => {
    const placements = sh.placed.map(({ item, r, gx, gy }) => ({
      key: item.key,
      partId: item.partId,
      xform: { rot: r.rot, tx: inset + gx * res - r.shiftX, ty: inset + gy * res - r.shiftY },
    }));
    const shapes = new Map(sh.placed.map(({ item }) => [item.key, s.shape === 'hull' ? [{ outer: item.hull, holes: [] }] : item.regions]));
    compact(placements, shapes, gap, s.edgeMargin);
    const cutShapes = sh.placed.map(({ item }, k) => item.regions.map((g) => ({
      outer: applyXform(g.outer, placements[k].xform), holes: g.holes.map((hh) => applyXform(hh, placements[k].xform)),
    })));
    const net = cutNetwork(cutShapes, s.kerf, s.sheetW, s.sheetH, s.edgeMargin);
    return { cuts: [], steps: [], usedArea: sh.placed.reduce((a, p) => a + p.item.area, 0), placements, network: net };
  });
  // Same sheet count and unplaced parts as the best: fewest plunges, then least cutting.
  const sheetsKey = (r: Run) => r.unplaced.length * 1000 + r.sheets.length;
  let pick: SheetLayout[] | null = null, pickScore = Infinity, pickRun = best;
  for (const cand of [...pool.values()].filter((c) => sheetsKey(c.run) === sheetsKey(best)).sort((a, b) => a.cost - b.cost)) {
    const sheets = build(cand.run);
    const score = sheets.reduce((a, sh) => a + sh.network!.plunges * 5000 + sh.network!.length, 0);
    if (score < pickScore) { pick = sheets; pickScore = score; pickRun = cand.run; }
  }
  return { sheets: pick ?? build(best), unplaced: pickRun.unplaced.map((u) => u.key) };
}

/**
 * Exact compaction after the grid pass: slide every part left, then down, until it is exactly
 * `gap` from a neighbour or `margin` from the sheet edge. The grid leaves parts up to one cell
 * apart; closing that up makes straight edges line up one bit apart, so they can share a cut.
 */
function compact(placements: Placement[], shapes: Map<string, Region[]>, gap: number, margin: number) {
  type Body = { pl: Placement; actual: Poly[]; grown: Poly[] };
  const bodies: Body[] = placements.map((pl) => {
    const local = shapes.get(pl.key)!;
    return {
      pl,
      // Holes count as edges too: a part nested in another's hole must stay inside it.
      actual: local.flatMap((r) => [r.outer, ...r.holes]).map((p) => applyXform(p, pl.xform)),
      grown: offsetRegions(local, gap).map((p) => applyXform(p, pl.xform)),
    };
  });
  const move = (b: Body, dx: number, dy: number) => {
    const sh = (ps: Poly[]) => ps.map((p) => p.map((q) => ({ x: q.x + dx, y: q.y + dy })));
    b.actual = sh(b.actual);
    b.grown = sh(b.grown);
    b.pl.xform = { ...b.pl.xform, tx: b.pl.xform.tx + dx, ty: b.pl.xform.ty + dy };
  };
  for (let pass = 0; pass < 4; pass++) {
    let moved = 0;
    for (const [axis, d] of [['x', { x: -1, y: 0 }], ['y', { x: 0, y: -1 }]] as const) {
      const lo = (b: Body) => bbox(b.actual.flat())[axis === 'x' ? 'minX' : 'minY'];
      const order = [...bodies].sort((p, q) => lo(p) - lo(q));
      for (const b of order) {
        let dist = Math.max(0, lo(b) - margin);
        const gb = bbox(b.grown.flat());
        for (const o of bodies) {
          if (o === b || dist < 1e-3) continue;
          const ob = bbox(o.actual.flat());
          // Only parts in the swept band can block the move.
          if (axis === 'x' ? (ob.maxY < gb.minY || ob.minY > gb.maxY || ob.minX > gb.maxX) : (ob.maxX < gb.minX || ob.minX > gb.maxX || ob.minY > gb.maxY)) continue;
          dist = Math.min(dist, slideDistance(b.grown, o.actual, d.x, d.y));
        }
        if (dist > 1e-3) { move(b, d.x * dist, d.y * dist); moved += dist; }
      }
    }
    if (moved < 0.01) break;
  }
}

const crossP = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;

/** How far `mov` can travel along unit (dx, dy) before touching `obs`. */
function slideDistance(mov: Poly[], obs: Poly[], dx: number, dy: number): number {
  let best = Infinity;
  const cast = (pts: Poly[], edges: Poly[], sx: number, sy: number) => {
    for (const poly of edges) {
      for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
        const a = poly[k], b = poly[i];
        const ex = b.x - a.x, ey = b.y - a.y;
        const den = crossP(sx, sy, ex, ey);
        if (Math.abs(den) < 1e-12) continue;
        for (const ps of pts) for (const p of ps) {
          const t = crossP(a.x - p.x, a.y - p.y, ex, ey) / den;
          if (t < -1e-6 || t >= best) continue;
          const u = crossP(a.x - p.x, a.y - p.y, sx, sy) / den;
          if (u >= -1e-9 && u <= 1 + 1e-9) best = Math.max(0, t);
        }
      }
    }
  };
  cast(mov, obs, dx, dy);
  cast(obs, mov, -dx, -dy);
  return best;
}

// ---------------------------------------------------------------------------
// "Easiest to cut": 3-stage guillotine layout of bounding rectangles.
//   1. crosscut the sheet into strips across its length
//   2. rip each strip into rows
//   3. crosscut rows into parts
// Every cut runs edge-to-edge of the piece in hand, so a track saw or table saw works.
// ---------------------------------------------------------------------------

type GRow = { y: number; h: number; usedW: number; items: { item: NestItem; x: number; rotated: boolean; iw: number; ih: number }[] };
type GStrip = { x: number; w: number; usedH: number; rows: GRow[] };
type GSheet = { strips: GStrip[]; usedW: number };

function nestGuillotine(items: NestItem[], s: NestSettings) {
  const gap = gapOf(s);
  const e = s.edgeMargin;
  const UW = s.sheetW - 2 * e;
  const UH = s.sheetH - 2 * e;
  const canRotate = s.rotation !== 'grain';
  const orients = (it: NestItem) => (canRotate && Math.abs(it.w - it.h) > 0.01
    ? [{ iw: it.w, ih: it.h, rotated: false }, { iw: it.h, ih: it.w, rotated: true }]
    : [{ iw: it.w, ih: it.h, rotated: false }]);

  const pack = (order: NestItem[], wideStrips: boolean) => {
    const sheets: GSheet[] = [];
    const unplaced: NestItem[] = [];
    for (const it of order) {
      const os = orients(it).filter((o) => o.iw <= UW && o.ih <= UH);
      if (!os.length) { unplaced.push(it); continue; }
      let placed = false;
      // 1) Into an existing row (row height already fixed by a taller neighbour).
      outer: for (const sh of sheets) for (const st of sh.strips) for (const row of st.rows) {
        for (const o of os) {
          const x = row.usedW ? row.usedW + gap : 0;
          if (o.ih <= row.h && x + o.iw <= st.w) {
            row.items.push({ item: it, x, ...o });
            row.usedW = x + o.iw;
            placed = true;
            break outer;
          }
        }
      }
      // 2) A new row in an existing strip.
      if (!placed) {
        outer2: for (const sh of sheets) for (const st of sh.strips) {
          const y = st.usedH ? st.usedH + gap : 0;
          const fits = os.filter((o) => o.iw <= st.w && y + o.ih <= UH).sort((a, b) => b.iw - a.iw);
          if (fits.length) {
            const o = fits[0];
            st.rows.push({ y, h: o.ih, usedW: o.iw, items: [{ item: it, x: 0, ...o }] });
            st.usedH = y + o.ih;
            placed = true;
            break outer2;
          }
        }
      }
      // 3) A new strip on the first sheet with room, else a new sheet.
      if (!placed) {
        const o = [...os].sort((a, b) => (wideStrips ? b.iw - a.iw : a.iw - b.iw))[0];
        let sh = sheets.find((q) => q.usedW + gap + o.iw <= UW);
        if (!sh) { sh = { strips: [], usedW: 0 }; sheets.push(sh); }
        const x = sh.strips.length ? sh.usedW + gap : 0;
        sh.strips.push({ x, w: o.iw, usedH: o.ih, rows: [{ y: 0, h: o.ih, usedW: o.iw, items: [{ item: it, x: 0, ...o }] }] });
        sh.usedW = x + o.iw;
      }
    }
    return { sheets, unplaced };
  };

  const orders = [
    [...items].sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h)),
    [...items].sort((a, b) => b.w * b.h - a.w * a.h),
    [...items].sort((a, b) => Math.min(b.w, b.h) - Math.min(a.w, a.h)),
  ];
  let best: ReturnType<typeof pack> | null = null;
  const cost = (r: ReturnType<typeof pack>) => r.unplaced.length * 1e12 + r.sheets.length * 1e7 + (r.sheets.at(-1)?.usedW ?? 0);
  for (const o of orders) for (const wide of [true, false]) {
    const r = pack(o, wide);
    if (!best || cost(r) < cost(best)) best = r;
  }
  const result = best!;

  const fmt = (v: number) => `${Math.round(v * 10) / 10}`;
  const sheets: SheetLayout[] = result.sheets.map((sh) => {
    const placements: Placement[] = [];
    const cuts: CutLine[] = [];
    const steps: string[] = [];
    let usedArea = 0;
    sh.strips.forEach((st, si) => {
      const sx = e + st.x;
      const strip = String.fromCharCode(65 + si);
      // Cut on the far side of each strip (centre of the kerf gap), except a strip ending at the sheet edge.
      const cutX = sx + st.w + gap / 2;
      if (cutX < s.sheetW - 0.5) {
        cuts.push({ x1: cutX, y1: 0, x2: cutX, y2: s.sheetH, stage: 1, label: strip });
        steps.push(`Crosscut strip ${strip}: ${fmt(st.w)} wide (line at ${fmt(cutX)} from the left edge).`);
      }
      st.rows.forEach((row, ri) => {
        const ry = e + row.y;
        const cutY = ry + row.h + gap / 2;
        const rowName = `${strip}${ri + 1}`;
        if (cutY < s.sheetH - 0.5) {
          cuts.push({ x1: sx - gap / 2, y1: cutY, x2: sx + st.w + gap / 2, y2: cutY, stage: 2, label: rowName });
        }
        steps.push(`  Rip row ${rowName} from strip ${strip}: ${fmt(row.h)} deep.`);
        row.items.forEach((pi, k) => {
          const x = sx + pi.x;
          if (k < row.items.length - 1 || pi.x + pi.iw < st.w - 0.5) {
            const cx = x + pi.iw + gap / 2;
            cuts.push({ x1: cx, y1: ry - gap / 2, x2: cx, y2: ry + row.h + gap / 2, stage: 3, label: '' });
          }
          placements.push({
            key: pi.item.key,
            partId: pi.item.partId,
            xform: pi.rotated ? { rot: Math.PI / 2, tx: x + pi.item.h, ty: ry } : { rot: 0, tx: x, ty: ry },
          });
          usedArea += pi.item.area;
        });
        if (row.items.length > 1 || row.usedW < st.w - 0.5) steps.push(`    Crosscut row ${rowName} into ${row.items.length} part${row.items.length > 1 ? 's' : ''}.`);
      });
    });
    const byKey = new Map(items.map((it) => [it.key, it]));
    const network = cutNetwork(placements.map((pl) => byKey.get(pl.key)!.regions.map((g) => ({
      outer: applyXform(g.outer, pl.xform), holes: g.holes.map((hh) => applyXform(hh, pl.xform)),
    }))), s.kerf, s.sheetW, s.sheetH, s.edgeMargin);
    return { placements, cuts, steps, usedArea, network };
  });
  return { sheets, unplaced: result.unplaced.map((u) => u.key) };
}
