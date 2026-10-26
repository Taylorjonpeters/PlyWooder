import ClipperLib from 'clipper-lib';
import type { Pt, Region } from './geom';

/**
 * The cut network for one sheet: every part's tool-centre path (outline offset by half the
 * bit), with overlapping straight runs merged so a shared edge is cut once.
 *
 * The network is split into strokes: continuous cuts that run straight through junctions and
 * follow curves. Strokes are then ordered so that, where possible, each one starts at the sheet
 * edge or on a cut already made. A stroke that can't is a plunge: it starts mid-material.
 */
export type CutSegment = { a: Pt; b: Pt; shared: boolean };
export type Stroke = { pts: Pt[]; closed: boolean; plunge: boolean; length: number };
export type CutNetwork = {
  segments: CutSegment[];
  /** In cutting order. */
  strokes: Stroke[];
  plunges: number;
  length: number;
  sharedLength: number;
  /** The same parts cut one closed loop at a time, for comparison. */
  separate: { length: number; loops: number };
};

const SCALE = 1000;
const TOL = 0.05; // mm: lines closer than this are the same line

function toolPaths(regions: Region[], halfBit: number): Pt[][] {
  const co = new ClipperLib.ClipperOffset(2, 0.05 * SCALE);
  const polys = regions.flatMap((r) => [r.outer, ...r.holes]);
  co.AddPaths(
    polys.map((p) => p.map((q) => ({ X: Math.round(q.x * SCALE), Y: Math.round(q.y * SCALE) }))),
    ClipperLib.JoinType.jtMiter,
    ClipperLib.EndType.etClosedPolygon,
  );
  const out: ClipperLib.Paths = [];
  co.Execute(out, halfBit * SCALE);
  return out.map((p) => p.map((q) => ({ x: q.X / SCALE, y: q.Y / SCALE })));
}

/** Parameter range of the segment a→b inside the sheet rectangle (Liang–Barsky). */
function clipToSheet(a: Pt, b: Pt, w: number, h: number): [number, number] | null {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x], [dx, w - a.x], [-dy, a.y], [dy, h - a.y]]) {
    if (Math.abs(p) < 1e-12) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return t1 - t0 > 1e-9 ? [t0, t1] : null;
}

/** `edgeMargin`: lines this close to the sheet edge get a lead-in so the cut can start at the edge. */
export function cutNetwork(parts: Region[][], kerf: number, w: number, h: number, edgeMargin = 0): CutNetwork {
  const half = kerf / 2;
  type Raw = { ang: number; off: number; t0: number; t1: number };
  const raws: Raw[] = [];
  let sepLength = 0, loops = 0;

  for (const regions of parts) {
    for (const path of toolPaths(regions, half)) {
      loops++;
      for (let i = 0; i < path.length; i++) {
        const a = path[i], b = path[(i + 1) % path.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1e-6) continue;
        sepLength += len;
        const clip = clipToSheet(a, b, w, h);
        if (!clip) continue; // runs outside the sheet: the factory edge does this cut
        // Canonical line: direction angle in [0, π), signed offset of the line from the origin.
        let ang = Math.atan2(b.y - a.y, b.x - a.x);
        if (ang < 0) ang += Math.PI;
        // Quantize so near-identical directions sort together.
        ang = Math.round(ang * 1e5) / 1e5;
        if (ang >= Math.PI - 1e-5) ang = 0;
        const dx = Math.cos(ang), dy = Math.sin(ang);
        const off = -dy * a.x + dx * a.y;
        const p0 = { x: a.x + (b.x - a.x) * clip[0], y: a.y + (b.y - a.y) * clip[0] };
        const p1 = { x: a.x + (b.x - a.x) * clip[1], y: a.y + (b.y - a.y) * clip[1] };
        const s0 = dx * p0.x + dy * p0.y, s1 = dx * p1.x + dy * p1.y;
        raws.push({ ang, off, t0: Math.min(s0, s1), t1: Math.max(s0, s1) });
      }
    }
  }

  // Group collinear runs, then split each line at every endpoint and count coverage.
  raws.sort((p, q) => p.ang - q.ang || p.off - q.off);
  const segments: CutSegment[] = [];
  let length = 0, sharedLength = 0;
  for (let i = 0; i < raws.length; ) {
    let j = i + 1;
    while (j < raws.length && raws[j].ang === raws[i].ang && raws[j].off - raws[j - 1].off < TOL) j++;
    const line = raws.slice(i, j);
    i = j;
    const ang = line[0].ang, off = line.reduce((s, r) => s + r.off, 0) / line.length;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const at = (t: number): Pt => ({ x: dx * t - dy * off, y: dy * t + dx * off });
    const cuts = [...new Set(line.flatMap((r) => [r.t0, r.t1]).map((t) => Math.round(t / TOL) * TOL))].sort((p, q) => p - q);
    for (let k = 0; k < cuts.length - 1; k++) {
      const m = (cuts[k] + cuts[k + 1]) / 2;
      const cover = line.filter((r) => r.t0 - TOL <= m && m <= r.t1 + TOL).length;
      if (!cover) continue;
      const len = cuts[k + 1] - cuts[k];
      if (len < TOL) continue;
      const prev = segments[segments.length - 1];
      const shared = cover > 1;
      const a = at(cuts[k]);
      // Fuse with the previous piece when it continues the same run.
      if (prev && prev.shared === shared && Math.hypot(prev.b.x - a.x, prev.b.y - a.y) < 1e-6 && sameLine(prev, ang)) {
        prev.b = at(cuts[k + 1]);
      } else {
        segments.push({ a, b: at(cuts[k + 1]), shared });
      }
      length += len;
      if (shared) sharedLength += len;
    }
  }

  const strokes = planStrokes(splitAtJunctions(segments), w, h, edgeMargin + kerf + 1);
  const leadIn = strokes.reduce((a, k) => a + k.length, 0) - length;
  length += Math.max(0, leadIn);
  return {
    segments, strokes, plunges: strokes.filter((k) => k.plunge).length,
    length, sharedLength, separate: { length: sepLength, loops },
  };
}

function sameLine(s: CutSegment, ang: number) {
  let a = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
  if (a < 0) a += Math.PI;
  return Math.abs(a - ang) < 1e-4 || Math.abs(Math.abs(a - ang) - Math.PI) < 1e-4;
}

/** Split segments wherever another segment ends on them, so T-junctions become graph nodes. */
function splitAtJunctions(segments: CutSegment[]): CutSegment[] {
  const ends = segments.flatMap((s) => [s.a, s.b]);
  const out: CutSegment[] = [];
  for (const s of segments) {
    const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
    const L = Math.hypot(dx, dy);
    const ts: number[] = [];
    for (const p of ends) {
      const t = ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / (L * L);
      if (t * L <= TOL || (1 - t) * L <= TOL) continue;
      const dist = Math.abs((p.x - s.a.x) * dy - (p.y - s.a.y) * dx) / L;
      if (dist < TOL * 2) ts.push(t);
    }
    ts.sort((p, q) => p - q);
    let prev = s.a;
    for (const t of [...ts, 1]) {
      const p = t === 1 ? s.b : { x: s.a.x + dx * t, y: s.a.y + dy * t };
      if (Math.hypot(p.x - prev.x, p.y - prev.y) > TOL) out.push({ a: prev, b: p, shared: s.shared });
      prev = p;
    }
  }
  return out;
}

function planStrokes(segments: CutSegment[], w: number, h: number, maxLead: number): Stroke[] {
  // Snap endpoints into shared nodes.
  const nodes: Pt[] = [];
  const grid = new Map<string, number[]>();
  const cell = TOL * 4;
  const nodeOf = (p: Pt) => {
    const gx = Math.round(p.x / cell), gy = Math.round(p.y / cell);
    for (let ix = gx - 1; ix <= gx + 1; ix++) for (let iy = gy - 1; iy <= gy + 1; iy++) {
      for (const n of grid.get(`${ix},${iy}`) ?? []) if (Math.hypot(nodes[n].x - p.x, nodes[n].y - p.y) < TOL * 2) return n;
    }
    nodes.push(p);
    const key = `${gx},${gy}`;
    grid.set(key, [...(grid.get(key) ?? []), nodes.length - 1]);
    return nodes.length - 1;
  };
  const edges = segments.map((s) => ({ u: nodeOf(s.a), v: nodeOf(s.b) })).filter((e) => e.u !== e.v);
  const adj = nodes.map(() => [] as number[]);
  edges.forEach((e, i) => { adj[e.u].push(i); adj[e.v].push(i); });
  const other = (e: number, n: number) => (edges[e].u === n ? edges[e].v : edges[e].u);
  const dirFrom = (e: number, n: number) => {
    const m = other(e, n);
    const dx = nodes[m].x - nodes[n].x, dy = nodes[m].y - nodes[n].y;
    const l = Math.hypot(dx, dy) || 1;
    return { x: dx / l, y: dy / l };
  };

  // Lead-ins: a line that stops just short of the sheet edge is carried on to the edge, so the
  // cut starts from outside the material instead of plunging. Only through waste: the ray must
  // not meet any other cut on the way.
  const baseEdges = edges.length;
  const nodeCount = nodes.length;
  for (let n = 0; n < nodeCount; n++) {
    const p = nodes[n];
    if (Math.min(p.x, p.y, w - p.x, h - p.y) > maxLead) continue;
    for (const e of [...adj[n]]) {
      if (e >= baseEdges) continue;
      const back = dirFrom(e, n);
      const d = { x: -back.x, y: -back.y };
      if (adj[n].some((f) => f !== e && (() => { const q = dirFrom(f, n); return q.x * d.x + q.y * d.y > 0.9998; })())) continue;
      const tb = Math.min(
        d.x < -1e-9 ? -p.x / d.x : d.x > 1e-9 ? (w - p.x) / d.x : Infinity,
        d.y < -1e-9 ? -p.y / d.y : d.y > 1e-9 ? (h - p.y) / d.y : Infinity,
      );
      if (!(tb > TOL && tb <= maxLead)) continue;
      const blocked = edges.slice(0, baseEdges).some((f) => {
        const a = nodes[f.u], b = nodes[f.v];
        const ex = b.x - a.x, ey = b.y - a.y;
        const den = d.x * ey - d.y * ex;
        if (Math.abs(den) < 1e-12) return false;
        const t = ((a.x - p.x) * ey - (a.y - p.y) * ex) / den;
        const u = ((a.x - p.x) * d.y - (a.y - p.y) * d.x) / den;
        return t > TOL && t < tb - TOL && u > 1e-6 && u < 1 - 1e-6;
      });
      if (blocked) continue;
      const m = nodeOf({ x: p.x + d.x * tb, y: p.y + d.y * tb });
      if (m === n) continue;
      adj.push([]);
      edges.push({ u: n, v: m });
      adj[n].push(edges.length - 1);
      (adj[m] ??= []).push(edges.length - 1);
    }
  }

  // At each node, decide which edges continue into each other: any two at a plain bend,
  // and straight-through pairs at a junction.
  const partner = new Map<string, number>();
  const pk = (n: number, e: number) => `${n}:${e}`;
  adj.forEach((es, n) => {
    if (es.length === 2) { partner.set(pk(n, es[0]), es[1]); partner.set(pk(n, es[1]), es[0]); return; }
    const free = new Set(es);
    for (const a of es) {
      if (!free.has(a)) continue;
      const da = dirFrom(a, n);
      let best = -1, bestDot = -Math.cos(Math.PI / 180);
      for (const b of free) {
        if (b === a) continue;
        const db = dirFrom(b, n);
        const d = da.x * db.x + da.y * db.y;
        if (d < bestDot) { bestDot = d; best = b; }
      }
      if (best >= 0) {
        free.delete(a); free.delete(best);
        partner.set(pk(n, a), best); partner.set(pk(n, best), a);
      }
    }
  });

  // Walk strokes.
  const seen = new Set<number>();
  type Raw = { nodes: number[]; closed: boolean; length: number };
  const raws: Raw[] = [];
  for (let e0 = 0; e0 < edges.length; e0++) {
    if (seen.has(e0)) continue;
    // Back up to the start of this stroke (or detect a loop).
    let e = e0, n = edges[e0].u, closed = false;
    for (;;) {
      const p = partner.get(pk(n, e));
      if (p === undefined) break;
      if (p === e0) { closed = true; break; }
      n = other(p, n);
      e = p;
    }
    const list = [n];
    let length = 0;
    for (;;) {
      seen.add(e);
      const m = other(e, n);
      length += Math.hypot(nodes[m].x - nodes[n].x, nodes[m].y - nodes[n].y);
      list.push(m);
      const p = partner.get(pk(m, e));
      if (p === undefined || seen.has(p)) break;
      n = m;
      e = p;
    }
    raws.push({ nodes: list, closed, length });
  }

  // Order: prefer the longest stroke that can start from an edge; otherwise plunge.
  const onBorder = (n: number) => {
    const p = nodes[n];
    return p.x <= TOL * 2 || p.y <= TOL * 2 || p.x >= w - TOL * 2 || p.y >= h - TOL * 2;
  };
  const cutNodes = new Set<number>();
  const startable = (n: number) => onBorder(n) || cutNodes.has(n);
  const todo = [...raws];
  const plan: Stroke[] = [];
  while (todo.length) {
    let pick = -1, start = -1;
    todo.forEach((r, i) => {
      const ends = r.closed ? r.nodes : [r.nodes[0], r.nodes[r.nodes.length - 1]];
      const s = ends.find(startable);
      if (s !== undefined && (pick < 0 || r.length > todo[pick].length)) { pick = i; start = s; }
    });
    const plunge = pick < 0;
    if (plunge) pick = todo.reduce((b, r, i) => (r.length > todo[b].length ? i : b), 0);
    const r = todo.splice(pick, 1)[0];
    let ns = r.nodes;
    if (!plunge) {
      if (r.closed) { const i = ns.indexOf(start); ns = [...ns.slice(i, -1), ...ns.slice(0, i), ns[i]]; }
      else if (ns[0] !== start) ns = [...ns].reverse();
    }
    for (const n of ns) cutNodes.add(n);
    plan.push({ pts: ns.map((n) => nodes[n]), closed: r.closed, plunge, length: r.length });
  }
  return plan;
}
