import ClipperLib from 'clipper-lib';

export type Pt = { x: number; y: number };
export type Poly = Pt[];

/** A flat region: one outer boundary (CCW) with zero or more holes (CW). */
export type Region = { outer: Poly; holes: Poly[] };

// Clipper works in integers; 1 unit = 1 micron.
const SCALE = 1000;

const toPath = (p: Poly) => p.map((q) => ({ X: Math.round(q.x * SCALE), Y: Math.round(q.y * SCALE) }));
const fromPath = (p: ClipperLib.Path): Poly => p.map((q) => ({ x: q.X / SCALE, y: q.Y / SCALE }));

export function area(p: Poly): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j].x + p[i].x) * (p[j].y - p[i].y);
  return -a / 2;
}

export const regionArea = (r: Region) => Math.abs(area(r.outer)) - r.holes.reduce((s, h) => s + Math.abs(area(h)), 0);

function treeToRegions(tree: ClipperLib.PolyTree): Region[] {
  const out: Region[] = [];
  const walk = (node: ClipperLib.PolyNode) => {
    for (const child of node.Childs()) {
      // Outer contours sit at even depths, holes at odd depths.
      const holes = child.Childs().map((h) => fromPath(h.Contour()));
      out.push({ outer: fromPath(child.Contour()), holes });
      for (const h of child.Childs()) walk(h);
    }
  };
  walk(tree);
  return out;
}

/** Union of many (possibly overlapping, any orientation) polygons into clean regions. */
export function unionAll(polys: Poly[], cleanTol = 0.02): Region[] {
  const c = new ClipperLib.Clipper();
  const paths = polys.filter((p) => p.length >= 3).map(toPath);
  for (const p of paths) if (!ClipperLib.Clipper.Orientation(p)) p.reverse();
  c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  const regions = treeToRegions(tree);
  return regions
    .map((r) => ({
      outer: dropCollinear(fromPath(ClipperLib.Clipper.CleanPolygon(toPath(r.outer), cleanTol * SCALE))),
      holes: r.holes
        .map((h) => dropCollinear(fromPath(ClipperLib.Clipper.CleanPolygon(toPath(h), cleanTol * SCALE))))
        .filter((h) => h.length >= 3 && Math.abs(area(h)) > 0.5),
    }))
    .filter((r) => r.outer.length >= 3 && Math.abs(area(r.outer)) > 0.5);
}

/** `keep` minus `cut` (both as oriented polygon lists), as clean regions. */
export function subtract(keep: Poly[], cut: Poly[]): Region[] {
  const c = new ClipperLib.Clipper();
  c.AddPaths(keep.map(toPath), ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(cut.map(toPath), ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctDifference, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return treeToRegions(tree);
}

/** Grow (delta > 0) or shrink regions, rounding corners. Returns oriented polygons (outers CCW, holes CW). */
export function offsetRegions(rs: Region[], delta: number): Poly[] {
  const polys = rs.flatMap((r) => [r.outer, ...r.holes]);
  if (Math.abs(delta) < 1e-6) return polys;
  const co = new ClipperLib.ClipperOffset(2, 0.05 * SCALE);
  co.AddPaths(polys.map(toPath), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const sol: ClipperLib.Paths = [];
  co.Execute(sol, delta * SCALE);
  return sol.map(fromPath);
}

/** Remove points that lie on a straight line between their neighbours (tessellation noise). */
function dropCollinear(p: Poly, tol = 0.01): Poly {
  if (p.length < 4) return p;
  const out: Poly = [];
  for (let i = 0; i < p.length; i++) {
    const a = out.length ? out[out.length - 1] : p[p.length - 1];
    const b = p[i];
    const c = p[(i + 1) % p.length];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const len = Math.hypot(c.x - a.x, c.y - a.y) || 1;
    if (Math.abs(cross) / len > tol) out.push(b);
  }
  return out.length >= 3 ? out : p;
}

export function convexHull(pts: Pt[]): Poly {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-9) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-9) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Angle (radians) that rotates the hull onto its minimum-area bounding rectangle, long side along x. */
export function minAreaRectAngle(hull: Poly): number {
  let best = { area: Infinity, angle: 0 };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const ang = -Math.atan2(b.y - a.y, b.x - a.x);
    const bb = bbox(rotatePoly(hull, ang));
    const w = bb.maxX - bb.minX;
    const h = bb.maxY - bb.minY;
    const ar = w * h;
    if (ar < best.area - 1e-6) best = { area: ar, angle: w >= h ? ang : ang + Math.PI / 2 };
  }
  return best.angle;
}

export type BBox = { minX: number; minY: number; maxX: number; maxY: number };

export function bbox(p: Pt[]): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of p) {
    if (q.x < minX) minX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.x > maxX) maxX = q.x;
    if (q.y > maxY) maxY = q.y;
  }
  return { minX, minY, maxX, maxY };
}

export function rotatePoly(p: Poly, ang: number): Poly {
  const c = Math.cos(ang), s = Math.sin(ang);
  return p.map((q) => ({ x: q.x * c - q.y * s, y: q.x * s + q.y * c }));
}

/** 2D rigid transform: rotate by `rot` then translate by (tx, ty). */
export type Xform = { rot: number; tx: number; ty: number };

export function applyXform(p: Poly, t: Xform): Poly {
  const c = Math.cos(t.rot), s = Math.sin(t.rot);
  return p.map((q) => ({ x: q.x * c - q.y * s + t.tx, y: q.x * s + q.y * c + t.ty }));
}

/** Compose: first `a`, then `b`. */
export function composeXform(a: Xform, b: Xform): Xform {
  const c = Math.cos(b.rot), s = Math.sin(b.rot);
  return { rot: a.rot + b.rot, tx: a.tx * c - a.ty * s + b.tx, ty: a.tx * s + a.ty * c + b.ty };
}

/** If a polygon is (close to) a circle, return its centre and radius. */
export function asCircle(p: Poly): { cx: number; cy: number; r: number } | null {
  if (p.length < 12) return null;
  let cx = 0, cy = 0;
  for (const q of p) { cx += q.x; cy += q.y; }
  cx /= p.length; cy /= p.length;
  const rs = p.map((q) => Math.hypot(q.x - cx, q.y - cy));
  const r = rs.reduce((a, b) => a + b, 0) / rs.length;
  return rs.every((v) => Math.abs(v - r) < Math.max(0.05, r * 0.01)) ? { cx, cy, r } : null;
}
