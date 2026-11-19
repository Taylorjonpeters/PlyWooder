import { type Pt, type Poly, type Region, area, bbox, offsetRegions, subtract } from './geom';
import { cutNetwork } from './cutpaths';
import type { PlacedShape } from './layout';
import { strokeText, textWidth } from './font';

/**
 * Toolpaths for one sheet, as machine-neutral moves grouped into files (src/gcode.ts writes them
 * out in a machine's dialect).
 *
 * A sheet is cut as a sequence of operations:
 *   labels   part names marked with the laser, while the sheet is whole
 *   pockets  partial-depth clearing, while the parts are still held by the sheet
 *   holes    through holes and slots, one closed loop each, before the part around them is freed
 *   outlines the merged outline network (shared edges cut once), last
 * Consecutive operations on the same bit share a file; a bit change starts a new file, since the
 * GORDIX has no tool changer and Z has to be re-zeroed after a swap.
 *
 * Fit allowance and dogbones change the part shapes before any toolpath is made, so every
 * operation follows them.
 */

export type Tool = {
  id: string;
  name: string;
  diameter: number;
  /** Cutting feed, mm/min. */
  feed: number;
  /** Plunge feed, mm/min. Ramps run at the cutting feed. */
  plungeFeed: number;
  /** Max depth per pass, mm. */
  depthPerPass: number;
};

export type MachineId = 'gordix' | 'grbl';

export type CamSettings = {
  machine: MachineId;
  origin: 'center' | 'corner';
  /** The GORDIX's tables, as in GORDIX Studio's table.cfg. The table sets how far the machine reaches. */
  tables: GordixTable[];
  tableId: number;
  /** Name of the table.cfg the tables came from; empty for Studio's defaults. */
  tablesFile: string;
  /** Spindle speed for GRBL machines (M3). 0 leaves it out. */
  rpm: number;
  tools: Tool[];
  pocketTool: string;
  holeTool: string;
  outlineTool: string;
  /** Measured stock thickness by nominal thickness (key: nominal.toFixed(2)), mm. */
  stockActual: Record<string, number>;
  /** Every slot, hole and pocket gets this much wider; every tab and outline this much narrower. */
  fitAllowance: number;
  dogbones: boolean;
  /** Cut this far below the material so parts come free, mm. */
  throughExtra: number;
  safeZ: number;
  /** Pocket stepover as a fraction of the bit width. */
  stepover: number;
  ramp: boolean;
  /** Ramp angle from horizontal, degrees. */
  rampAngle: number;
  tabs: boolean;
  tabsOnHoles: boolean;
  tabHeight: number;
  tabWidth: number;
  /** Target distance between tabs along a pass, mm. */
  tabSpacing: number;
  labels: boolean;
  labelHeight: number;
  laserFeed: number;
  /** Laser power, percent (GRBL only; the GORDIX laser is on/off). */
  laserPower: number;
  /** Raise the whole job by this much for a dry run; 0 is a real cut. */
  airCut: number;
};

export const DEFAULT_TOOLS: Tool[] = [
  { id: 'flat-6.35', name: '1/4" flat end mill', diameter: 6.35, feed: 1000, plungeFeed: 300, depthPerPass: 3 },
  { id: 'flat-3.175', name: '1/8" flat end mill', diameter: 3.175, feed: 800, plungeFeed: 250, depthPerPass: 1.5 },
];

/**
 * Feeds, safe height and tab size follow GORDIX Studio's defaults; depth per pass follows the GORDIX
 * guide (3–5 mm in wood). Ramping starts off because Studio plunges straight down, and its G-code
 * editor reads the step-down from the two shallowest depths, which a ramp blurs.
 */
export const CAM_DEFAULTS: CamSettings = {
  machine: 'gordix', origin: 'center', tables: [], tableId: 1, tablesFile: '', rpm: 12000,
  tools: DEFAULT_TOOLS, pocketTool: 'flat-6.35', holeTool: 'flat-6.35', outlineTool: 'flat-6.35',
  stockActual: {}, fitAllowance: 0, dogbones: false,
  throughExtra: 0.5, safeZ: 2, stepover: 0.4, ramp: false, rampAngle: 10,
  tabs: true, tabsOnHoles: true, tabHeight: 3, tabWidth: 5, tabSpacing: 400,
  labels: false, labelHeight: 12, laserFeed: 1000, laserPower: 60, airCut: 0,
};

export type OpKind = 'label' | 'pocket' | 'hole' | 'outline';
export const OP_ORDER: OpKind[] = ['label', 'pocket', 'hole', 'outline'];

/** One straight move in sheet coordinates (lower-left origin). Laser moves keep z at 0. */
export type Move = { rapid: boolean; x: number; y: number; z: number; f: number; op: OpKind; laser?: boolean; tab?: boolean };

export type CamFile = {
  kind: 'router' | 'laser';
  /** The router bit; absent for laser files. */
  tool?: Tool;
  ops: OpKind[];
  moves: Move[];
};

export type CamSheet = {
  w: number;
  h: number;
  /** Nominal stock thickness, mm. */
  thickness: number;
  /** The bit width the layout was packed for, mm. */
  kerf: number;
  edgeMargin: number;
  /** Placed parts with their true shapes. */
  shapes: PlacedShape[];
  title: string;
};

export type CamJob = {
  files: CamFile[];
  warnings: string[];
  /** Stock thickness used for depths (measured, or nominal), mm. */
  stock: number;
  cutDepth: number;
  /** The part shapes after fit allowance and dogbones, for the preview. */
  parts: Region[][];
};

export const stockKey = (t: number) => t.toFixed(2);

/**
 * One GORDIX table as GORDIX Studio's table setup page stores it (table.cfg): the four measured
 * sides, the diagonal, and the X/Y calibration factors. S runs along the machine's X axis and W
 * along its Y axis.
 */
export type GordixTable = { id: number; E: number; S: number; W: number; N: number; D: number; X: number; Y: number };

/** GORDIX Studio's default tables (table_conf.html). */
/** The names the UI uses for each machine, so the layout sidebar and the G-code sidebar read the same. */
export const MACHINE_LABELS = { gordix: 'GORDIX', grbl: 'Other CNC (GRBL or DXF to CAM)' } as const;

export const STUDIO_TABLES: GordixTable[] = [
  { id: 1, E: 1460, S: 2560, W: 1460, N: 2560, D: 2947, X: 1, Y: 1 },
  { id: 2, E: 1460, S: 1340, W: 1460, N: 1340, D: 1982, X: 1, Y: 1 },
  { id: 3, E: 1440, S: 1320, W: 1440, N: 1320, D: 1953, X: 1, Y: 1 },
  { id: 4, E: 840, S: 1320, W: 840, N: 1320, D: 1565, X: 1, Y: 1 },
  { id: 5, E: 840, S: 720, W: 840, N: 720, D: 1106, X: 1, Y: 1 },
];

/**
 * Read a GORDIX table.cfg (`TABLE<n><E|S|W|N|D|X|Y> <value>` lines). Values are clamped the way
 * Studio clamps them: sides to 600–2600 mm, the diagonal to 2990 mm. Tables the file leaves out
 * keep Studio's defaults.
 */
export function parseTableCfg(text: string): GordixTable[] {
  const tables = STUDIO_TABLES.map((t) => ({ ...t }));
  let found = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^TABLE(\d+)([ESWNDXY])\s+([\d.]+)/i);
    if (!m) continue;
    const t = tables.find((q) => q.id === Number(m[1]));
    if (!t) continue;
    const key = m[2].toUpperCase() as 'E' | 'S' | 'W' | 'N' | 'D' | 'X' | 'Y';
    let v = parseFloat(m[3]);
    if (!Number.isFinite(v)) continue;
    if ('ESWN'.includes(key)) v = Math.min(2600, Math.max(600, v));
    else if (key === 'D') v = Math.min(2990, v);
    t[key] = v;
    found++;
  }
  if (!found) throw new Error("This isn't a GORDIX table.cfg: it has no TABLE lines.");
  return tables;
}

/**
 * Half-ranges of the GORDIX work area on a table, along the machine's X (side S) and Y (side W),
 * centred on the origin. Same formula as Studio's table setup page.
 */
export const gordixRange = (S: number, W: number) => {
  const tan15 = Math.tan((15 * Math.PI) / 180);
  const x = Math.min(100 + S / 2 - ((W - 240) / 2) * tan15, S / 2 - 140);
  const y = Math.min(100 + W / 2 - ((S - 240) / 2) * tan15, W / 2 - 140);
  return { x: Math.round(x), y: Math.round(y) };
};

/** The selected table, or Studio's first default. */
export const currentTable = (cfg: CamSettings): GordixTable =>
  (cfg.tables.length ? cfg.tables : STUDIO_TABLES).find((t) => t.id === cfg.tableId) ?? (cfg.tables[0] ?? STUDIO_TABLES[0]);

/**
 * How a sheet sits in the work area of a table. PlyWooder lays sheets out with the long side on
 * X, so when the machine's X range is the shorter one the sheet is turned 90° (`rotate`) and its
 * long side runs along the machine's Y axis. `x`/`y` are half-ranges along the sheet's own axes.
 */
export function gordixFit(t: GordixTable) {
  const r = gordixRange(t.S, t.W);
  const rotate = r.x < r.y;
  return { rotate, x: rotate ? r.y : r.x, y: rotate ? r.x : r.y, machine: r };
}

export const GORDIX_Z_TRAVEL = 30;

const toolById = (cfg: CamSettings, id: string): Tool => cfg.tools.find((t) => t.id === id) ?? cfg.tools[0] ?? DEFAULT_TOOLS[0];

const pathLength = (p: Pt[]) => p.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - p[i].x, q.y - p[i].y), 0);
const ccw = (p: Poly) => (area(p) >= 0 ? p : [...p].reverse());
const cw = (p: Poly) => (area(p) <= 0 ? p : [...p].reverse());
const circle = (c: Pt, r: number, n = 32): Poly => Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos((2 * Math.PI * i) / n), y: c.y + r * Math.sin((2 * Math.PI * i) / n) }));

/** Turns of at least this much are corners a round bit can't reach; smaller ones are curve facets. */
const CORNER_TURN = (45 * Math.PI) / 180;
/** Extra radius on relief holes so the offset toolpath reaches into them instead of pinching shut. */
const RELIEF_EXTRA = 0.25;

/**
 * Dogbone relief circles for a closed polygon whose material lies on its left. At each corner
 * where the boundary turns right (an inside corner of the material), a round bit leaves a fillet;
 * a circle centred one radius from the corner, on the empty side, lets the bit reach the corner.
 */
function reliefCircles(p: Poly, r: number): Poly[] {
  const out: Poly[] = [];
  const nrm = (a: Pt, b: Pt) => { const l = Math.hypot(b.x - a.x, b.y - a.y) || 1; return { x: (b.y - a.y) / l, y: -(b.x - a.x) / l }; };
  for (let i = 0; i < p.length; i++) {
    const a = p[(i - 1 + p.length) % p.length], v = p[i], b = p[(i + 1) % p.length];
    const d1 = { x: v.x - a.x, y: v.y - a.y }, d2 = { x: b.x - v.x, y: b.y - v.y };
    const l1 = Math.hypot(d1.x, d1.y), l2 = Math.hypot(d2.x, d2.y);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const cross = (d1.x * d2.y - d1.y * d2.x) / (l1 * l2);
    const turn = Math.atan2(cross, (d1.x * d2.x + d1.y * d2.y) / (l1 * l2));
    if (turn > -CORNER_TURN) continue; // not a right turn of 45° or more
    // Right-hand normals point to the empty side; their sum bisects the empty wedge.
    const n1 = nrm(a, v), n2 = nrm(v, b);
    const u = { x: n1.x + n2.x, y: n1.y + n2.y };
    const ul = Math.hypot(u.x, u.y) || 1;
    out.push(circle({ x: v.x + (u.x / ul) * r, y: v.y + (u.y / ul) * r }, r + RELIEF_EXTRA));
  }
  return out;
}

/**
 * Regions from oriented polygons (outers counter-clockwise, holes clockwise), as offsetRegions
 * returns them. unionAll can't be used here: it reorients every polygon, which fills the holes.
 */
const rebuild = (polys: Poly[]): Region[] =>
  subtract(polys.filter((p) => p.length >= 3 && area(p) > 0), polys.filter((p) => p.length >= 3 && area(p) < 0).map(ccw));

/** Apply fit allowance and dogbones to one part's material. */
function shapePart(regions: Region[], cfg: CamSettings, rOut: number, rHole: number): Region[] {
  let rs = regions;
  if (Math.abs(cfg.fitAllowance) > 1e-6) rs = rebuild(offsetRegions(rs, -cfg.fitAllowance / 2));
  if (cfg.dogbones) {
    const cuts = rs.flatMap((r) => [
      ...reliefCircles(ccw(r.outer), rOut),
      ...r.holes.flatMap((h) => reliefCircles(cw(h), rHole)),
    ]);
    if (cuts.length) rs = subtract(rs.flatMap((r) => [ccw(r.outer), ...r.holes.map(cw)]), cuts);
  }
  return rs;
}

/** Apply fit allowance and dogbones to a pocket (empty space, so the material is on the right). */
function shapePocket(regions: Region[], cfg: CamSettings, r: number): Region[] {
  let rs = regions;
  if (Math.abs(cfg.fitAllowance) > 1e-6) rs = rebuild(offsetRegions(rs, cfg.fitAllowance / 2));
  if (cfg.dogbones) {
    // Reversing the pocket outline puts its material on the left, so the same rule finds its corners.
    const add = rs.flatMap((q) => reliefCircles(cw(q.outer), r));
    if (add.length) rs = rebuild([...rs.flatMap((q) => [ccw(q.outer), ...q.holes.map(cw)]), ...add.map(ccw)]);
  }
  return rs;
}

/** Points along `path` from its start for distance `d` (the last one interpolated). */
function walk(path: Pt[], d: number): Pt[] {
  const out = [path[0]];
  let s = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (s + L >= d) {
      const t = L > 0 ? (d - s) / L : 0;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      return out;
    }
    out.push(b);
    s += L;
  }
  return out;
}

/** Equal steps down to `depth`, none deeper than `perPass`. */
const levels = (depth: number, perPass: number) => {
  const k = Math.max(1, Math.ceil(depth / Math.max(0.1, perPass) - 1e-9));
  return Array.from({ length: k }, (_, i) => -(depth * (i + 1)) / k);
};

/**
 * Steps of `grid` down to `depth`, ending exactly at it. Pockets use the through cuts' step so the
 * whole file shares one depth grid, which is how Studio's editor reads the step-down.
 */
const gridLevels = (depth: number, grid: number) => {
  const out: number[] = [];
  for (let z = grid; z < depth - 0.05; z += grid) out.push(-z);
  return [...out, -depth];
};

/**
 * Tab intervals [start, end] by distance along a pass, spread evenly between `margin` and
 * L − margin so they stay clear of the ramps at either end.
 */
function tabZones(L: number, cfg: CamSettings, bit: number, margin: number): [number, number][] {
  // The tool centre has to lift a bit-width early, so the material left standing is tabWidth.
  const w = cfg.tabWidth + bit;
  const span = L - 2 * margin;
  if (span < w * 2 || L < w * 4) return [];
  const count = Math.max(1, Math.round(L / Math.max(w * 4, cfg.tabSpacing)));
  return Array.from({ length: count }, (_, i) => {
    const c = margin + (span * (i + 0.5)) / count;
    return [c - w / 2, c + w / 2] as [number, number];
  });
}

/** Builds the move list for one router file. */
function routerWriter(tool: Tool, cfg: CamSettings) {
  const moves: Move[] = [];
  const safe = Math.max(0.5, cfg.safeZ);
  const cur = { x: NaN, y: NaN, z: safe };
  const push = (m: Omit<Move, 'f'> & { f?: number }) => { moves.push({ f: 0, ...m }); cur.x = m.x; cur.y = m.y; cur.z = m.z; };
  const at = (p: Pt) => Math.hypot(p.x - cur.x, p.y - cur.y) < 1e-3;

  const rapidTo = (p: Pt, op: OpKind) => {
    if (at(p)) return;
    if (cur.z < safe - 1e-6) push({ rapid: true, x: cur.x, y: cur.y, z: safe, op });
    push({ rapid: true, x: p.x, y: p.y, z: safe, op });
  };
  const zTo = (z: number, op: OpKind, tab?: boolean) => {
    if (Math.abs(z - cur.z) < 1e-4) return;
    push({ rapid: false, x: cur.x, y: cur.y, z, f: tool.plungeFeed, op, tab });
  };
  const feedTo = (p: Pt, z: number, op: OpKind, tab?: boolean) => {
    if (at(p) && Math.abs(z - cur.z) < 1e-4) return;
    push({ rapid: false, x: p.x, y: p.y, z, f: tool.feed, op, tab });
  };
  /** Longest ramp for one pass of this bit: the step down split over a there-and-back run. */
  const rampLength = (dz: number) => (cfg.ramp ? dz / 2 / Math.tan((Math.max(1, Math.min(45, cfg.rampAngle)) * Math.PI) / 180) : 0);

  /**
   * One pass along `path` at depth `z`, starting from the already-cut level `from`. Ramps in by
   * running forward and back along the path, so no partial-depth stretch is left behind.
   */
  const pass = (path: Pt[], z: number, from: number, op: OpKind, tabs: [number, number][], tabTop: number) => {
    if (!at(path[0])) { rapidTo(path[0], op); }
    if (cur.z > from) zTo(from, op);
    const L = pathLength(path);
    const dz = cur.z - z;
    let ramp = Math.min(rampLength(dz), L * 0.45);
    if (tabs.length) ramp = Math.min(ramp, tabs[0][0]);
    if (dz > 1e-4 && ramp > 0.5) {
      const zMid = cur.z - dz / 2, z0 = cur.z;
      const out = walk(path, ramp);
      let s = 0;
      for (let i = 1; i < out.length; i++) {
        s += Math.hypot(out[i].x - out[i - 1].x, out[i].y - out[i - 1].y);
        push({ rapid: false, x: out[i].x, y: out[i].y, z: z0 - (z0 - zMid) * (s / ramp), f: tool.feed, op });
      }
      const back = [...out].reverse();
      s = 0;
      for (let i = 1; i < back.length; i++) {
        s += Math.hypot(back[i].x - back[i - 1].x, back[i].y - back[i - 1].y);
        push({ rapid: false, x: back[i].x, y: back[i].y, z: zMid - (zMid - z) * (s / ramp), f: tool.feed, op });
      }
    }
    const inTab = (d: number) => z < tabTop && tabs.some(([a, b]) => d > a && d < b);
    const zAt = (d: number) => (inTab(d) ? tabTop : z);
    zTo(zAt(1e-6), op, inTab(1e-6));
    const marks = tabs.flat();
    let s = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const segL = Math.hypot(b.x - a.x, b.y - a.y);
      // Split at every tab edge so the lift happens exactly there.
      const cuts = marks.filter((m) => m > s + 1e-6 && m < s + segL - 1e-6).sort((p, q) => p - q);
      for (const m of [...cuts, s + segL]) {
        const t = segL > 0 ? (m - s) / segL : 1;
        const mid = m - (segL > 0 ? Math.min(1e-3, (m - s) / 2) : 0);
        feedTo({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, cur.z, op, inTab(mid));
        zTo(zAt(m + 1e-6), op, inTab(m + 1e-6));
      }
      s += segL;
    }
  };

  /** All passes of one path down to `depth`; open paths zig-zag so the bit never lifts between depths. */
  const cutPath = (pts: Pt[], closed: boolean, depth: number, op: OpKind, tabTop: number, withTabs: boolean, grid?: number) => {
    if (pts.length < 2) return;
    const lv = grid ? gridLevels(depth, grid) : levels(depth, tool.depthPerPass);
    const L = pathLength(pts);
    const tabs = withTabs ? tabZones(L, cfg, tool.diameter, rampLength(depth / lv.length)) : [];
    let forward = true, from = 0;
    for (const z of lv) {
      const path = forward || closed ? pts : [...pts].reverse();
      const zones = forward || closed ? tabs : tabs.map(([a, b]) => [L - b, L - a] as [number, number]).reverse();
      pass(path, z, from, op, zones, tabTop);
      from = z;
      if (!closed) forward = !forward;
    }
  };

  const finish = () => { if (moves.length && cur.z < safe) push({ rapid: true, x: cur.x, y: cur.y, z: safe, op: moves[moves.length - 1].op }); return moves; };
  return { cutPath, finish, get pos() { return { x: cur.x, y: cur.y }; } };
}

/** Closed loops in nearest-neighbour order from `start`, each starting at its closest vertex. */
function orderLoops(loops: Poly[], start: Pt): Pt[][] {
  const todo = loops.filter((l) => l.length >= 3);
  const out: Pt[][] = [];
  let p = start;
  while (todo.length) {
    let bi = 0, bj = 0, bd = Infinity;
    todo.forEach((l, i) => l.forEach((q, j) => { const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2; if (d < bd) { bd = d; bi = i; bj = j; } }));
    const l = todo.splice(bi, 1)[0];
    const loop = [...l.slice(bj), ...l.slice(0, bj), l[bj]];
    out.push(loop);
    p = loop[loop.length - 1];
  }
  return out;
}

export function planSheet(sheet: CamSheet, cfg: CamSettings): CamJob {
  const warnings: string[] = [];
  const stock = cfg.stockActual[stockKey(sheet.thickness)] || sheet.thickness;
  const cutDepth = stock + Math.max(0, cfg.throughExtra);
  const tabTop = -stock + cfg.tabHeight;
  const useTabs = cfg.tabs && cfg.tabHeight > 0 && cfg.tabWidth > 0;
  if (useTabs && cfg.tabHeight >= stock) warnings.push('Tabs are as tall as the stock. Lower the tab height.');

  const tOut = toolById(cfg, cfg.outlineTool), tHole = toolById(cfg, cfg.holeTool), tPocket = toolById(cfg, cfg.pocketTool);
  if (tOut.diameter > sheet.kerf + 0.01) {
    warnings.push(`Outline bit (${tOut.diameter} mm) is wider than the layout's gap (${sheet.kerf} mm) and would cut into parts. Re-pack.`);
  }
  if (cfg.machine === 'gordix' && cutDepth > GORDIX_Z_TRAVEL) warnings.push(`Cut depth ${cutDepth.toFixed(1)} mm exceeds the GORDIX's ${GORDIX_Z_TRAVEL} mm Z travel.`);

  const parts = sheet.shapes.map((s) => shapePart(s.regions, cfg, tOut.diameter / 2, tHole.diameter / 2));

  // --- operations, in cutting order -------------------------------------------
  type Op = { kind: OpKind; tool?: Tool; run: (w: ReturnType<typeof routerWriter>) => void };
  const ops: Op[] = [];

  // Labels (laser) go first, on the whole sheet.
  const labelMoves: Move[] = [];
  if (cfg.labels) {
    for (const s of sheet.shapes) {
      const bb = bbox(s.regions.flatMap((r) => r.outer));
      const name = s.part.name;
      let h = Math.max(1, cfg.labelHeight);
      const maxW = (bb.maxX - bb.minX) * 0.8, maxH = (bb.maxY - bb.minY) * 0.5;
      h = Math.min(h, maxH, maxW > 0 ? (h * maxW) / Math.max(1e-6, textWidth(name, h)) : h);
      if (h < 3) continue; // too small to read
      for (const run of strokeText(name, s.label.x, s.label.y, h)) {
        labelMoves.push({ rapid: true, x: run[0].x, y: run[0].y, z: 0, f: 0, op: 'label' });
        for (const p of run.slice(1)) labelMoves.push({ rapid: false, x: p.x, y: p.y, z: 0, f: cfg.laserFeed, op: 'label', laser: true });
      }
    }
  }

  // Pockets: concentric rings from the wall inward, cut inside-out so the last ring is the clean wall.
  let backPockets = 0, smallPockets = 0;
  const pocketRings: { depth: number; rings: Poly[][] }[] = [];
  const step = Math.max(0.05, tPocket.diameter * Math.min(0.9, Math.max(0.1, cfg.stepover)));
  for (const s of sheet.shapes) {
    for (const pk of s.pockets) {
      if (pk.side === 'bottom') { backPockets++; continue; }
      if (pk.depth >= stock - 0.01) continue;
      const shaped = shapePocket(pk.regions, cfg, tPocket.diameter / 2);
      const rings: Poly[][] = [];
      for (let k = 0; k < 10000; k++) {
        const polys = offsetRegions(shaped, -(tPocket.diameter / 2 + k * step)).filter((p) => p.length >= 3);
        if (!polys.length) break;
        rings.push(polys);
      }
      if (!rings.length) { smallPockets++; continue; }
      pocketRings.push({ depth: pk.depth, rings: rings.reverse() });
    }
  }
  if (backPockets) warnings.push(`${backPockets} back-face pocket${backPockets > 1 ? 's' : ''} left out (flip the part to cut).`);
  if (smallPockets) warnings.push(`${smallPockets} pocket${smallPockets > 1 ? 's' : ''} narrower than the ${tPocket.name}, left out.`);
  if (pocketRings.length) {
    ops.push({
      kind: 'pocket', tool: tPocket, run: (w) => {
        for (const pk of pocketRings) {
          const grid = cutDepth / levels(cutDepth, tPocket.depthPerPass).length;
          for (const ring of pk.rings) for (const p of ring) w.cutPath([...p, p[0]], true, pk.depth, 'pocket', -Infinity, false, grid);
        }
      },
    });
  }

  // Holes: each through hole as its own closed loop, shrunk by the bit radius.
  let smallHoles = 0;
  const holeLoops: Poly[] = [];
  for (const regions of parts) for (const r of regions) for (const hole of r.holes) {
    const loops = offsetRegions([{ outer: ccw(hole), holes: [] }], -tHole.diameter / 2).filter((p) => p.length >= 3 && area(p) > 0);
    if (!loops.length) smallHoles++;
    holeLoops.push(...loops);
  }
  if (smallHoles) warnings.push(`${smallHoles} hole${smallHoles > 1 ? 's' : ''} narrower than the ${tHole.name}, left out.`);
  if (holeLoops.length) {
    ops.push({
      kind: 'hole', tool: tHole, run: (w) => {
        const start = Number.isFinite(w.pos.x) ? w.pos : { x: 0, y: 0 };
        for (const loop of orderLoops(holeLoops, start)) w.cutPath(loop, true, cutDepth, 'hole', tabTop, useTabs && cfg.tabsOnHoles);
      },
    });
  }

  // Outlines: the merged network (shared edges once), in the planner's order.
  const net = cutNetwork(parts.map((rs) => rs.map((r) => ({ outer: r.outer, holes: [] }))), tOut.diameter, sheet.w, sheet.h, sheet.edgeMargin);
  if (net.strokes.length) {
    ops.push({
      kind: 'outline', tool: tOut, run: (w) => {
        for (const k of net.strokes) w.cutPath(k.pts, k.closed, cutDepth, 'outline', tabTop, useTabs);
      },
    });
  }

  // --- files: consecutive ops on the same bit share one ---------------------
  const files: CamFile[] = [];
  if (labelMoves.length) files.push({ kind: 'laser', ops: ['label'], moves: labelMoves });
  let i = 0;
  while (i < ops.length) {
    const tool = ops[i].tool!;
    const w = routerWriter(tool, cfg);
    const kinds: OpKind[] = [];
    while (i < ops.length && ops[i].tool!.id === tool.id) { ops[i].run(w); kinds.push(ops[i].kind); i++; }
    files.push({ kind: 'router', tool, ops: kinds, moves: w.finish() });
  }

  // --- reach --------------------------------------------------------------------
  if (cfg.machine === 'gordix' && cfg.origin === 'center') {
    const table = currentTable(cfg);
    const r = gordixFit(table);
    const cx = sheet.w / 2, cy = sheet.h / 2;
    const out = files.some((f) => f.moves.some((m) => !m.rapid && (Math.abs(m.x - cx) > r.x + 0.5 || Math.abs(m.y - cy) > r.y + 0.5)));
    if (out) warnings.push(`Cuts run outside the ${r.x * 2} × ${r.y * 2} mm the GORDIX reaches on table ${table.id}. Use the work area as the sheet and re-pack.`);
  }

  return { files, warnings, stock, cutDepth, parts };
}
