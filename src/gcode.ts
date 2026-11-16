import { currentTable, gordixFit, type CamFile, type CamSettings, type MachineId, type Move } from './cam';

/**
 * Writes a planned file (src/cam.ts) as G-code for one machine.
 *
 * GORDIX: the dialect GORDIX Studio writes (https://github.com/pfsin555/Gordix-studio, CNC.html),
 * so files run on the GORDIX and open in Studio's G-code editor. Only G21, G90, G0 and G1 with `;`
 * comments. F is modal and also governs G0 on the GORDIX, so rapids carry F2000 as Studio's do.
 * M03 S255 / M05 switch the laser module, so router files never send them. Files end at X0 Y0.
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
};

export const MACHINES: Record<MachineId, Machine> = {
  gordix: {
    name: 'GORDIX (GORDIX Studio dialect)', rapidF: 2000, rapidSpeed: 2000, spindle: false,
    laserOn: () => 'M03 S255', laserOff: 'M05', end: [],
  },
  grbl: {
    name: 'Generic GRBL', rapidF: null, rapidSpeed: 3000, spindle: true,
    laserOn: (p) => `M4 S${Math.round(Math.max(0, Math.min(100, p)) * 10)}`, laserOff: 'M5', end: ['M30'],
  },
};

const n = (v: number) => {
  const s = v.toFixed(3).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
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

export function writeGcode(file: CamFile, ctx: WriteContext): string {
  const { cfg } = ctx;
  const m = MACHINES[cfg.machine];
  const ox = cfg.origin === 'center' ? ctx.sheetW / 2 : 0;
  const oy = cfg.origin === 'center' ? ctx.sheetH / 2 : 0;
  // When the table's X side (S) is its short one, the sheet's long side runs along the machine's Y.
  const table = currentTable(cfg);
  const turn = cfg.machine === 'gordix' && cfg.origin === 'center' && gordixFit(table).rotate;
  const at = (mv: { x: number; y: number }) => (turn ? { x: -(mv.y - oy), y: mv.x - ox } : { x: mv.x - ox, y: mv.y - oy });
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
        line(`G0 X${n(x)} Y${n(y)}${rapidF()}`);
      } else {
        if (!on) { line(m.laserOn(cfg.laserPower)); on = true; }
        line(`G1 X${n(x)} Y${n(y)}${fWord(mv.f)}`);
      }
    }
    if (on) line(m.laserOff);
    line(`G0 X0 Y0${rapidF()}`);
    for (const e of m.end) line(e);
    return out.join('\n') + '\n';
  }

  const safe = Math.max(0.5, cfg.safeZ) + lift;
  line(`G0 Z${n(safe)}`);
  line(`G0 X0 Y0${rapidF()}`);
  if (m.spindle && cfg.rpm > 0) line(`M3 S${Math.round(cfg.rpm)}`);
  let cx = 0, cy = 0, cz = safe;
  for (const mv of file.moves) {
    const { x, y } = at(mv);
    const z = mv.z + lift;
    const dx = Math.abs(x - cx) > 1e-4, dy = Math.abs(y - cy) > 1e-4, dz = Math.abs(z - cz) > 1e-4;
    if (!dx && !dy && !dz) continue;
    const xy = `${dx || (mv.rapid && dy) ? ` X${n(x)}` : ''}${dy || (mv.rapid && dx) ? ` Y${n(y)}` : ''}`;
    if (mv.rapid) {
      // Studio puts F on rapids that move in XY only; Z-only rapids carry none.
      line(`G0${xy}${dz ? ` Z${n(z)}` : ''}${dx || dy ? rapidF() : ''}`);
    } else {
      line(`G1${xy}${dz ? ` Z${n(z)}` : ''}${fWord(mv.f)}`);
    }
    cx = x; cy = y; cz = z;
  }
  if (cz < safe - 1e-6) line(`G0 Z${n(safe)}`);
  if (m.spindle && cfg.rpm > 0) line('M5');
  line(`G0 X0 Y0${rapidF()}`);
  for (const e of m.end) line(e);
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
