import * as THREE from 'three';

/**
 * Procedural plywood: birch face veneer (grain runs along u) and a cross-section
 * of plies for cut edges (v = 0..1 across the thickness).
 * UV scale: face textures repeat every FACE_MM millimetres.
 */
export const FACE_MM = 900;

let cache: { face: THREE.Texture; edge: THREE.Texture } | null = null;

function rand(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

/**
 * Smooth value noise that repeats every `px` lattice cells across and `py` down, so anything
 * built from it tiles. Sample with u, v in 0..1 (one tile).
 */
function periodicNoise(px: number, py: number, r: () => number) {
  const lat = new Float32Array(px * py).map(() => r() * 2 - 1);
  const s = (t: number) => t * t * (3 - 2 * t);
  return (u: number, v: number) => {
    const x = u * px, y = v * py;
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = s(x - xi), fy = s(y - yi);
    const x0 = ((xi % px) + px) % px, y0 = ((yi % py) + py) % py;
    const x1 = (x0 + 1) % px, y1 = (y0 + 1) % py;
    const a = lat[y0 * px + x0], b = lat[y0 * px + x1], c = lat[y1 * px + x0], d = lat[y1 * px + x1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

/** Octaves of periodic noise, each twice as fine; about -1..1. */
function periodicFbm(px: number, py: number, octaves: number, r: () => number) {
  const layers = Array.from({ length: octaves }, (_, o) => periodicNoise(px << o, py << o, r));
  return (u: number, v: number) => {
    let sum = 0, amp = 1, norm = 0;
    for (const n of layers) { sum += n(u, v) * amp; norm += amp; amp *= 0.5; }
    return sum / norm;
  };
}

/**
 * Rotary-cut birch veneer. The peeler cuts across the growth rings at a slight, wandering angle,
 * so the rings show as long contour lines that bunch into ovals and flames. Here that is a smooth
 * field (rows across the grain, bent by low-frequency noise) whose whole-number crossings are the
 * ring lines: each one sharp on one side and fading on the other, as latewood shades into
 * earlywood. Fibre streaks along the grain, a little blotchy colour and a few pin knots finish it.
 * Grain runs along u (x); every term repeats across the tile.
 */
function faceTexture(): THREE.Texture {
  const W = 1024, H = 1024;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const r = rand(11);
  const warp = periodicFbm(1, 3, 5, r); // the big ovals and flames, long along the grain
  const ripple = periodicFbm(3, 20, 3, r); // smaller wobble in each line
  const strength = periodicFbm(2, 7, 3, r); // some rings show strongly, others barely
  const tone = periodicFbm(1, 4, 4, r); // long light and dark bands
  const fibre = periodicNoise(3, 640, r); // streaks along the grain
  const fibre2 = periodicNoise(12, 1800, r); // finer streaks
  const fleck = periodicNoise(70, 900, r); // pores and tiny dark specks
  const RINGS = 40, BEND = 9;
  // Pin knots: small dark eyes the ring lines swirl around.
  const knots = Array.from({ length: 2 }, () => ({ u: r(), v: r(), rad: 0.004 + r() * 0.003 }));
  const base = [232, 213, 176], light = [244, 231, 203], dark = [178, 136, 86];
  const img = g.createImageData(W, H);
  const d = img.data;
  for (let j = 0; j < H; j++) {
    const v = j / H;
    for (let i = 0; i < W; i++) {
      const u = i / W;
      let swirl = 0, knot = 0;
      for (const k of knots) {
        // Wrapped distance, so knots near an edge tile too; stretched along the grain.
        const du = (((u - k.u + 1.5) % 1) - 0.5) * 0.45, dv = ((v - k.v + 1.5) % 1) - 0.5;
        const q = Math.hypot(du, dv) / k.rad;
        swirl += 1.1 / (1 + q * q * 0.12);
        knot = Math.max(knot, Math.exp(-q * q * 0.9));
      }
      const t = v * RINGS + warp(u, v) * BEND + ripple(u, v) * 0.35 + swirl;
      const f = t - Math.floor(t);
      // A soft band that darkens toward a crisp edge where the next ring starts.
      const ringLine = 0.55 * Math.pow(f, 3) + 0.45 * Math.exp(-f * 4) * 0.4 + 0.5 * Math.exp(-(1 - f) * 55);
      const show = Math.max(0, Math.min(1, 0.25 + 0.9 * (strength(u, v) * 0.5 + 0.5)));
      let m = ringLine * show * 0.34; // toward dark
      const lift = Math.max(0, Math.min(1, tone(u, v) * 0.7 + 0.5)); // toward light
      m += Math.max(0, fibre(u, v)) * 0.09 + Math.max(0, fibre2(u, v)) * 0.06;
      if (fleck(u, v) > 0.86) m += 0.12;
      m = Math.min(1, m + knot * 0.45);
      const idx = (j * W + i) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const b = base[ch] + (light[ch] - base[ch]) * lift * 0.55;
        d[idx + ch] = b + (dark[ch] - b) * m - knot * 10 * (ch === 2 ? 1.2 : 1);
      }
      d[idx + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function edgeTexture(): THREE.Texture {
  const W = 512, H = 256, plies = 11;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const r = rand(3);
  for (let i = 0; i < plies; i++) {
    const y0 = (i / plies) * H, y1 = ((i + 1) / plies) * H;
    // Alternate long-grain (light, smooth) and end-grain (darker, speckled) plies.
    const cross = i % 2 === 1;
    g.fillStyle = cross ? '#c9a46e' : '#e8d2a6';
    g.fillRect(0, y0, W, y1 - y0);
    for (let k = 0; k < (cross ? 900 : 120); k++) {
      g.fillStyle = `rgba(110,75,35,${cross ? 0.08 + r() * 0.15 : 0.05 + r() * 0.08})`;
      g.fillRect(r() * W, y0 + r() * (y1 - y0), cross ? 1 + r() * 2 : 8 + r() * 30, 1);
    }
    // Glue line.
    g.fillStyle = 'rgba(90,60,30,0.55)';
    g.fillRect(0, y1 - 1.5, W, 1.5);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** [face, edge] materials. Textures are shared; materials are per object so they can fade. */
export function plywoodMaterials(tint = 0xffffff): [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial] {
  cache ??= { face: faceTexture(), edge: edgeTexture() };
  const common = { roughness: 0.82, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
  return [
    new THREE.MeshStandardMaterial({ ...common, map: cache.face, color: tint }),
    new THREE.MeshStandardMaterial({ ...common, map: cache.edge, color: tint }),
  ];
}
