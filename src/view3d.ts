import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Part } from './parts';
import { composeXform, type Region, type Xform } from './geom';
import { plywoodMaterials, FACE_MM } from './plywood';

const EDGE_MM = 400;

export type SheetPlacement = { key: string; part: Part; xform: Xform; sheet: number };
/** `regions`: the sheet material left after cutting, in sheet coordinates. */
export type Sheet3D = { ox: number; oy: number; w: number; h: number; t: number; label: string; regions: Region[] };

type Actor = {
  obj: THREE.Group;
  mats: THREE.Material[];
  start: { pos: THREE.Vector3; quat: THREE.Quaternion };
  end: { pos: THREE.Vector3; quat: THREE.Quaternion } | null; // null = not on any sheet: fades out
  delay: number;
};

const LINE_OPACITY = 0.3;
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

/**
 * Non-indexed part geometry with two groups: 0 = faces parallel to the panel (veneer),
 * 1 = everything else (cut edges, showing plies). Face UVs follow `uvMatrix` (the part's
 * pose on its sheet) so the grain runs on from the sheet into the part.
 */
function partGeometry(p: Part, uvMatrix: THREE.Matrix4 | null): { geo: THREE.BufferGeometry; centre: THREE.Vector3 } {
  const { positions: P, normals: N, indices: I, faces } = p.mesh;
  const [u, v, n] = [p.frame.u, p.frame.v, p.frame.n];
  const dot = (i: number, a: number[]) => P[i * 3] * a[0] + P[i * 3 + 1] * a[1] + P[i * 3 + 2] * a[2];
  const batches: number[][] = [[], []]; // triangle indices per group
  for (const f of faces) {
    const t = f.first;
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    const e1 = new THREE.Vector3(P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]);
    const e2 = new THREE.Vector3(P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]);
    const fn = e1.cross(e2).normalize();
    const cap = Math.abs(fn.x * n[0] + fn.y * n[1] + fn.z * n[2]) > 0.99;
    for (let k = f.first; k <= f.last; k++) batches[cap ? 0 : 1].push(k);
  }
  const count = (batches[0].length + batches[1].length) * 3;
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), uv = new Float32Array(count * 2);
  const q = new THREE.Vector3();
  let o = 0;
  const geo = new THREE.BufferGeometry();
  batches.forEach((tris, group) => {
    const start = o;
    for (const t of tris) {
      for (let k = 0; k < 3; k++, o++) {
        const i = I[t * 3 + k];
        pos.set([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], o * 3);
        if (N) nor.set([N[i * 3], N[i * 3 + 1], N[i * 3 + 2]], o * 3);
        if (uvMatrix) q.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).applyMatrix4(uvMatrix);
        else q.set(dot(i, u), dot(i, v), 0);
        if (group === 0) uv.set([q.x / FACE_MM, q.y / FACE_MM], o * 2);
        else uv.set([(q.x + q.y) / EDGE_MM, (dot(i, n) - p.frame.nMin) / p.thickness], o * 2);
      }
    }
    geo.addGroup(start, o - start, group);
  });
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (!N) geo.computeVertexNormals();
  geo.computeBoundingBox();
  const centre = geo.boundingBox!.getCenter(new THREE.Vector3());
  geo.translate(-centre.x, -centre.y, -centre.z);
  return { geo, centre };
}

/** The sheet left over after cutting: extruded regions, UV-mapped like the parts. */
function sheetGeometry(s: Sheet3D): THREE.BufferGeometry {
  const shapes = s.regions.map((r) => {
    const shape = new THREE.Shape(r.outer.map((p) => new THREE.Vector2(p.x, p.y)));
    shape.holes = r.holes.map((h) => new THREE.Path(h.map((p) => new THREE.Vector2(p.x, p.y))));
    return shape;
  });
  const geo = new THREE.ExtrudeGeometry(shapes, { depth: s.t, bevelEnabled: false, curveSegments: 1 });
  const pos = geo.getAttribute('position');
  const uv = geo.getAttribute('uv');
  for (const g of geo.groups) {
    for (let i = g.start; i < g.start + g.count; i++) {
      const x = pos.getX(i) + s.ox, y = pos.getY(i) + s.oy, z = pos.getZ(i);
      if (g.materialIndex === 0) uv.setXY(i, x / FACE_MM, y / FACE_MM);
      else uv.setXY(i, (x + y) / EDGE_MM, z / s.t);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

/** Rigid transform that lays a part flat on a sheet at the given 2D placement. */
function flatMatrix(p: Part, xform: Xform, sheet: Sheet3D) {
  const t = composeXform(p.base, xform);
  const c = Math.cos(t.rot), s = Math.sin(t.rot);
  const [u, v, n] = [p.frame.u, p.frame.v, p.frame.n];
  return new THREE.Matrix4().set(
    c * u[0] - s * v[0], c * u[1] - s * v[1], c * u[2] - s * v[2], t.tx + sheet.ox,
    s * u[0] + c * v[0], s * u[1] + c * v[1], s * u[2] + c * v[2], t.ty + sheet.oy,
    n[0], n[1], n[2], -p.frame.nMin,
    0, 0, 0, 1,
  );
}

export class View3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 5, 200000);
  private controls: OrbitControls;
  private actors: Actor[] = [];
  private sheetGroup = new THREE.Group();
  private actorGroup = new THREE.Group();
  private progress = 0;
  private playing: { from: number; t0: number; dur: number } | null = null;
  private boxes = { start: new THREE.Box3(), end: new THREE.Box3() };
  private userMoved = false;
  onProgress: (t: number) => void = () => {};

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    host.appendChild(this.renderer.domElement);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('start', () => { this.userMoved = true; });

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a66, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.4, -0.7, 1);
    this.scene.add(sun);
    this.scene.add(this.sheetGroup, this.actorGroup);

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (!this.userMoved) this.setProgress(this.progress);
  }

  /** Build the scene: the assembly as modelled, and where each part lands on the sheets. */
  setScene(parts: Part[], placements: SheetPlacement[], sheets: Sheet3D[]) {
    for (const g of [this.sheetGroup, this.actorGroup]) {
      g.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
          o.geometry.dispose();
          for (const m of [o.material].flat()) (m as THREE.Material).dispose();
        }
      });
      g.clear();
    }
    this.actors = [];

    const sheetBox = new THREE.Box3();
    for (const s of sheets) {
      // The offcut reads a shade darker than the parts cut from it.
      const mesh = new THREE.Mesh(sheetGeometry(s), plywoodMaterials(0xc8bba6));
      mesh.position.set(s.ox, s.oy, 0);
      this.sheetGroup.add(mesh);
      sheetBox.expandByObject(mesh);
    }

    // Stand the assembly on the floor in the middle of the sheets.
    const asm = new THREE.Box3();
    for (const p of parts) {
      const pos = p.mesh.positions;
      for (let i = 0; i < pos.length; i += 3) asm.expandByPoint(new THREE.Vector3(pos[i], pos[i + 1], pos[i + 2]));
    }
    const sheetsCentre = sheetBox.isEmpty() ? new THREE.Vector3() : sheetBox.getCenter(new THREE.Vector3());
    const shift = new THREE.Vector3(sheetsCentre.x - (asm.min.x + asm.max.x) / 2, sheetsCentre.y - (asm.min.y + asm.max.y) / 2, -asm.min.z);

    const sheetsOf = new Map(placements.map((pl) => [pl.key, pl]));
    const keys: { part: Part; key: string | null }[] = [];
    for (const p of parts) {
      const mine = placements.filter((pl) => pl.part.id === p.id);
      if (!mine.length) keys.push({ part: p, key: null });
      for (const pl of mine) keys.push({ part: p, key: pl.key });
    }
    // Top parts leave first, so the assembly comes apart from the top down.
    keys.sort((a, b) => partTop(b.part) - partTop(a.part));

    keys.forEach(({ part, key }, i) => {
      const pl = key ? sheetsOf.get(key)! : null;
      const m = pl ? flatMatrix(part, pl.xform, sheets[pl.sheet]) : null;
      const { geo, centre } = partGeometry(part, m);
      const mats = plywoodMaterials();
      const lineMat = new THREE.LineBasicMaterial({ color: 0x4a3a24, transparent: true, opacity: LINE_OPACITY });
      const obj = new THREE.Group();
      obj.add(new THREE.Mesh(geo, mats));
      obj.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), lineMat));
      this.actors.push({
        obj,
        mats: [...mats, lineMat],
        start: { pos: centre.clone().add(shift), quat: new THREE.Quaternion() },
        end: m ? { pos: centre.clone().applyMatrix4(m), quat: new THREE.Quaternion().setFromRotationMatrix(m) } : null,
        delay: keys.length > 1 ? (i / (keys.length - 1)) * 0.45 : 0,
      });
      this.actorGroup.add(obj);
    });

    const asmShifted = asm.clone().translate(shift);
    this.boxes = { start: asmShifted, end: sheetBox.isEmpty() ? asmShifted : sheetBox };
    this.userMoved = false;
    this.setProgress(this.progress);
  }

  /** Camera pose that fits `box` in view, looking along `dir` (z up). */
  private frame(box: THREE.Box3, dir: THREE.Vector3) {
    const target = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const d = dir.clone().normalize();
    const elev = Math.asin(d.z);
    // Approximate on-screen extent: width across, depth foreshortened, height upright.
    const across = Math.max(size.x, size.y * Math.abs(d.x)) / this.camera.aspect;
    const tall = size.y * Math.sin(elev) + size.z * Math.cos(elev);
    const half = Math.max(across, tall) / 2;
    const dist = (half / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.15 + Math.max(size.x, size.y) * 0.2;
    return { pos: target.clone().add(d.multiplyScalar(dist)), target };
  }

  setProgress(t: number) {
    this.progress = t;
    for (const a of this.actors) {
      const p = ease(Math.min(1, Math.max(0, (t - a.delay) / 0.55)));
      if (a.end) {
        a.obj.position.lerpVectors(a.start.pos, a.end.pos, p);
        // Lift each part clear of the assembly while it turns.
        a.obj.position.z += Math.sin(Math.PI * p) * 220;
        a.obj.quaternion.slerpQuaternions(a.start.quat, a.end.quat, p);
        a.mats.forEach((m) => setOpacity(m, m instanceof THREE.LineBasicMaterial ? LINE_OPACITY : 1));
      } else {
        a.obj.position.copy(a.start.pos);
        a.obj.quaternion.copy(a.start.quat);
        a.mats.forEach((m) => setOpacity(m, (1 - p) * (m instanceof THREE.LineBasicMaterial ? LINE_OPACITY : 1)));
      }
      a.obj.visible = a.end !== null || p < 1;
    }
    if (!this.userMoved || this.playing) {
      const k = ease(t);
      const a = this.frame(this.boxes.start, new THREE.Vector3(1.1, -1.6, 0.9));
      const b = this.frame(this.boxes.end, new THREE.Vector3(0, -0.3, 1));
      this.camera.position.lerpVectors(a.pos, b.pos, k);
      this.controls.target.lerpVectors(a.target, b.target, k);
      this.controls.update();
    }
  }

  play(dur = 4500) {
    const from = this.progress >= 0.999 ? 0 : this.progress;
    this.userMoved = false;
    this.playing = { from, t0: performance.now(), dur: dur * (1 - from) };
  }

  pause() { this.playing = null; }
  get isPlaying() { return this.playing !== null; }

  private tick() {
    if (this.playing) {
      const { from, t0, dur } = this.playing;
      const t = Math.min(1, from + ((performance.now() - t0) / Math.max(1, dur)) * (1 - from));
      this.setProgress(t);
      this.onProgress(t);
      if (t >= 1) this.playing = null;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

/** Opaque solids sort and depth-test cleanly; only fading ones go transparent. */
function setOpacity(m: THREE.Material, o: number) {
  m.opacity = o;
  m.transparent = o < 1;
}

function partTop(p: Part) {
  let z = -Infinity;
  for (let i = 2; i < p.mesh.positions.length; i += 3) z = Math.max(z, p.mesh.positions[i]);
  return z;
}
