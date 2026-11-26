import { currentTable, gordixFit, tableReach, type CamFile, type CamSettings, type MachineId, type Move } from './cam';

/**
 * Writes a planned file (src/cam.ts) as G-code for one machine.
 *
 * GORDIX: the dialect GORDIX Studio writes (https://github.com/pfsin555/Gordix-studio, CNC.html),
 * so files run on the GORDIX and open in Studio's G-code editor. Only G21, G90, G0 and G1 with `;`
 * comments, and X/Y/Z always with three decimals. F is modal and also governs G0 on the GORDIX, so
 * like Studio every file opens with G0 X0 Y0 F2000 before any Z move, lifts with G0 Z<safe>, and
 * lowers with G1 Z<depth> F300. Our XY rapids also carry F2000 so they never crawl at the last
 * cutting feed. M03 S255 / M05 switch the laser module, so router files never send them. Files
 * end at X0 Y0.
 *
 * GRBL: the common hobby dialect. M3 S<rpm> / M5 for the spindle, M4 (dynamic power) for a laser,
 * G0 at the machine's own rapid speed, M30 at the end.
 */
export type Machine = {
  name: string;
  /** Feed written on G0 moves, or null when G0 runs at the machine's own rapid speed. */
  rapidF: number | null;
  /** Rapid speed for time estimates, mm/min. */
  rapidSpeed: number;
  spindle: boolean;
  laserOn: (powerPct: number) => string;
  laserOff: string;
  end: string[];
  /** Write X, Y and Z with exactly three decimals (Studio's `toFixed(3)`) instead of trimming zeros. */
  fixed: boolean;
};

export const MACHINES: Record<MachineId, Machine> = {
  gordix: {
    name: 'GORDIX (GORDIX Studio dialect)', rapidF: 2000, rapidSpeed: 2000, spindle: false,
    laserOn: () => 'M03 S255', laserOff: 'M05', end: [], fixed: true,
  },
  grbl: {
    name: 'Generic GRBL', rapidF: null, rapidSpeed: 3000, spindle: true,
    laserOn: (p) => `M4 S${Math.round(Math.max(0, Math.min(100, p)) * 10)}`, laserOff: 'M5', end: ['M30'], fixed: false,
  },
};

const n = (v: number) => {
  const s = v.toFixed(3).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};
/** Coordinate words for this machine: Studio's fixed three decimals on the GORDIX, trimmed otherwise. */
const coord = (m: Machine) => (v: number) => {
  if (!m.fixed) return n(v);
  const s = v.toFixed(3);
  return s === '-0.000' ? '0.000' : s;
};
const clean = (s: string) => s.replace(/[\r\n;()]/g, ' ');

export type WriteContext = {
  cfg: CamSettings;
  sheetW: number;
  sheetH: number;
  title: string;
  /** "File 1 of 3" style position, for the header. */
  index: number;
  count: number;
  stock: number;
  cutDepth: number;
};

/** Sheet coordinates (lower-left origin) to machine coordinates, as every file for this sheet writes them. */
function machineFrame(cfg: CamSettings, sheetW: number, sheetH: number) {
  const ox = cfg.origin === 'center' ? sheetW / 2 : 0;
  const oy = cfg.origin === 'center' ? sheetH / 2 : 0;
  // When the table's X side (S) is its short one, the sheet's long side runs along the machine's Y.
  const table = currentTable(cfg);
  const turn = cfg.machine === 'gordix' && cfg.origin === 'center' && gordixFit(table).rotate;
  const at = (mv: { x: number; y: number }) => (turn ? { x: -(mv.y - oy), y: mv.x - ox } : { x: mv.x - ox, y: mv.y - oy });
  return { at, turn, table };
}

export function writeGcode(file: CamFile, ctx: WriteContext): string {
  const { cfg } = ctx;
  const m = MACHINES[cfg.machine];
  const c = coord(m);
  const { at, turn, table } = machineFrame(cfg, ctx.sheetW, ctx.sheetH);
  const lift = file.kind === 'router' ? Math.max(0, cfg.airCut) : 0;
  const out: string[] = [];
  const line = (s: string) => out.push(s);
  let f: number | null = null;
  const fWord = (v: number) => { if (f !== null && Math.abs(f - v) < 0.01) return ''; f = v; return ` F${n(v)}`; };
  const rapidF = () => (m.rapidF === null ? '' : fWord(m.rapidF));

  line(`; PlyWooder: ${clean(ctx.title)}, file ${ctx.index} of ${ctx.count}`);
  if (file.kind === 'laser') {
    line('; Laser: mark part labels. Run this first, before any cutting.');
  } else {
    const t = file.tool!;
    line(`; Bit: ${clean(t.name)}, ${n(t.diameter)} mm. Zero Z on the top of the material after loading it.`);
    line(`; Operations: ${file.ops.join(', ')}. Stock ${n(ctx.stock)} mm, through cuts to Z-${n(ctx.cutDepth)}.`);
    line(`; Feed ${n(t.feed)} mm/min, plunge ${n(t.plungeFeed)} mm/min, up to ${n(t.depthPerPass)} mm per pass.`);
    if (lift > 0) line(`; AIR CUT: everything is raised ${n(lift)} mm. Nothing touches the material.`);
  }
  line(cfg.origin === 'center'
    ? `; Origin: X0 Y0 = centre of the ${n(ctx.sheetW)} x ${n(ctx.sheetH)} mm sheet${file.kind === 'router' ? ', Z0 = top of material' : ''}${cfg.machine === 'gordix' ? `. GORDIX table ${table.id} (S ${n(table.S)} x W ${n(table.W)} mm)` : ''}`
    : `; Origin: X0 Y0 = lower-left corner of the sheet${file.kind === 'router' ? ', Z0 = top of material' : ''}`);
  if (turn) line(`; Sheet turned 90 degrees: its long side runs along table side W (machine Y).`);
  line('G21');
  line('G90');

  if (file.kind === 'laser') {
    line(`G0 X0 Y0${rapidF()}`);
    let on = false;
    for (const mv of file.moves) {
      const { x, y } = at(mv);
      if (mv.rapid || !mv.laser) {
        if (on) { line(m.laserOff); on = false; }
        line(`G0 X${c(x)} Y${c(y)}${rapidF()}`);
      } else {
        if (!on) { line(m.laserOn(cfg.laserPower)); on = true; }
        line(`G1 X${c(x)} Y${c(y)}${fWord(mv.f)}`);
      }
    }
    if (on) line(m.laserOff);
    line(`G0 X0 Y0${rapidF()}`);
    for (const e of m.end) line(e);
    return out.join('\n') + '\n';
  }

  const safe = Math.max(0.5, cfg.safeZ) + lift;
  // Studio's order: G0 X0 Y0 F2000 first, so the feed is set before Z moves (F governs G0 on the GORDIX).
  line(`G0 X0 Y0${rapidF()}`);
  line(`G0 Z${c(safe)}`);
  const rpm = file.tool?.rpm || cfg.rpm; // the bit's own speed wins over the machine setting
  if (m.spindle && rpm > 0) line(`M3 S${Math.round(rpm)}`);
  let cx = 0, cy = 0, cz = safe;
  for (const mv of file.moves) {
    const { x, y } = at(mv);
    const z = mv.z + lift;
    const dx = Math.abs(x - cx) > 1e-4, dy = Math.abs(y - cy) > 1e-4, dz = Math.abs(z - cz) > 1e-4;
    if (!dx && !dy && !dz) continue;
    const xy = `${dx || (mv.rapid && dy) ? ` X${c(x)}` : ''}${dy || (mv.rapid && dx) ? ` Y${c(y)}` : ''}`;
    if (mv.rapid) {
      // Studio puts F on rapids that move in XY only; Z-only rapids carry none.
      line(`G0${xy}${dz ? ` Z${c(z)}` : ''}${dx || dy ? rapidF() : ''}`);
    } else {
      line(`G1${xy}${dz ? ` Z${c(z)}` : ''}${fWord(mv.f)}`);
    }
    cx = x; cy = y; cz = z;
  }
  if (cz < safe - 1e-6) line(`G0 Z${c(safe)}`);
  if (m.spindle && rpm > 0) line('M5');
  line(`G0 X0 Y0${rapidF()}`);
  for (const e of m.end) line(e);
  return out.join('\n') + '\n';
}

/** True when any file has a cutting move (laser marks included). */
const hasCuts = (files: CamFile[]) => files.some((f) => f.moves.some((mv) => !mv.rapid));

/**
 * The stock sheet's four corners in machine coordinates, counter-clockwise from the corner with the
 * lowest X and Y as seen on the machine (which, when the sheet is turned 90 degrees, is not the
 * sheet's own lower-left).
 */
function stockCorners(at: (p: { x: number; y: number }) => { x: number; y: number }, w: number, h: number) {
  const pts = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }].map(at);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

/**
 * Registration: lifts to safe height and moves the bit centre to the stock sheet's lower-left
 * corner on the machine (lowest X and Y), then stops there with the spindle and laser off, so the
 * stock's corner can be lined up under it. Null when the sheet has nothing to cut.
 */
export function writeBoundsGcode(files: CamFile[], ctx: Omit<WriteContext, 'index' | 'count'>): string | null {
  const { cfg } = ctx;
  const m = MACHINES[cfg.machine];
  const c = coord(m);
  if (!hasCuts(files)) return null;
  const { at, turn, table } = machineFrame(cfg, ctx.sheetW, ctx.sheetH);
  const corner = stockCorners(at, ctx.sheetW, ctx.sheetH)[0];
  const z = Math.max(0.5, cfg.safeZ);
  const rapidF = m.rapidF === null ? '' : ` F${n(m.rapidF)}`;
  const out = [
    `; PlyWooder: ${clean(ctx.title)}, lower-left registration`,
    `; Moves the bit centre to the lower-left corner of the ${n(ctx.sheetW)} x ${n(ctx.sheetH)} mm stock sheet and stops there.`,
    '; Line the stock\'s corner up under the bit. Nothing is cut: Z stays at safe height, spindle and laser off.',
    '; Zero X, Y and Z exactly as for the cutting files.',
    cfg.origin === 'center'
      ? `; Origin: X0 Y0 = centre of the ${n(ctx.sheetW)} x ${n(ctx.sheetH)} mm sheet, Z0 = top of material${cfg.machine === 'gordix' ? `. GORDIX table ${table.id} (S ${n(table.S)} x W ${n(table.W)} mm)` : ''}`
      : '; Origin: X0 Y0 = lower-left corner of the sheet, Z0 = top of material',
    ...(turn ? ['; Sheet turned 90 degrees: its long side runs along table side W (machine Y).'] : []),
    'G21',
    'G90',
    `G0 X0 Y0${rapidF}`,
    `G0 Z${c(z)}`,
    `G0 X${c(corner.x)} Y${c(corner.y)}${rapidF}`,
    ...m.end,
  ];
  return out.join('\n') + '\n';
}

/** How far inside the GORDIX's reach the pen stops when an edge runs past it, mm. */
const PEN_REACH_MARGIN = 10;

type Seg = [{ x: number; y: number }, { x: number; y: number }];

/**
 * Whether the dry run files that go to the stock's edge (Bounds G-code, Draw stock edge with pen)
 * can get there on the GORDIX. Both drive the bit centre onto the stock's edge, so the stock's
 * half-size along each machine axis has to stay inside the table's half-range (tableReach, along
 * machine X and Y; the sheet may be turned 90°). A sheet sized with "Use table max" sits on that
 * half-range, which is inside the firmware's limit, so it fits. Null when it fits, or when this can't be told: another
 * machine, or a corner origin, which says nothing about where the machine stands.
 *
 * `area` is the work area along the sheet's own axes. `edges` are the parts of the stock's four
 * edges the pen can still draw, in machine coordinates, kept PEN_REACH_MARGIN inside the reach.
 */
export function stockEdgeReach(cfg: CamSettings, sheetW: number, sheetH: number) {
  if (cfg.machine !== 'gordix' || cfg.origin !== 'center') return null;
  const { at, turn, table } = machineFrame(cfg, sheetW, sheetH);
  const reach = tableReach(table);
  const halfX = (turn ? sheetH : sheetW) / 2, halfY = (turn ? sheetW : sheetH) / 2;
  const over = Math.max(halfX - reach.x, halfY - reach.y);
  if (over <= 1e-6) return null;
  const area = turn ? { w: reach.y * 2, h: reach.x * 2 } : { w: reach.x * 2, h: reach.y * 2 };
  const lx = reach.x - PEN_REACH_MARGIN, ly = reach.y - PEN_REACH_MARGIN;
  const [ll, lr, ur, ul] = stockCorners(at, sheetW, sheetH);
  const edges: Seg[] = [];
  // Around the stock: bottom, right, top, left. An edge past the reach is left out; one that runs
  // past it at its ends is cut short.
  const along = (y: number, xa: number, xb: number) => {
    const a = Math.max(Math.min(xa, xb), -lx), b = Math.min(Math.max(xa, xb), lx);
    if (Math.abs(y) <= ly && b - a > 1) edges.push(xa < xb ? [{ x: a, y }, { x: b, y }] : [{ x: b, y }, { x: a, y }]);
  };
  const across = (x: number, ya: number, yb: number) => {
    const a = Math.max(Math.min(ya, yb), -ly), b = Math.min(Math.max(ya, yb), ly);
    if (Math.abs(x) <= lx && b - a > 1) edges.push(ya < yb ? [{ x, y: a }, { x, y: b }] : [{ x, y: b }, { x, y: a }]);
  };
  along(ll.y, ll.x, lr.x);
  across(lr.x, lr.y, ur.y);
  along(ur.y, ur.x, ul.x);
  across(ul.x, ul.y, ll.y);
  return { area, table, edges };
}

/** Pen plotting: the pen comes down at the first feed and draws at the second. */
const PEN_DOWN_FEED = 300;
const PEN_FEED = 1000;
/** How far the pen runs along the top and bottom edges from the left corners, mm. */
const PEN_TICK = 100;

/**
 * Pen plotter G-code that marks where the stock sheet goes: its whole left edge on the machine
 * (lowest X), with a short stretch of the top and bottom edges, like a [ bracket, drawn with the
 * spindle and laser off. When the stock runs past what the GORDIX reaches, it draws instead every
 * stretch of the stock's edges inside the reach (stockEdgeReach), so the machine never drives off
 * its work area. Zero Z with the pen tip touching the surface: the pen goes down to Z-penDepth so
 * it presses on the material, draws, and lifts to safe height between strokes. Null when the
 * sheet has nothing to cut, or no edge is in reach.
 */
export function writePenBoundsGcode(files: CamFile[], ctx: Omit<WriteContext, 'index' | 'count'>): string | null {
  const { cfg } = ctx;
  const m = MACHINES[cfg.machine];
  const c = coord(m);
  if (!hasCuts(files)) return null;
  const { at, turn, table } = machineFrame(cfg, ctx.sheetW, ctx.sheetH);
  const [ll, lr, , ul] = stockCorners(at, ctx.sheetW, ctx.sheetH);
  const tick = Math.min(PEN_TICK, lr.x - ll.x);
  const reach = stockEdgeReach(cfg, ctx.sheetW, ctx.sheetH);
  // Top edge in to the top-left corner, down the left edge, then out along the bottom edge; or,
  // past the reach, each edge stretch it can get to as its own stroke.
  const strokes = reach ? reach.edges : [[{ x: ul.x + tick, y: ul.y }, ul, ll, { x: ll.x + tick, y: ll.y }]];
  if (!strokes.length) return null;
  const z = Math.max(0.5, cfg.safeZ);
  const down = -Math.max(0, cfg.penDepth || 0);
  const rapidF = m.rapidF === null ? '' : ` F${n(m.rapidF)}`;
  const out = [
    `; PlyWooder: ${clean(ctx.title)}, pen-drawn stock edge`,
    reach
      ? `; Draws the edges of the ${n(ctx.sheetW)} x ${n(ctx.sheetH)} mm stock sheet that the GORDIX reaches, stopping ${n(PEN_REACH_MARGIN)} mm inside its work area, so the stock can be placed against them.`
      : `; Draws the left edge of the ${n(ctx.sheetW)} x ${n(ctx.sheetH)} mm stock sheet, with the first ${n(tick)} mm of its top and bottom edges, so the stock can be placed against it.`,
    '; Put a pen in the machine instead of the bit. Spindle and laser stay off.',
    '; Zero X and Y exactly as for the cutting files, and Z with the pen tip just touching the material.',
    `; The pen draws at Z${n(down)}, pressing ${n(-down)} mm into the surface: a spring-loaded holder gives it room.`,
    cfg.origin === 'center'
      ? `; Origin: X0 Y0 = centre of the ${n(ctx.sheetW)} x ${n(ctx.sheetH)} mm sheet, Z0 = pen tip on the material${cfg.machine === 'gordix' ? `. GORDIX table ${table.id} (S ${n(table.S)} x W ${n(table.W)} mm)` : ''}`
      : '; Origin: X0 Y0 = lower-left corner of the sheet, Z0 = pen tip on the material',
    ...(turn ? ['; Sheet turned 90 degrees: its long side runs along table side W (machine Y).'] : []),
    'G21',
    'G90',
    `G0 X0 Y0${rapidF}`,
    `G0 Z${c(z)}`,
    ...strokes.flatMap((path) => [
      `G0 X${c(path[0].x)} Y${c(path[0].y)}${rapidF}`,
      `G1 Z${c(down)} F${PEN_DOWN_FEED}`,
      ...path.slice(1).map((p, k) => `G1 X${c(p.x)} Y${c(p.y)}${k === 0 ? ` F${PEN_FEED}` : ''}`),
      `G0 Z${c(z)}`,
    ]),
    `G0 X0 Y0${rapidF}`,
    ...m.end,
  ];
  return out.join('\n') + '\n';
}

/** Run time in seconds: every move at its feed, rapids at the machine's rapid speed, from and back to X0 Y0. */
export function estimateSeconds(moves: Move[], machine: MachineId, start: { x: number; y: number }): number {
  const rapid = MACHINES[machine].rapidSpeed;
  let t = 0, x = start.x, y = start.y, z = moves[0]?.z ?? 0;
  for (const mv of moves) {
    const d = Math.hypot(mv.x - x, mv.y - y, mv.z - z);
    t += (d / (mv.rapid ? rapid : Math.max(1, mv.f))) * 60;
    x = mv.x; y = mv.y; z = mv.z;
  }
  return t + (Math.hypot(start.x - x, start.y - y) / rapid) * 60;
}

/** Total length of cutting (non-rapid) moves, mm. */
export const cutLength = (moves: Move[]) => {
  let L = 0;
  for (let i = 1; i < moves.length; i++) if (!moves[i].rapid) L += Math.hypot(moves[i].x - moves[i - 1].x, moves[i].y - moves[i - 1].y);
  return L;
};
