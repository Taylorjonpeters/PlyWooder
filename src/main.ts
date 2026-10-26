import occtimportjs from 'occt-import-js';
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import { partsFromStep, type Part, type Occt } from './parts';
import { groupItems, placedShapes, type MaterialGroup, type PartChoice, type PlacedShape } from './layout';
import { gapOf, type NestResult, type NestSettings, type CutLine } from './nest';
import type { NestRequest } from './nest.worker';
import { toDxf, toSvg, type DxfSheet } from './dxf';
import { View3D, type Sheet3D, type SheetPlacement } from './view3d';
import { fmtLen, toUnits, fromUnits, type Units } from './units';
import { bbox, offsetRegions, subtract, type Poly, type Pt } from './geom';
import type { CutNetwork } from './cutpaths';

type Settings = NestSettings & { units: Units; dxfUnits: Units; preset: string; showCuts: boolean };

const DEFAULTS: Settings = {
  sheetW: 2438.4, sheetH: 1219.2, preset: '2438.4x1219.2',
  edgeMargin: 12.7, kerf: 6.35, errorGap: 3.2, shareCuts: true,
  mode: 'optimal', shape: 'true', rotation: 'free90', effort: 'normal',
  units: 'mm', dxfUnits: 'mm', showCuts: true,
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const STORE = 'plywooder.settings.v1';

type Packed = { settings: NestSettings; groups: MaterialGroup[] };

function loadSettings(): Settings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) ?? '{}') }; } catch { return { ...DEFAULTS }; }
}

const state = {
  settings: loadSettings(),
  fileName: '',
  parts: [] as Part[],
  choices: new Map<number, PartChoice>(),
  /** The layout on screen and the packing settings it was made with. */
  shown: null as Packed | null,
  /** Packed layouts by settings, so flipping between modes or back to old settings is instant. */
  cache: new Map<string, Packed>(),
  busy: false,
  tab: 'sheets' as 'sheets' | '3d',
  autoplayPending: false,
};

// ---------------------------------------------------------------------------
// STEP loading
// ---------------------------------------------------------------------------

let occtPromise: Promise<Occt> | null = null;
const getOcct = () => (occtPromise ??= occtimportjs({ locateFile: () => occtWasmUrl }) as Promise<Occt>);

async function openFile(file: File) {
  setStatus(`Reading ${file.name}…`, true);
  try {
    const [occt, buf] = await Promise.all([getOcct(), file.arrayBuffer()]);
    const parts = partsFromStep(occt, new Uint8Array(buf));
    state.fileName = file.name;
    state.parts = parts;
    state.choices = new Map(parts.map((p) => [p.id, { include: p.isPanel, qty: 1 }]));
    state.cache.clear();
    state.shown = null;
    $('fileName').textContent = file.name;
    $('fileHint').textContent = `${parts.length} solids · click to open another`;
    renderParts();
    $('empty').hidden = true;
    state.autoplayPending = true;
    view3d.setScene(parts, [], []);
    showTab('3d');
    repack();
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't read that file: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Nesting (in a worker). Results are cached by packing settings; changing a setting
// shows a cached layout if there is one, otherwise offers a Repack.
// ---------------------------------------------------------------------------

let worker: Worker | null = null;
let jobId = 0;

/** The settings that affect packing, for one mode. */
function nestSettings(mode = state.settings.mode): NestSettings {
  const { units: _u, dxfUnits: _d, preset: _p, showCuts: _c, ...rest } = state.settings;
  return { ...rest, mode };
}

function packKey(s: NestSettings): string {
  const choices = [...state.choices].map(([id, c]) => (c.include ? `${id}x${c.qty}` : '')).join(',');
  return JSON.stringify([
    s.mode, s.sheetW, s.sheetH, s.edgeMargin, s.kerf, s.shareCuts, s.shareCuts ? 0 : s.errorGap,
    s.shape, s.rotation, s.mode === 'optimal' ? s.effort : '', choices,
  ]);
}

/** Called after any change to a packing setting or part choice. */
function settingsChanged() {
  saveSettings();
  if (!state.parts.length) return;
  const hit = state.cache.get(packKey(nestSettings()));
  if (hit) { state.shown = hit; render(); }
  updateRepack();
}

function updateRepack() {
  const stale = !!state.parts.length && !state.cache.has(packKey(nestSettings()));
  $('repack').hidden = !stale || state.busy;
  if (state.busy) return;
  if (stale) setStatus('Settings changed — repack to update the layout');
  else if (state.shown) {
    const n = state.shown.groups.reduce((a, g) => a + g.items.length, 0);
    const sheets = state.shown.groups.reduce((a, g) => a + (g.result?.sheets.length ?? 0), 0);
    setStatus(n ? `${n} parts on ${sheets} sheet${sheets === 1 ? '' : 's'}` : 'No parts selected');
  }
}

/** Pack the current settings in both modes (the saw layout is nearly free), then show the current one. */
function repack() {
  saveSettings();
  const groups = groupItems(state.parts, state.choices);
  const modes = [state.settings.mode, state.settings.mode === 'optimal' ? 'easy' : 'optimal'] as const;
  const jobs = modes.map((m) => nestSettings(m)).filter((s, i) => i === 0 || !state.cache.has(packKey(s)));
  if (!groups.length) {
    for (const s of jobs) state.cache.set(packKey(s), { settings: s, groups: [] });
    settingsChanged();
    render();
    return;
  }
  worker?.terminate();
  worker = new Worker(new URL('./nest.worker.ts', import.meta.url), { type: 'module' });
  const id = ++jobId;
  const n = groups.reduce((a, g) => a + g.items.length, 0);
  state.busy = true;
  $('repack').hidden = true;
  setStatus(`Packing ${n} parts…`, true);
  worker.onmessage = (e: MessageEvent<{ id: number; results: NestResult[][] }>) => {
    if (e.data.id !== id) return;
    state.busy = false;
    jobs.forEach((s, j) => state.cache.set(packKey(s), { settings: s, groups: groups.map((g, i) => ({ ...g, result: e.data.results[j][i] })) }));
    // Show the current settings if they were packed; if they changed mid-pack, show what was packed.
    state.shown = state.cache.get(packKey(nestSettings())) ?? state.cache.get(packKey(jobs[0]))!;
    render();
    updateRepack();
  };
  worker.onerror = (e) => { state.busy = false; setStatus(`Packing failed: ${e.message}`); updateRepack(); };
  const req: NestRequest = { id, jobs: jobs.map((settings) => ({ settings, groups: groups.map((g) => g.items) })) };
  worker.postMessage(req);
}

/** Display settings with the packed layout's own packing settings (sheet size, mode, …). */
function view(): Settings {
  return { ...state.settings, ...(state.shown?.settings ?? {}) };
}

const shownGroups = () => state.shown?.groups ?? [];

function setStatus(text: string, busy = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('busy', busy);
}

function saveSettings() {
  try { localStorage.setItem(STORE, JSON.stringify(state.settings)); } catch { /* storage unavailable */ }
}

// ---------------------------------------------------------------------------
// Sidebar controls
// ---------------------------------------------------------------------------

const lenInputs = ['sheetW', 'sheetH', 'edgeMargin', 'kerf', 'errorGap'] as const;

function syncControls() {
  const s = state.settings;
  for (const k of lenInputs) {
    const el = $<HTMLInputElement>(k);
    if (document.activeElement !== el) el.value = String(toUnits(s[k], s.units));
  }
  $<HTMLSelectElement>('sheetPreset').value = s.preset;
  $<HTMLSelectElement>('rotation').value = s.rotation;
  $<HTMLSelectElement>('effort').value = s.effort;
  for (const seg of ['mode', 'shape', 'units', 'dxfUnits'] as const) {
    for (const b of $(seg).querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === s[seg]);
  }
  $<HTMLInputElement>('shareCuts').checked = s.shareCuts;
  $<HTMLInputElement>('showCuts').checked = s.showCuts;
  $<HTMLInputElement>('errorGap').disabled = s.shareCuts;
  $('errorGapRow').style.opacity = s.shareCuts ? '0.45' : '';
  $('gapHint').innerHTML = s.shareCuts
    ? `Neighbouring parts sit exactly one bit apart (<b>${fmtLen(gapOf(s), s.units)}</b>), so one pass cuts both edges. Any error is shared, so there's no extra gap.`
    : `Parts end up at least <b>${fmtLen(gapOf(s), s.units)}</b> apart, and each is cut on its own.`;
  $('modeHint').textContent = s.mode === 'optimal'
    ? 'Nests the true shapes as tightly as it can, including inside holes. Best for a CNC.'
    : 'Straight, edge-to-edge cuts only: crosscut strips, rip rows, crosscut parts. Best for a table or track saw.';
}

function bindControls() {
  const s = state.settings;
  $<HTMLSelectElement>('sheetPreset').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    s.preset = v;
    if (v !== 'custom') { const [w, h] = v.split('x').map(Number); s.sheetW = w; s.sheetH = h; }
    syncControls();
    settingsChanged();
  });
  for (const k of lenInputs) {
    $<HTMLInputElement>(k).addEventListener('input', (e) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (!Number.isFinite(v) || v < 0 || ((k === 'sheetW' || k === 'sheetH') && v <= 0)) return;
      s[k] = fromUnits(v, s.units);
      if (k === 'sheetW' || k === 'sheetH') {
        // Keep the long side on x.
        if (s.sheetH > s.sheetW) [s.sheetW, s.sheetH] = [s.sheetH, s.sheetW];
        s.preset = 'custom';
      }
      syncControls();
      settingsChanged();
    });
    $<HTMLInputElement>(k).addEventListener('change', () => { $<HTMLInputElement>(k).blur(); syncControls(); });
  }
  $<HTMLSelectElement>('rotation').addEventListener('change', (e) => { s.rotation = (e.target as HTMLSelectElement).value as Settings['rotation']; settingsChanged(); });
  $<HTMLSelectElement>('effort').addEventListener('change', (e) => { s.effort = (e.target as HTMLSelectElement).value as Settings['effort']; settingsChanged(); });
  const seg = <K extends 'mode' | 'shape' | 'units' | 'dxfUnits'>(key: K, after: () => void) =>
    $(key).addEventListener('click', (e) => {
      const v = (e.target as HTMLElement).closest('button')?.dataset.v;
      if (!v || v === s[key]) return;
      (s as Record<K, string>)[key] = v;
      syncControls();
      after();
    });
  seg('mode', () => settingsChanged());
  // Packing with hulls keeps parts out of each other's notches, so a shape change re-nests.
  seg('shape', () => settingsChanged());
  seg('units', () => { renderParts(); render(); saveSettings(); });
  seg('dxfUnits', saveSettings);
  $<HTMLInputElement>('shareCuts').addEventListener('change', (e) => { s.shareCuts = (e.target as HTMLInputElement).checked; syncControls(); settingsChanged(); });
  $<HTMLInputElement>('showCuts').addEventListener('change', (e) => { s.showCuts = (e.target as HTMLInputElement).checked; saveSettings(); render(); });

  $<HTMLInputElement>('file').addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) openFile(f);
    (e.target as HTMLInputElement).value = '';
  });
  let depth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; $('dropOverlay').classList.add('on'); });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('dropOverlay').classList.remove('on'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    $('dropOverlay').classList.remove('on');
    const f = e.dataTransfer?.files[0];
    if (f) openFile(f);
  });

  for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button[data-tab]')) {
    b.addEventListener('click', () => showTab(b.dataset.tab as 'sheets' | '3d'));
  }
  $('repack').addEventListener('click', repack);
  $('exportAll').addEventListener('click', () => {
    const all = shownGroups().flatMap((g, gi) => (g.result?.sheets ?? []).map((_, si) => dxfSheet(gi, si)));
    download(`${baseName()}_all-sheets.dxf`, toDxf(all, s.dxfUnits), 'application/dxf');
  });

  $('play').addEventListener('click', () => {
    if (view3d.isPlaying) view3d.pause(); else view3d.play();
    $('play').textContent = view3d.isPlaying ? '❚❚' : '▶';
  });
  $<HTMLInputElement>('scrub').addEventListener('input', (e) => {
    view3d.pause();
    $('play').textContent = '▶';
    view3d.setProgress(Number((e.target as HTMLInputElement).value) / 1000);
  });
}

function showTab(tab: 'sheets' | '3d') {
  state.tab = tab;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
  $('sheetsPane').hidden = tab !== 'sheets';
  $('viewPane').hidden = tab !== '3d';
}

function renderParts() {
  const { units } = state.settings;
  $('partsSection').hidden = !state.parts.length;
  const used = state.parts.filter((p) => state.choices.get(p.id)?.include).length;
  $('partsCount').textContent = `· ${used} of ${state.parts.length} on sheets`;
  const host = $('parts');
  host.innerHTML = '';
  for (const p of state.parts) {
    const c = state.choices.get(p.id)!;
    const row = document.createElement('div');
    row.className = `part${c.include ? '' : ' off'}`;
    row.dataset.part = String(p.id);
    row.innerHTML = `
      <input type="checkbox" ${c.include ? 'checked' : ''} aria-label="Include ${esc(p.name)}" />
      <div class="name" title="${esc(p.name)}">${esc(p.name)}
        <span class="dims">${fmtLen(p.w, units, false)} × ${fmtLen(p.h, units, false)} × ${fmtLen(p.thickness, units)}${p.isPanel ? '' : ' · not flat stock'}</span></div>
      <input type="number" min="0" step="1" value="${c.qty}" aria-label="Quantity" title="Quantity" />`;
    const [check, qty] = row.querySelectorAll('input');
    check.addEventListener('change', () => { c.include = check.checked; renderParts(); settingsChanged(); });
    qty.addEventListener('input', () => {
      const v = Math.max(0, Math.min(99, Math.round(Number(qty.value))));
      if (!Number.isFinite(v)) return;
      c.qty = v;
      settingsChanged();
    });
    row.addEventListener('mouseenter', () => highlight(p.id, true));
    row.addEventListener('mouseleave', () => highlight(p.id, false));
    host.appendChild(row);
  }
}

function highlight(partId: number, on: boolean) {
  for (const el of document.querySelectorAll(`[data-part="${partId}"]`)) el.classList.toggle('hot', on);
}

// ---------------------------------------------------------------------------
// Sheet rendering
// ---------------------------------------------------------------------------

function render() {
  const s = view();
  $('empty').hidden = !!state.parts.length;
  $('exportSection').hidden = !shownGroups().some((g) => g.result?.sheets.length);
  const host = $('sheets');
  host.innerHTML = '';
  shownGroups().forEach((g, gi) => {
    const r = g.result;
    if (!r) return;
    const sec = document.createElement('div');
    sec.className = 'group';
    const used = r.sheets.reduce((a, sh) => a + sh.usedArea, 0) / (r.sheets.length * s.sheetW * s.sheetH || 1);
    sec.innerHTML = `<h3>${fmtLen(g.thickness, s.units)} stock<small>${r.sheets.length} sheet${r.sheets.length === 1 ? '' : 's'} · ${g.items.length} parts · ${(used * 100).toFixed(0)}% material used</small></h3>`;
    if (r.unplaced.length) {
      const names = [...new Set(r.unplaced.map((k) => state.parts[Number(k.split('#')[0])].name))];
      sec.insertAdjacentHTML('beforeend', `<div class="warn">Too big for this sheet even on its own: ${names.map(esc).join(', ')}</div>`);
    }
    r.sheets.forEach((sh, si) => {
      const shapes = placedShapes(state.parts, sh.placements, s.shape);
      const card = document.createElement('div');
      card.className = 'sheetCard';
      card.innerHTML = `
        <div class="sheetHead">
          <b>Sheet ${si + 1} of ${r.sheets.length}</b>
          <span class="meta">${sh.placements.length} parts · ${((sh.usedArea / (s.sheetW * s.sheetH)) * 100).toFixed(0)}% used · ${fmtLen(s.sheetW, s.units, false)} × ${fmtLen(s.sheetH, s.units)}</span>
          <span class="actions"><button class="ghost" data-x="dxf">DXF</button><button class="ghost" data-x="svg">SVG</button></span>
        </div>
        ${cutStats(sh.network)}
        ${sheetSvg(shapes, s.mode === 'easy' && !s.showCuts ? sh.cuts : [], s.showCuts ? sh.network : undefined)}
        ${s.mode === 'easy' && sh.steps.length ? `<details class="steps"><summary>Cut order</summary><ol>${sh.steps.map((t) => `<li>${esc(stepText(t))}</li>`).join('')}</ol></details>` : ''}`;
      card.querySelector('[data-x="dxf"]')!.addEventListener('click', () =>
        download(`${baseName()}_${g.thickness}mm_sheet${si + 1}.dxf`, toDxf([dxfSheet(gi, si)], s.dxfUnits), 'application/dxf'));
      card.querySelector('[data-x="svg"]')!.addEventListener('click', () =>
        download(`${baseName()}_${g.thickness}mm_sheet${si + 1}.svg`, toSvg(dxfSheet(gi, si)), 'image/svg+xml'));
      for (const el of card.querySelectorAll<SVGElement>('.piece')) {
        const id = Number(el.dataset.part);
        el.addEventListener('mouseenter', () => highlight(id, true));
        el.addEventListener('mouseleave', () => highlight(id, false));
      }
      sec.appendChild(card);
    });
    host.appendChild(sec);
  });
  update3d();
}

/** Steps are written in mm by the nester; re-express lengths in display units. */
function stepText(t: string) {
  return state.settings.units === 'mm' ? t.replace(/(\d+(?:\.\d+)?)(?= wide| deep| from)/g, '$1 mm') : t.replace(/(\d+(?:\.\d+)?)(?= wide| deep| from)/g, (m) => fmtLen(Number(m), 'in'));
}

/** Metres or feet of cutting. */
const fmtRun = (mm: number) => (state.settings.units === 'in' ? `${(mm / 304.8).toFixed(1)} ft` : `${(mm / 1000).toFixed(1)} m`);

function cutStats(net?: CutNetwork): string {
  if (!net) return '';
  const saved = 1 - net.length / net.separate.length;
  return `<div class="cutStats">
    <span><b>${net.plunges}</b> plunge${net.plunges === 1 ? '' : 's'} (cuts that start mid-sheet)</span>
    <span><b>${net.strokes.length}</b> passes</span>
    <span><b>${fmtRun(net.length)}</b> of cutting${saved > 0.005 ? ` · ${(saved * 100).toFixed(0)}% less than cutting each part on its own` : ''}</span>
    ${net.sharedLength > 0 ? `<span class="key"><span class="swatch"></span><b>${fmtRun(net.sharedLength)}</b> shared</span>` : ''}
  </div>`;
}

function sheetSvg(shapes: PlacedShape[], cuts: CutLine[], net?: CutNetwork): string {
  const s = view();
  const W = s.sheetW, H = s.sheetH;
  const y = (v: number) => (H - v).toFixed(1);
  const d = (p: Poly) => 'M' + p.map((q) => `${q.x.toFixed(1)},${y(q.y)}`).join('L') + 'Z';
  const pad = Math.max(24, W / 45);
  const out: string[] = [];
  out.push(`<svg viewBox="${-pad} ${-pad} ${W + 2 * pad} ${H + 2 * pad}" role="img" aria-label="Sheet layout"${net ? ' class="cutsOn"' : ''}>`);
  out.push(`<rect class="sheetRect" x="0" y="0" width="${W}" height="${H}"/>`);
  if (s.edgeMargin > 0) out.push(`<rect class="marginRect" x="${s.edgeMargin}" y="${s.edgeMargin}" width="${W - 2 * s.edgeMargin}" height="${H - 2 * s.edgeMargin}"/>`);
  for (const sh of shapes) {
    const path = sh.regions.map((r) => [r.outer, ...r.holes].map(d).join('')).join('');
    out.push(`<path class="piece" data-part="${sh.part.id}" d="${path}"><title>${esc(sh.part.name)} — ${fmtLen(sh.part.w, s.units, false)} × ${fmtLen(sh.part.h, s.units)}</title></path>`);
    for (const pk of sh.pockets) {
      out.push(`<path class="pocket" d="${pk.regions.map((r) => [r.outer, ...r.holes].map(d).join('')).join('')}"><title>Pocket ${fmtLen(pk.depth, s.units)} deep${pk.side === 'bottom' ? ' (back face)' : ''}</title></path>`);
    }
  }
  if (net) {
    // Plain cuts first, shared runs on top; a ring marks where each plunge starts.
    for (const shared of [false, true]) {
      const segs = net.segments.filter((g) => g.shared === shared);
      if (segs.length) out.push(`<path class="cutSeg${shared ? ' shared' : ''}" d="${segs.map((g) => `M${g.a.x.toFixed(1)},${y(g.a.y)}L${g.b.x.toFixed(1)},${y(g.b.y)}`).join('')}"/>`);
    }
    const leads = net.strokes.flatMap((k) => k.pts.slice(1).map((p, i) => [k.pts[i], p] as const))
      .filter(([a, b]) => !net.segments.some((g) => onSeg(g.a, g.b, a) && onSeg(g.a, g.b, b)));
    if (leads.length) out.push(`<path class="cutSeg" d="${leads.map(([a, b]) => `M${a.x.toFixed(1)},${y(a.y)}L${b.x.toFixed(1)},${y(b.y)}`).join('')}"/>`);
    for (const k of net.strokes) if (k.plunge) out.push(`<circle class="plunge" cx="${k.pts[0].x.toFixed(1)}" cy="${y(k.pts[0].y)}" r="${(W / 220).toFixed(1)}"><title>Plunge</title></circle>`);
  }
  for (const c of cuts) {
    out.push(`<line class="guide s${c.stage}" x1="${c.x1.toFixed(1)}" y1="${y(c.y1)}" x2="${c.x2.toFixed(1)}" y2="${y(c.y2)}"/>`);
    if (c.stage === 1) out.push(`<text class="guideLbl" x="${c.x1.toFixed(1)}" y="-8" font-size="${Math.max(18, W / 60).toFixed(0)}" text-anchor="middle">${c.label}</text>`);
  }
  for (const sh of shapes) {
    const bb = bbox(sh.regions.flatMap((r) => r.outer));
    const bw = bb.maxX - bb.minX, bh = bb.maxY - bb.minY;
    const vertical = bh > bw * 1.25;
    const room = vertical ? bh : bw;
    const name = sh.part.name + (sh.copy ? ` #${sh.copy + 1}` : '');
    const size = Math.max(10, Math.min(sh.label.size, (room * 0.9) / Math.max(4, name.length * 0.6), (vertical ? bw : bh) * 0.3));
    const cx = sh.label.x.toFixed(1), cy = y(sh.label.y);
    const rot = vertical ? ` transform="rotate(-90 ${cx} ${cy})"` : '';
    out.push(`<text class="lbl" x="${cx}" y="${cy}" font-size="${size.toFixed(1)}" text-anchor="middle"${rot}>${esc(name)}<tspan class="d" x="${cx}" dy="${(size * 1.15).toFixed(1)}" font-size="${(size * 0.8).toFixed(1)}">${fmtLen(sh.part.w, s.units, false)} × ${fmtLen(sh.part.h, s.units, s.units === 'in')}</tspan></text>`);
  }
  out.push('</svg>');
  return out.join('');
}

function onSeg(a: Pt, b: Pt, p: Pt) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (L * L);
  return t > -0.01 && t < 1.01 && Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / L < 0.2;
}

function dxfSheet(gi: number, si: number): DxfSheet {
  const s = view();
  const g = shownGroups()[gi];
  const sh = g.result!.sheets[si];
  return {
    w: s.sheetW,
    h: s.sheetH,
    shapes: placedShapes(state.parts, sh.placements, s.shape),
    cuts: s.mode === 'easy' ? sh.cuts : [],
    strokes: sh.network?.strokes ?? [],
    title: `${g.thickness} mm - sheet ${si + 1}`,
  };
}

// ---------------------------------------------------------------------------
// 3D
// ---------------------------------------------------------------------------

const view3d = new View3D($('view3d'));
view3d.onProgress = (t) => {
  $<HTMLInputElement>('scrub').value = String(Math.round(t * 1000));
  if (t >= 1) $('play').textContent = '▶';
};

function update3d() {
  const s = view();
  const sheets: Sheet3D[] = [];
  const placements: SheetPlacement[] = [];
  const gap = 200;
  shownGroups().forEach((g, gi) => {
    g.result?.sheets.forEach((sh, si) => {
      const idx = sheets.length;
      // Cut the parts out of the sheet, leaving the kerf gap as a groove around each one.
      const cut = offsetRegions(placedShapes(state.parts, sh.placements, 'true').flatMap((p) => p.regions), Math.max(0.3, gapOf(s) / 2 - 0.3));
      const rect = [{ x: 0, y: 0 }, { x: s.sheetW, y: 0 }, { x: s.sheetW, y: s.sheetH }, { x: 0, y: s.sheetH }];
      sheets.push({
        ox: si * (s.sheetW + gap), oy: -gi * (s.sheetH + gap), w: s.sheetW, h: s.sheetH, t: g.thickness,
        label: `${g.thickness} mm · ${si + 1}`, regions: subtract([rect], cut),
      });
      for (const pl of sh.placements) placements.push({ key: `${gi}:${pl.key}`, part: state.parts[pl.partId], xform: pl.xform, sheet: idx });
    });
  });
  view3d.setScene(state.parts, placements, sheets);
  if (state.autoplayPending && sheets.length) {
    state.autoplayPending = false;
    view3d.setProgress(0);
    setTimeout(() => { view3d.play(); $('play').textContent = '❚❚'; }, 600);
  }
}

// ---------------------------------------------------------------------------

function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const baseName = () => state.fileName.replace(/\.(step|stp)$/i, '') || 'layout';
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

bindControls();
syncControls();
render();
// Expose a loader for scripted testing (e.g. from the browser console).
(window as unknown as { plywooderOpen: typeof openFile }).plywooderOpen = openFile;
