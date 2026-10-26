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

function faceTexture(): THREE.Texture {
  const W = 1024, H = 1024;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e4cc9f';
  g.fillRect(0, 0, W, H);
  const r = rand(7);
  // Broad colour drifts, then fine grain lines. Every wave uses whole cycles across W so it tiles.
  for (let i = 0; i < 26; i++) {
    const y0 = r() * H, amp = 6 + r() * 30, cyc = 1 + Math.floor(r() * 3), ph = r() * 6.28;
    g.strokeStyle = r() < 0.5 ? 'rgba(190,140,80,0.10)' : 'rgba(255,240,215,0.12)';
    g.lineWidth = 20 + r() * 50;
    for (const dy of [-H, 0, H]) {
      g.beginPath();
      for (let x = 0; x <= W; x += 8) g.lineTo(x, y0 + dy + amp * Math.sin((x / W) * cyc * 2 * Math.PI + ph));
      g.stroke();
    }
  }
  for (let i = 0; i < 260; i++) {
    const y0 = r() * H, amp = 2 + r() * 14, cyc = 1 + Math.floor(r() * 4), ph = r() * 6.28;
    const cyc2 = 3 + Math.floor(r() * 6), amp2 = r() * 3;
    g.strokeStyle = `rgba(${120 + r() * 50},${80 + r() * 30},${40 + r() * 20},${0.05 + r() * 0.16})`;
    g.lineWidth = 0.6 + r() * 1.8;
    for (const dy of [-H, 0, H]) {
      g.beginPath();
      for (let x = 0; x <= W; x += 6) {
        g.lineTo(x, y0 + dy + amp * Math.sin((x / W) * cyc * 2 * Math.PI + ph) + amp2 * Math.sin((x / W) * cyc2 * 2 * Math.PI));
      }
      g.stroke();
    }
  }
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
