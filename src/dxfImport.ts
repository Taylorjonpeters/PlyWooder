import { ShapeUtils, Vector2 } from 'three';
import { type Poly, type Pt, area } from './geom';
import { buildPart, type MeshData, type Part } from './parts';

/**
 * DXF import: reads a 2D drawing, finds closed outlines, and turns each outer outline (with the
 * holes inside it) into a flat part of the given thickness. Parts are extruded into meshes so the
 * rest of the app (packing, cut plans, 3D view) treats them like solids from a STEP file.
 */
export type DxfUnits = 'auto' | 'mm' | 'cm' | 'in';
export type DxfImport = { parts: Part[]; units: Exclude<DxfUnits, 'auto'>; unitsFromFile: boolean; openShapes: number; borders: number };

// Layers PlyWooder writes for reference only; re-importing its own export should skip them.
const SKIP_LAYERS = /^(SHEET|LABELS|SAW_CUTS|CUT_PATHS|DEFPOINTS)$/i;
const POCKET_LAYER = /^POCKET/i;
const TOL = 0.05; // mm: endpoints closer than this are joined

type Pair = [number, string];
type Entity = { type: string; codes: Pair[] };
type Block = { base: Pt; entities: Entity[] };
type Shape = { pts: Pt[]; closed: boolean; layer: string };
type Label = { at: Pt; text: string };

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function readPairs(text: string): Pair[] {
  const lines = text.split(/\r?\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) { i--; continue; } // tolerate stray blank lines
    out.push([code, lines[i + 1].replace(/\s+$/, '')]);
  }
  return out;
}

function readSections(pairs: Pair[]) {
  const header = new Map<string, Pair[]>();
  const blocks = new Map<string, Block>();
  const entities: Entity[] = [];
  let section = '';
  let current: Entity | null = null;
  let headerVar = '';
  let block: { name: string; base: Pt; entities: Entity[] } | null = null;
  const flush = () => {
    if (!current) return;
    if (section === 'BLOCKS') {
      if (current.type === 'BLOCK') {
        block = { name: str(current.codes, 2) ?? '', base: { x: num(current.codes, 10), y: num(current.codes, 20) }, entities: [] };
      } else if (current.type === 'ENDBLK') {
        if (block) blocks.set(block.name, { base: block.base, entities: block.entities });
        block = null;
      } else block?.entities.push(current);
    } else if (section === 'ENTITIES') entities.push(current);
    current = null;
  };
  for (let i = 0; i < pairs.length; i++) {
    const [code, value] = pairs[i];
    if (code === 0) {
      flush();
      if (value === 'SECTION') { section = pairs[i + 1]?.[0] === 2 ? pairs[++i][1] : ''; continue; }
      if (value === 'ENDSEC') { section = ''; continue; }
      if (value === 'EOF') break;
      if (section === 'ENTITIES' || section === 'BLOCKS') current = { type: value, codes: [] };
      continue;
    }
    if (section === 'HEADER') {
      if (code === 9) { headerVar = value; header.set(value, []); } else header.get(headerVar)?.push([code, value]);
    } else current?.codes.push([code, value]);
  }
  flush();
  return { header, blocks, entities };
}

const num = (c: Pair[], code: number, def = 0) => { const p = c.find((q) => q[0] === code); return p ? parseFloat(p[1]) : def; };
const str = (c: Pair[], code: number) => c.find((q) => q[0] === code)?.[1];
const nums = (c: Pair[], code: number) => c.filter((q) => q[0] === code).map((q) => parseFloat(q[1]));

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Points along an arc, with chord error under TOL. Angles in radians, counter-clockwise from a0 to a1. */
function arcPts(c: Pt, r: number, a0: number, a1: number): Pt[] {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += Math.PI * 2;
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - TOL / Math.max(r, TOL))));
  const n = Math.max(2, Math.min(720, Math.ceil(sweep / Math.max(step, 1e-3))));
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + (sweep * i) / n;
    return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
  });
}

/** Polyline vertices with bulges (arc segments) into points. */
function bulgePts(vs: { p: Pt; bulge: number }[], closed: boolean): Pt[] {
  const out: Pt[] = [];
  const n = vs.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = vs[i].p, b = vs[(i + 1) % n].p, bulge = vs[i].bulge;
    out.push(a);
    if (Math.abs(bulge) < 1e-9) continue;
    const theta = 4 * Math.atan(bulge);
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    if (chord < 1e-12) continue;
    const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const h = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2)) * Math.sign(bulge) * (Math.abs(theta) > Math.PI ? -1 : 1);
    const c = { x: mx - (h * (b.y - a.y)) / chord, y: my + (h * (b.x - a.x)) / chord };
    const a0 = Math.atan2(a.y - c.y, a.x - c.x), a1 = Math.atan2(b.y - c.y, b.x - c.x);
    const pts = bulge > 0 ? arcPts(c, r, a0, a1) : arcPts(c, r, a1, a0).reverse();
    out.push(...pts.slice(1, -1));
  }
  if (!closed && n) out.push(vs[n - 1].p);
  return out;
}

/** NURBS curve by de Boor, sampled evenly in parameter. */
function splinePts(c: Pair[]): Pt[] {
  const deg = num(c, 71, 3);
  const knots = nums(c, 40);
  const xs = nums(c, 10), ys = nums(c, 20);
  const weights = nums(c, 41);
  const ctrl = xs.map((x, i) => ({ x, y: ys[i] ?? 0, w: weights[i] ?? 1 }));
  if (ctrl.length < 2 || knots.length !== ctrl.length + deg + 1) {
    // No usable control net: fall back to fit points if present.
    const fx = nums(c, 11), fy = nums(c, 21);
    return fx.length >= 2 ? fx.map((x, i) => ({ x, y: fy[i] ?? 0 })) : ctrl.map(({ x, y }) => ({ x, y }));
  }
  const t0 = knots[deg], t1 = knots[knots.length - deg - 1];
  const samples = Math.max(16, ctrl.length * 12);
  const out: Pt[] = [];
  for (let s = 0; s <= samples; s++) {
    const t = Math.min(t1 - 1e-9, t0 + ((t1 - t0) * s) / samples);
    let k = deg;
    while (k < knots.length - deg - 2 && t >= knots[k + 1]) k++;
    const d = Array.from({ length: deg + 1 }, (_, j) => {
      const p = ctrl[j + k - deg];
      return { x: p.x * p.w, y: p.y * p.w, w: p.w };
    });
    for (let r = 1; r <= deg; r++) {
      for (let j = deg; j >= r; j--) {
        const i = j + k - deg;
        const den = knots[i + deg - r + 1] - knots[i];
        const a = den === 0 ? 0 : (t - knots[i]) / den;
        d[j] = { x: (1 - a) * d[j - 1].x + a * d[j].x, y: (1 - a) * d[j - 1].y + a * d[j].y, w: (1 - a) * d[j - 1].w + a * d[j].w };
      }
    }
    out.push({ x: d[deg].x / d[deg].w, y: d[deg].y / d[deg].w });
  }
  return out;
}

type Xf = (p: Pt) => Pt;
const ident: Xf = (p) => p;

/** Entities with a negative extrusion (OCS z = -1) are mirrored in x. */
const ocs = (c: Pair[]): Xf => (num(c, 230, 1) < 0 ? (p) => ({ x: -p.x, y: p.y }) : ident);

function collect(entities: Entity[], blocks: Map<string, Block>, xf: Xf, shapes: Shape[], labels: Label[], depth = 0) {
  for (let i = 0; i < entities.length; i++) {
    const { type, codes: c } = entities[i];
    const layer = str(c, 8) ?? '0';
    const o = ocs(c);
    const T = (p: Pt) => xf(o(p));
    const add = (pts: Pt[], closed: boolean) => { if (pts.length >= 2) shapes.push({ pts: pts.map(T), closed, layer }); };
    switch (type) {
      case 'LINE':
        shapes.push({ pts: [xf({ x: num(c, 10), y: num(c, 20) }), xf({ x: num(c, 11), y: num(c, 21) })], closed: false, layer });
        break;
      case 'CIRCLE': {
        const pts = arcPts({ x: num(c, 10), y: num(c, 20) }, num(c, 40), 0, Math.PI * 2);
        add(pts.slice(0, -1), true);
        break;
      }
      case 'ARC':
        add(arcPts({ x: num(c, 10), y: num(c, 20) }, num(c, 40), (num(c, 50) * Math.PI) / 180, (num(c, 51) * Math.PI) / 180), false);
        break;
      case 'ELLIPSE': {
        const cx = num(c, 10), cy = num(c, 20), mx = num(c, 11), my = num(c, 21), ratio = num(c, 40, 1);
        let p0 = num(c, 41, 0), p1 = num(c, 42, Math.PI * 2);
        while (p1 <= p0) p1 += Math.PI * 2;
        const R = Math.hypot(mx, my), rot = Math.atan2(my, mx);
        const n = Math.max(24, Math.ceil(((p1 - p0) / (Math.PI * 2)) * 180));
        const pts = Array.from({ length: n + 1 }, (_, k) => {
          const t = p0 + ((p1 - p0) * k) / n;
          const ex = R * Math.cos(t), ey = R * ratio * Math.sin(t);
          return { x: cx + ex * Math.cos(rot) - ey * Math.sin(rot), y: cy + ex * Math.sin(rot) + ey * Math.cos(rot) };
        });
        const full = Math.abs(p1 - p0 - Math.PI * 2) < 1e-6;
        add(full ? pts.slice(0, -1) : pts, full);
        break;
      }
      case 'LWPOLYLINE': {
        const vs: { p: Pt; bulge: number }[] = [];
        for (const [code, v] of c) {
          if (code === 10) vs.push({ p: { x: parseFloat(v), y: 0 }, bulge: 0 });
          else if (code === 20 && vs.length) vs[vs.length - 1].p.y = parseFloat(v);
          else if (code === 42 && vs.length) vs[vs.length - 1].bulge = parseFloat(v);
        }
        const closed = (num(c, 70) & 1) === 1;
        add(bulgePts(vs, closed), closed);
        break;
      }
      case 'POLYLINE': {
        const flags = num(c, 70);
        const vs: { p: Pt; bulge: number }[] = [];
        while (entities[i + 1] && entities[i + 1].type === 'VERTEX') {
          const vc = entities[++i].codes;
          vs.push({ p: { x: num(vc, 10), y: num(vc, 20) }, bulge: num(vc, 42) });
        }
        if (entities[i + 1]?.type === 'SEQEND') i++;
        if (flags & (16 | 64)) break; // polygon / polyface meshes are 3D, not outlines
        add(bulgePts(vs, (flags & 1) === 1), (flags & 1) === 1);
        break;
      }
      case 'SPLINE': {
        const closed = (num(c, 70) & 1) === 1;
        add(splinePts(c), closed);
        break;
      }
      case 'INSERT': {
        const b = blocks.get(str(c, 2) ?? '');
        if (!b || depth > 8) break;
        const ix = num(c, 10), iy = num(c, 20), sx = num(c, 41, 1), sy = num(c, 42, 1);
        const rot = (num(c, 50) * Math.PI) / 180, cs = Math.cos(rot), sn = Math.sin(rot);
        const inner: Xf = (p) => {
          const lx = (p.x - b.base.x) * sx, ly = (p.y - b.base.y) * sy;
          return T({ x: ix + lx * cs - ly * sn, y: iy + lx * sn + ly * cs });
        };
        // Entities on layer 0 inside a block take the INSERT's layer.
        const ents = b.entities.map((e) => (str(e.codes, 8) === '0' || !str(e.codes, 8) ? { ...e, codes: [...e.codes.filter((q) => q[0] !== 8), [8, layer] as Pair] } : e));
        collect(ents, blocks, inner, shapes, labels, depth + 1);
        break;
      }
      case 'TEXT':
      case 'MTEXT': {
        const aligned = c.some((q) => q[0] === 11) && type === 'TEXT';
        const at = T(aligned ? { x: num(c, 11), y: num(c, 21) } : { x: num(c, 10), y: num(c, 20) });
        const raw = type === 'MTEXT' ? [...c.filter((q) => q[0] === 3).map((q) => q[1]), str(c, 1) ?? ''].join('') : str(c, 1) ?? '';
        const text = raw.replace(/\\P/g, ' ').replace(/\\[A-Za-z][^;]*;/g, '').replace(/[{}]/g, '').trim();
        if (text) labels.push({ at, text });
        break;
      }
    }
  }
}

/** Join open pieces end to end into loops. Returns closed loops and the count of pieces left open. */
function joinLoops(shapes: Shape[]): { loops: Shape[]; open: number } {
  const loops = shapes.filter((s) => s.closed).map((s) => ({ ...s, pts: dedupe(s.pts) }));
  const open = shapes.filter((s) => !s.closed).map((s) => ({ ...s, pts: [...s.pts] }));
  const near = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y) < TOL;
  let left = 0;
  while (open.length) {
    const chain = open.pop()!;
    for (let grew = true; grew; ) {
      grew = false;
      if (chain.pts.length > 2 && near(chain.pts[0], chain.pts[chain.pts.length - 1])) break;
      for (let k = 0; k < open.length; k++) {
        const s = open[k];
        const head = chain.pts[0], tail = chain.pts[chain.pts.length - 1];
        const a = s.pts[0], b = s.pts[s.pts.length - 1];
        if (near(tail, a)) chain.pts.push(...s.pts.slice(1));
        else if (near(tail, b)) chain.pts.push(...[...s.pts].reverse().slice(1));
        else if (near(head, b)) chain.pts.unshift(...s.pts.slice(0, -1));
        else if (near(head, a)) chain.pts.unshift(...[...s.pts].reverse().slice(0, -1));
        else continue;
        open.splice(k, 1);
        grew = true;
        break;
      }
    }
    if (chain.pts.length > 2 && near(chain.pts[0], chain.pts[chain.pts.length - 1])) {
      loops.push({ ...chain, pts: dedupe(chain.pts.slice(0, -1)), closed: true });
    } else left++;
  }
  return { loops: loops.filter((l) => l.pts.length >= 3 && Math.abs(area(l.pts)) > 1e-3), open: left };
}

function dedupe(p: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const q of p) if (!out.length || Math.hypot(q.x - out[out.length - 1].x, q.y - out[out.length - 1].y) > 1e-6) out.push(q);
  if (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 1e-6) out.pop();
  return out;
}

function isRect(p: Poly): boolean {
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4], c = p[(i + 2) % 4];
    if (Math.abs((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) > 1e-3 * Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y)) return false;
  }
  return true;
}

function inside(p: Pt, poly: Poly): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

// ---------------------------------------------------------------------------
// Meshes: extrude an outline with holes, cutting pockets into the top or back face.
// ---------------------------------------------------------------------------

const ccw = (p: Poly) => (area(p) >= 0 ? p : [...p].reverse());
const cw = (p: Poly) => (area(p) < 0 ? p : [...p].reverse());

type Pocket = { loop: Poly; depth: number; back: boolean };

function extrude(outer: Poly, holes: Poly[], pockets: Pocket[], t: number): MeshData {
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  const faces: { first: number; last: number }[] = [];
  let tri = 0;
  const face = (build: () => void) => {
    const first = tri;
    build();
    if (tri > first) faces.push({ first, last: tri - 1 });
  };
  const v = (x: number, y: number, z: number, n: [number, number, number]) => {
    pos.push(x, y, z);
    nor.push(...n);
    return pos.length / 3 - 1;
  };
  /** Flat cap at height z facing up (+1) or down (-1). */
  const cap = (contour: Poly, hs: Poly[], z: number, up: 1 | -1) => {
    const c2 = cw(contour).map((p) => new Vector2(p.x, p.y));
    const h2 = hs.map((h) => ccw(h).map((p) => new Vector2(p.x, p.y)));
    const all = [...c2, ...h2.flat()];
    const base = all.map((p) => v(p.x, p.y, z, [0, 0, up]));
    for (const [a, b, c] of ShapeUtils.triangulateShape(c2, h2)) {
      const pa = all[a], pb = all[b], pc = all[c];
      const crossZ = (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x);
      if ((crossZ > 0) === (up > 0)) idx.push(base[a], base[b], base[c]);
      else idx.push(base[a], base[c], base[b]);
      tri++;
    }
  };
  /** Walls along a loop from z0 to z1; `outward` = the normal points away from the loop's left side. */
  const walls = (loop: Poly, z0: number, z1: number, flip: boolean) => {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
      const n: [number, number, number] = flip ? [-dy / l, dx / l, 0] : [dy / l, -dx / l, 0];
      const a0 = v(a.x, a.y, z0, n), b0 = v(b.x, b.y, z0, n), b1 = v(b.x, b.y, z1, n), a1 = v(a.x, a.y, z1, n);
      if (flip) idx.push(a0, b1, b0, a0, a1, b1);
      else idx.push(a0, b0, b1, a0, b1, a1);
      tri += 2;
    }
  };
  const top = pockets.filter((p) => !p.back), back = pockets.filter((p) => p.back);
  face(() => cap(outer, [...holes, ...top.map((p) => p.loop)], t, 1));
  face(() => cap(outer, [...holes, ...back.map((p) => p.loop)], 0, -1));
  face(() => {
    walls(ccw(outer), 0, t, false);
    for (const h of holes) walls(cw(h), 0, t, false);
  });
  for (const p of top) {
    face(() => cap(p.loop, [], t - p.depth, 1));
    face(() => walls(ccw(p.loop), t - p.depth, t, true));
  }
  for (const p of back) {
    face(() => cap(p.loop, [], p.depth, -1));
    face(() => walls(ccw(p.loop), 0, p.depth, true));
  }
  return { positions: Float32Array.from(pos), normals: Float32Array.from(nor), indices: Uint32Array.from(idx), faces };
}

// ---------------------------------------------------------------------------

const UNIT_MM = { mm: 1, cm: 10, in: 25.4 } as const;
const INSUNITS: Record<number, Exclude<DxfUnits, 'auto'>> = { 1: 'in', 4: 'mm', 5: 'cm' };

export function partsFromDxf(text: string, thickness: number, unitsChoice: DxfUnits = 'auto'): DxfImport {
  const { header, blocks, entities } = readSections(readPairs(text));
  const code = header.get('$INSUNITS')?.find((q) => q[0] === 70);
  const fileUnits = code ? INSUNITS[parseInt(code[1], 10)] : undefined;
  const units = unitsChoice === 'auto' ? fileUnits ?? 'mm' : unitsChoice;
  const k = UNIT_MM[units];

  const shapes: Shape[] = [];
  const labels: Label[] = [];
  collect(entities, blocks, (p) => ({ x: p.x * k, y: p.y * k }), shapes, labels);
  const { loops, open } = joinLoops(shapes.filter((s) => !SKIP_LAYERS.test(s.layer)));

  const cuts = loops.filter((l) => !POCKET_LAYER.test(l.layer)).map((l) => ({ pts: l.pts, a: Math.abs(area(l.pts)), layer: l.layer }));
  const pocketLoops = loops.filter((l) => POCKET_LAYER.test(l.layer));

  // Nesting depth by containment: even depth = a part's outline, odd = a hole in its parent.
  cuts.sort((a, b) => b.a - a.a);
  const parent = cuts.map((c, i) => {
    for (let j = i - 1; j >= 0; j--) if (cuts[j].a > c.a && inside(c.pts[0], cuts[j].pts)) return j;
    return -1;
  });
  // A rectangle around several loops is a drawn sheet border, not a part, when the loops fill
  // much of it or it sits on its own layer: skip it.
  const children = cuts.map((_, i) => cuts.filter((__, j) => parent[j] === i));
  const border = cuts.map((c, i) => c.pts.length === 4 && isRect(c.pts) && children[i].length >= 2
    && (children[i].reduce((a, ch) => a + ch.a, 0) > c.a * 0.3 || children[i].every((ch) => ch.layer !== c.layer)));
  const depthOf = (i: number): number => {
    let d = 0;
    for (let p = parent[i]; p >= 0; p = parent[p]) if (!border[p]) d++;
    return d;
  };
  const depth = cuts.map((_, i) => (border[i] ? -1 : depthOf(i)));

  const parts: Part[] = [];
  cuts.forEach((c, i) => {
    if (depth[i] < 0 || depth[i] % 2) return;
    const holes = cuts.filter((_, j) => parent[j] === i).map((h) => h.pts);
    const isIn = (p: Pt) => inside(p, c.pts) && !holes.some((h) => inside(p, h));
    const pockets: Pocket[] = pocketLoops.filter((p) => isIn(p.pts[0])).map((p) => {
      // PlyWooder writes POCKET_<depth with _ for .><units>[_BACK].
      const m = /^POCKET_(\d+)(?:_(\d+))?(mm|in)?/i.exec(p.layer);
      let d = m ? parseFloat(`${m[1]}.${m[2] ?? 0}`) * (m[3]?.toLowerCase() === 'in' ? 25.4 : 1) : thickness / 2;
      d = Math.min(thickness - 0.1, Math.max(0.1, d));
      return { loop: p.pts, depth: d, back: /_BACK$/i.test(p.layer) };
    });
    const label = labels.find((l) => isIn(l.at));
    const name = label?.text ?? `Part ${parts.length + 1}`;
    const part = buildPart(parts.length, name, extrude(c.pts, holes, pockets, thickness));
    parts.push({ ...part, isPanel: true });
  });
  return { parts, units, unitsFromFile: !!fileUnits, openShapes: open, borders: border.filter(Boolean).length };
}
