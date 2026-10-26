import {
  type Poly, type Region, type Xform,
  unionAll, convexHull, minAreaRectAngle, rotatePoly, bbox, applyXform, regionArea,
} from './geom';

export type V3 = [number, number, number];

export type MeshData = {
  positions: Float32Array;
  normals: Float32Array | null;
  indices: Uint32Array;
  /** Triangle ranges [first, last] (inclusive) for each B-rep face. */
  faces: { first: number; last: number }[];
};

export type Pocket = { regions: Region[]; depth: number; side: 'top' | 'bottom' };

export type Part = {
  id: number;
  name: string;
  mesh: MeshData;
  thickness: number;
  /** Panel frame: n is the thickness axis; (u, v, n) is right-handed. */
  frame: { u: V3; v: V3; n: V3; nMin: number };
  /** Maps (p·u, p·v) into the part's normalized 2D space (bbox at origin, long side on x). */
  base: Xform;
  /** True through-cut profile (outer boundary + through holes). */
  regions: Region[];
  hull: Poly;
  pockets: Pocket[];
  w: number;
  h: number;
  area: number;
  /** Looks like a flat sheet part (thin relative to its footprint). */
  isPanel: boolean;
};

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function vtx(m: MeshData, i: number): V3 {
  const k = m.indices[i] * 3;
  return [m.positions[k], m.positions[k + 1], m.positions[k + 2]];
}

/** Triangle t's vertices. */
function tri(m: MeshData, t: number): [V3, V3, V3] {
  return [vtx(m, t * 3), vtx(m, t * 3 + 1), vtx(m, t * 3 + 2)];
}

type FaceInfo = { normal: V3; area: number; planar: boolean; offset: number; first: number; last: number };

function analyzeFaces(m: MeshData): FaceInfo[] {
  return m.faces.map(({ first, last }) => {
    let acc: V3 = [0, 0, 0];
    let total = 0;
    const ns: V3[] = [];
    for (let t = first; t <= last; t++) {
      const [a, b, c] = tri(m, t);
      const cr = cross(sub(b, a), sub(c, a));
      const l = len(cr);
      if (l < 1e-9) continue;
      total += l / 2;
      acc = [acc[0] + cr[0], acc[1] + cr[1], acc[2] + cr[2]];
      ns.push([cr[0] / l, cr[1] / l, cr[2] / l]);
    }
    const normal = norm(acc);
    const planar = ns.length > 0 && ns.every((q) => dot(q, normal) > 0.9995);
    const offset = ns.length ? dot(tri(m, first)[0], normal) : 0;
    return { normal, area: total, planar, offset, first, last };
  });
}

/** Project the given triangles onto the (u, v) plane, dropping walls that project to slivers. */
function projectTris(m: MeshData, u: V3, v: V3, n: V3, ranges: { first: number; last: number }[]): Poly[] {
  const out: Poly[] = [];
  for (const { first, last } of ranges) {
    for (let t = first; t <= last; t++) {
      const [a, b, c] = tri(m, t);
      const cr = cross(sub(b, a), sub(c, a));
      const l = len(cr);
      if (l < 1e-9 || Math.abs(dot(cr, n)) / l < 1e-3) continue;
      out.push([a, b, c].map((p) => ({ x: dot(p, u), y: dot(p, v) })));
    }
  }
  return out;
}

export function buildPart(id: number, name: string, mesh: MeshData): Part {
  const faces = analyzeFaces(mesh);
  const planar = faces.filter((f) => f.planar);
  const main = (planar.length ? planar : faces).reduce((a, b) => (b.area > a.area ? b : a));
  const n = main.normal;

  // Pick u perpendicular to n, using the world axis least aligned with n.
  const axes: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const ref = axes.reduce((a, b) => (Math.abs(dot(b, n)) < Math.abs(dot(a, n)) ? b : a));
  const u = norm(cross(ref, n));
  const v = cross(n, u);

  let nMin = Infinity, nMax = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const d = mesh.positions[i] * n[0] + mesh.positions[i + 1] * n[1] + mesh.positions[i + 2] * n[2];
    if (d < nMin) nMin = d;
    if (d > nMax) nMax = d;
  }
  const thickness = nMax - nMin;

  const allFaces = faces.map(({ first, last }) => ({ first, last }));
  const rawRegions = unionAll(projectTris(mesh, u, v, n, allFaces));

  // Normalize: rotate onto the minimum-area rectangle (long side on x), then shift bbox to origin.
  const hull0 = convexHull(rawRegions.flatMap((r) => r.outer));
  const ang = minAreaRectAngle(hull0);
  const bb = bbox(rotatePoly(hull0, ang));
  const base: Xform = { rot: ang, tx: -bb.minX, ty: -bb.minY };
  const toLocal = (r: Region): Region => ({ outer: applyXform(r.outer, base), holes: r.holes.map((h) => applyXform(h, base)) });
  const regions = rawRegions.map(toLocal);
  const hull = applyXform(hull0, base);

  // Pockets: faces parallel to the panel that sit strictly between its two skins.
  const tol = 0.2;
  const pocketFaces = new Map<string, { ranges: { first: number; last: number }[]; depth: number; side: 'top' | 'bottom' }>();
  for (const f of planar) {
    const along = dot(f.normal, n);
    if (Math.abs(along) < 0.9995) continue;
    const h = along > 0 ? f.offset : -f.offset;
    if (h <= nMin + tol || h >= nMax - tol) continue;
    const side = along > 0 ? 'top' : 'bottom';
    const depth = side === 'top' ? nMax - h : h - nMin;
    const key = `${side}:${depth.toFixed(2)}`;
    const entry = pocketFaces.get(key) ?? { ranges: [], depth, side };
    entry.ranges.push({ first: f.first, last: f.last });
    pocketFaces.set(key, entry);
  }
  const pockets: Pocket[] = [...pocketFaces.values()].map((p) => ({
    side: p.side,
    depth: p.depth,
    regions: unionAll(projectTris(mesh, u, v, n, p.ranges)).map(toLocal),
  }));

  const bbL = bbox(hull);
  const w = bbL.maxX - bbL.minX;
  const h = bbL.maxY - bbL.minY;
  return {
    id, name, mesh, thickness,
    frame: { u, v, n, nMin },
    base, regions, hull, pockets, w, h,
    area: regions.reduce((s, r) => s + regionArea(r), 0),
    isPanel: thickness <= 40 && thickness * 4 <= Math.min(w, h),
  };
}

/** Solid names straight from the STEP text, in file order (OCCT drops them for multi-body parts). */
export function stepSolidNames(text: string): string[] {
  const re = /(?:MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS)\s*\(\s*'((?:[^']|'')*)'/g;
  const names: string[] = [];
  for (let m; (m = re.exec(text)); ) names.push(m[1].replace(/''/g, "'"));
  return names;
}

type OcctResult = {
  success: boolean;
  meshes: {
    name: string;
    attributes: { position: { array: ArrayLike<number> }; normal?: { array: ArrayLike<number> } };
    index: { array: ArrayLike<number> };
    brep_faces: { first: number; last: number }[];
  }[];
};

export type Occt = { ReadStepFile(content: Uint8Array, params: object): OcctResult };

export function partsFromStep(occt: Occt, bytes: Uint8Array): Part[] {
  const res = occt.ReadStepFile(bytes, {
    linearUnit: 'millimeter',
    linearDeflectionType: 'absolute_value',
    linearDeflection: 0.2,
    angularDeflection: 0.2,
  });
  if (!res.success) throw new Error('Could not read this STEP file.');
  const names = stepSolidNames(new TextDecoder().decode(bytes));
  const useNames = names.length === res.meshes.length;
  return res.meshes.map((m, i) => {
    const mesh: MeshData = {
      positions: Float32Array.from(m.attributes.position.array),
      normals: m.attributes.normal ? Float32Array.from(m.attributes.normal.array) : null,
      indices: Uint32Array.from(m.index.array),
      faces: m.brep_faces.map((f) => ({ first: f.first, last: f.last })),
    };
    const name = (useNames && names[i]) || m.name || `Part ${i + 1}`;
    return buildPart(i, name, mesh);
  });
}
