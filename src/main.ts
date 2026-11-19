import occtimportjs from 'occt-import-js';
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import { partsFromStep, type Part, type Occt } from './parts';
import { partsFromDxf, type DxfUnits } from './dxfImport';
import { groupItems, placedShapes, type MaterialGroup, type PartChoice, type PlacedShape } from './layout';
import { gapOf, type NestResult, type NestSettings } from './nest';
import { throughCuts, type ThroughCut, type ThroughPlan } from './through';
import type { NestRequest, SuggestJob } from './nest.worker';
import type { SuggestResult } from './suggest';
import { toDxf, toSvg, type DxfSheet } from './dxf';
import { CAM_DEFAULTS, DEFAULT_TOOLS, STUDIO_TABLES, currentTable, gordixFit, type CamSettings } from './cam';
import { CamWorkspace, type CamSheetRef } from './camView';
import { initTips } from './tip';
import { setPlayState } from './icons';
import { View3D, type Sheet3D, type SheetPlacement } from './view3d';
import { fmtLen, toUnits, fromUnits, type Units } from './units';
import { bbox, offsetRegions, subtract, type Poly, type Pt } from './geom';
import type { CutNetwork } from './cutpaths';

type Settings = NestSettings & {
  units: Units; dxfUnits: Units; preset: string; showCuts: boolean; showThrough: boolean;
  /** DXF import: drawings are flat, so the stock thickness comes from here. */
  importThickness: number; importUnits: DxfUnits;
  /** How the sheets will be cut; null until chosen, which shows the chooser. */
  workflow: Workflow | null;
  /**
   * The CNC sheet: the GORDIX table's work area, or a custom size (mm). In CNC mode the sheet and
   * the gap between parts come from here and from the outline bit, not from the saw settings.
   */
  cnc: { sheet: 'table' | 'custom'; sheetW: number; sheetH: number; stock: string };
  /** Machine, tables, bits and G-code settings, shared by the sidebar and the G-code tab (mm, mm/min). */
  cam: CamSettings;
};
type Workflow = 'saw' | 'cnc';

const DEFAULTS: Settings = {
  sheetW: 2438.4, sheetH: 1219.2, preset: '2438.4x1219.2',
  edgeMargin: 12.7, kerf: 6.35, errorGap: 3.2, shareCuts: true,
  mode: 'easy', shape: 'true', rotation: 'free90', effort: 'normal',
  units: 'mm', dxfUnits: 'mm', showCuts: false, showThrough: true, importThickness: 18, importUnits: 'auto',
  workflow: null,
  cnc: { sheet: 'table', sheetW: 2438.4, sheetH: 1219.2, stock: '2438.4x1219.2' },
  cam: CAM_DEFAULTS,
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const STORE = 'plywooder.settings.v1';

type Packed = { settings: NestSettings; groups: MaterialGroup[] };
type Tab = 'sheets' | '3d' | 'gcode';

/** Saved CAM settings over the defaults, with fresh copies of the nested lists. */
function camSettings(saved?: Partial<CamSettings>): CamSettings {
  const tools = saved?.tools?.length ? saved.tools : DEFAULT_TOOLS;
  return {
    ...CAM_DEFAULTS, ...saved, tools: tools.map((t) => ({ ...t })), stockActual: { ...saved?.stockActual },
    tables: (saved?.tables ?? []).map((t) => ({ ...t })),
  };
}

function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? '{}');
    return { ...DEFAULTS, ...saved, cnc: { ...DEFAULTS.cnc, ...saved.cnc }, cam: camSettings(saved.cam) };
  } catch { return { ...DEFAULTS, cnc: { ...DEFAULTS.cnc }, cam: camSettings() }; }
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
  tab: 'sheets' as Tab,
  autoplayPending: false,
};

// ---------------------------------------------------------------------------
// STEP loading
// ---------------------------------------------------------------------------

let occtPromise: Promise<Occt> | null = null;
const getOcct = () => (occtPromise ??= occtimportjs({ locateFile: () => occtWasmUrl }) as Promise<Occt>);

/** The open DXF's text, kept so thickness or units can be changed without reopening it. */
let dxfText: string | null = null;

async function openFile(file: File) {
  setStatus(`Reading ${file.name}…`, true);
  try {
    if (/\.dxf$/i.test(file.name)) {
      dxfText = await file.text();
      state.fileName = file.name;
      loadDxf();
    } else {
      const [occt, buf] = await Promise.all([getOcct(), file.arrayBuffer()]);
      dxfText = null;
      state.fileName = file.name;
      loadParts(partsFromStep(occt, new Uint8Array(buf)), 'solids');
    }
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't read that file: ${(err as Error).message}`);
  }
}

function loadDxf() {
  if (dxfText === null) return;
  const s = state.settings;
  const r = partsFromDxf(dxfText, s.importThickness, s.importUnits);
  const notes = [
    `Units: ${r.units}${s.importUnits === 'auto' ? (r.unitsFromFile ? ' (from file)' : ' (file has none; assumed)') : ''}.`,
    r.borders ? `Skipped ${r.borders} sheet border${r.borders > 1 ? 's' : ''}.` : '',
    r.openShapes ? `${r.openShapes} open shape${r.openShapes > 1 ? 's' : ''} didn't close and ${r.openShapes > 1 ? 'were' : 'was'} left out.` : '',
  ];
  $('dxfHint').textContent = notes.filter(Boolean).join(' ');
  if (!r.parts.length) throw new Error('no closed outlines found');
  loadParts(r.parts, 'outlines');
}

function loadParts(parts: Part[], noun: string) {
  state.parts = parts;
  state.choices = new Map(parts.map((p) => [p.id, { include: p.isPanel, qty: 1 }]));
  state.cache.clear();
  state.shown = null;
  $('fileName').textContent = state.fileName;
  $('fileHint').textContent = `${parts.length} ${noun} · click to open another`;
  $('dxfOpts').hidden = dxfText === null;
  syncControls();
  renderParts();
  $('empty').hidden = true;
  state.autoplayPending = true;
  view3d.setScene(parts, [], []);
  showTab('3d');
  repack();
}

// ---------------------------------------------------------------------------
// Nesting (in a worker). Results are cached by packing settings; changing a setting
// shows a cached layout if there is one, otherwise offers a Repack.
// ---------------------------------------------------------------------------

let worker: Worker | null = null;
let jobId = 0;

const isCnc = () => state.settings.workflow === 'cnc';
const outlineBit = () => {
  const c = state.settings.cam;
  return c.tools.find((t) => t.id === c.outlineTool) ?? c.tools[0];
};

/** The CNC sheet size (mm, long side first): the table's work area or the custom size. */
function cncSheetSize(): { w: number; h: number } {
  const s = state.settings;
  if (s.cam.machine === 'gordix' && s.cnc.sheet === 'table') {
    const f = gordixFit(currentTable(s.cam));
    return { w: f.x * 2, h: f.y * 2 };
  }
  return { w: Math.max(s.cnc.sheetW, s.cnc.sheetH), h: Math.min(s.cnc.sheetW, s.cnc.sheetH) };
}

/**
 * The settings that affect packing. Saw mode packs in strips and rows on the saw sheet with the
 * blade width; CNC mode nests true shapes on the machine's sheet with the outline bit's width.
 */
function nestSettings(): NestSettings {
  const s = state.settings;
  const base = {
    edgeMargin: s.edgeMargin, errorGap: s.errorGap, shareCuts: s.shareCuts,
    shape: s.shape, rotation: s.rotation, effort: s.effort,
  };
  if (isCnc()) {
    const { w, h } = cncSheetSize();
    return { ...base, mode: 'optimal', sheetW: w, sheetH: h, kerf: outlineBit().diameter };
  }
  return { ...base, mode: 'easy', sheetW: s.sheetW, sheetH: s.sheetH, kerf: s.kerf };
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

/** True when the layout on screen was packed with different settings from the ones in the sidebar. */
function isStale() {
  return !!state.parts.length && !state.cache.has(packKey(nestSettings()));
}

/**
 * Keep the screen honest about an out-of-date layout: a banner with a Repack button, the sheets
 * dimmed, and every export and G-code action off until the layout is packed again.
 */
function updateRepack() {
  const stale = isStale();
  $('staleBar').hidden = !stale || state.busy;
  applyStale(stale);
  if (state.busy) return;
  if (stale) setStatus('Layout out of date');
  else if (state.shown) {
    const n = state.shown.groups.reduce((a, g) => a + g.items.length, 0);
    const sheets = state.shown.groups.reduce((a, g) => a + (g.result?.sheets.length ?? 0), 0);
    setStatus(n ? `${n} parts on ${sheets} sheet${sheets === 1 ? '' : 's'}` : 'No parts selected');
  }
}

function applyStale(stale: boolean) {
  $('sheets').classList.toggle('stale', stale);
  const actions = document.querySelectorAll<HTMLButtonElement>('#exportAll, #openGcode, #sheets .actions button');
  for (const b of actions) b.disabled = stale;
}

/** Pack the parts with the current settings and show the result. */
function repack() {
  saveSettings();
  const groups = groupItems(state.parts, state.choices);
  const jobs = [nestSettings()];
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
  $('staleBar').hidden = true;
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

const lenInputs = ['sheetW', 'sheetH', 'edgeMargin', 'kerf', 'errorGap', 'importThickness'] as const;

function syncControls() {
  const s = state.settings;
  for (const k of lenInputs) {
    const el = $<HTMLInputElement>(k);
    if (document.activeElement !== el) el.value = String(toUnits(s[k], s.units));
  }
  $<HTMLSelectElement>('sheetPreset').value = s.preset;
  $<HTMLSelectElement>('rotation').value = s.rotation;
  $<HTMLSelectElement>('importUnits').value = s.importUnits;
  $<HTMLSelectElement>('effort').value = s.effort;
  for (const seg of ['workflow', 'shape', 'units', 'dxfUnits'] as const) {
    for (const b of $(seg).querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === s[seg]);
  }
  $<HTMLInputElement>('shareCuts').checked = s.shareCuts;
  $<HTMLInputElement>('showCuts').checked = s.showCuts;
  $<HTMLInputElement>('showThrough').checked = s.showThrough;
  $<HTMLInputElement>('errorGap').disabled = s.shareCuts;
  syncWorkflow();
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
      if (k === 'importThickness') reloadDxf(); else settingsChanged();
    });
    $<HTMLInputElement>(k).addEventListener('change', () => { $<HTMLInputElement>(k).blur(); syncControls(); });
  }
  $<HTMLSelectElement>('importUnits').addEventListener('change', (e) => { s.importUnits = (e.target as HTMLSelectElement).value as DxfUnits; reloadDxf(); });
  $<HTMLSelectElement>('rotation').addEventListener('change', (e) => { s.rotation = (e.target as HTMLSelectElement).value as Settings['rotation']; settingsChanged(); });
  $<HTMLSelectElement>('effort').addEventListener('change', (e) => { s.effort = (e.target as HTMLSelectElement).value as Settings['effort']; settingsChanged(); });
  const seg = <K extends 'workflow' | 'shape' | 'units' | 'dxfUnits'>(key: K, after: () => void) =>
    $(key).addEventListener('click', (e) => {
      const v = (e.target as HTMLElement).closest('button')?.dataset.v;
      if (!v || v === s[key]) return;
      if (key === 'workflow') { setWorkflow(v as Workflow); return; }
      (s as Record<K, string>)[key] = v;
      syncControls();
      after();
    });
  seg('workflow', () => {});
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-flow-pick]')) {
    b.addEventListener('click', () => setWorkflow(b.dataset.flowPick as Workflow));
  }
  bindCnc();
  // Packing with hulls keeps parts out of each other's notches, so a shape change re-nests.
  seg('shape', () => settingsChanged());
  seg('units', () => { renderParts(); render(); saveSettings(); });
  seg('dxfUnits', saveSettings);
  $<HTMLInputElement>('shareCuts').addEventListener('change', (e) => { s.shareCuts = (e.target as HTMLInputElement).checked; syncControls(); settingsChanged(); });
  $<HTMLInputElement>('showThrough').addEventListener('change', (e) => { s.showThrough = (e.target as HTMLInputElement).checked; saveSettings(); render(); });
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
    b.addEventListener('click', () => showTab(b.dataset.tab as Tab));
  }
  $('repack').addEventListener('click', repack);
  $('openGcode').addEventListener('click', () => showTab('gcode'));
  $('exportAll').addEventListener('click', () => {
    const all = shownGroups().flatMap((g, gi) => (g.result?.sheets ?? []).map((_, si) => dxfSheet(gi, si)));
    download(`${baseName()}_all-sheets.dxf`, toDxf(all, s.dxfUnits), 'application/dxf');
  });

  $('play').addEventListener('click', () => {
    if (view3d.isPlaying) view3d.pause(); else view3d.play();
    setPlayState($('play'), view3d.isPlaying);
  });
  $<HTMLInputElement>('scrub').addEventListener('input', (e) => {
    view3d.pause();
    setPlayState($('play'), false);
    view3d.setProgress(Number((e.target as HTMLInputElement).value) / 1000);
  });
}

// ---------------------------------------------------------------------------
// Saw or CNC
// ---------------------------------------------------------------------------

/** Switch between saw and CNC: the sidebar, tabs and packing all follow. */
function setWorkflow(w: Workflow) {
  const s = state.settings;
  const changed = s.workflow !== w;
  s.workflow = w;
  $('chooser').hidden = true;
  syncControls();
  if (state.tab === 'gcode' && w === 'saw') showTab('sheets');
  if (changed && state.parts.length) repack();
  else saveSettings();
}

/** Show the controls for the current workflow, and fill the CNC section from the shared settings. */
function syncWorkflow() {
  const s = state.settings;
  const cnc = isCnc();
  $('chooser').hidden = s.workflow !== null;
  for (const el of document.querySelectorAll<HTMLElement>('[data-flow]')) el.hidden = el.dataset.flow !== (cnc ? 'cnc' : 'saw');
  if (!cnc) return;
  const c = s.cam;
  const gordix = c.machine === 'gordix';
  $<HTMLSelectElement>('cncMachine').value = c.machine;
  $('cncTableRow').hidden = !gordix;
  const tables = c.tables.length ? c.tables : STUDIO_TABLES;
  $('cncTable').innerHTML = tables.map((t) => {
    const f = gordixFit(t);
    return `<option value="${t.id}">${t.id}: ${Math.round(t.S)} × ${Math.round(t.W)} → cuts ${f.x * 2} × ${f.y * 2}</option>`;
  }).join('');
  $<HTMLSelectElement>('cncTable').value = String(currentTable(c).id);
  const sheetSel = $<HTMLSelectElement>('cncSheet');
  sheetSel.querySelector<HTMLOptionElement>('option[value="table"]')!.disabled = !gordix;
  const source = gordix ? s.cnc.sheet : 'custom';
  sheetSel.value = source;
  $('cncCustom').hidden = source !== 'custom';
  for (const k of ['cncW', 'cncH'] as const) {
    const el = $<HTMLInputElement>(k);
    if (document.activeElement !== el) el.value = String(toUnits(k === 'cncW' ? s.cnc.sheetW : s.cnc.sheetH, s.units));
  }
  $('cncBit').innerHTML = c.tools.map((t) => `<option value="${esc(t.id)}">${esc(t.name)} (${Math.round(t.diameter * 1000) / 1000} mm)</option>`).join('');
  $<HTMLSelectElement>('cncBit').value = outlineBit().id;
  $<HTMLSelectElement>('cncStock').value = s.cnc.stock;
  $<HTMLButtonElement>('cncSuggest').disabled = suggesting || !state.parts.length;
  const { w, h } = cncSheetSize();
  const fit = gordix ? gordixFit(currentTable(c)) : null;
  const over = fit && source === 'custom' && (w > fit.x * 2 + 0.5 || h > fit.y * 2 + 0.5);
  $('cncHint').innerHTML = `${fmtLen(w, s.units, false)} × ${fmtLen(h, s.units)} sheet`
    + (over ? ` <b class="warnText">· bigger than the ${fit!.x * 2} × ${fit!.y * 2} mm it reaches</b>` : '');
}

/** The CNC section edits the same machine, table and bit settings as the G-code tab. */
function bindCnc() {
  const s = state.settings;
  const changed = () => { $('cncSuggestHint').hidden = true; syncControls(); settingsChanged(); };
  $<HTMLSelectElement>('cncStock').addEventListener('change', (e) => { s.cnc.stock = (e.target as HTMLSelectElement).value; saveSettings(); });
  $('cncSuggest').addEventListener('click', suggestSize);
  $<HTMLSelectElement>('cncMachine').addEventListener('change', (e) => {
    s.cam.machine = (e.target as HTMLSelectElement).value as CamSettings['machine'];
    s.cam.origin = s.cam.machine === 'gordix' ? 'center' : 'corner';
    changed();
  });
  $<HTMLSelectElement>('cncTable').addEventListener('change', (e) => { s.cam.tableId = Number((e.target as HTMLSelectElement).value); changed(); });
  $<HTMLSelectElement>('cncSheet').addEventListener('change', (e) => { s.cnc.sheet = (e.target as HTMLSelectElement).value as 'table' | 'custom'; changed(); });
  $<HTMLSelectElement>('cncBit').addEventListener('change', (e) => { s.cam.outlineTool = (e.target as HTMLSelectElement).value; changed(); });
  for (const k of ['cncW', 'cncH'] as const) {
    $<HTMLInputElement>(k).addEventListener('input', (e) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (!Number.isFinite(v) || v <= 0) return;
      s.cnc[k === 'cncW' ? 'sheetW' : 'sheetH'] = fromUnits(v, s.units);
      changed();
    });
    $<HTMLInputElement>(k).addEventListener('change', () => { $<HTMLInputElement>(k).blur(); syncControls(); });
  }
}

// ---------------------------------------------------------------------------
// Suggest a CNC sheet size: the smallest piece of the stock sheet (and, on the GORDIX, of what the
// table reaches) that keeps the parts on as few sheets as possible. Runs in its own worker.
// ---------------------------------------------------------------------------

let suggesting = false;
let suggestWorker: Worker | null = null;

function suggestSize() {
  const s = state.settings;
  const groups = groupItems(state.parts, state.choices);
  if (!groups.length || suggesting) return;
  const [sw, sh] = s.cnc.stock.split('x').map(Number);
  let maxW = Math.max(sw, sh), maxH = Math.min(sw, sh);
  const fit = s.cam.machine === 'gordix' ? gordixFit(currentTable(s.cam)) : null;
  if (fit) { maxW = Math.min(maxW, fit.x * 2); maxH = Math.min(maxH, fit.y * 2); }
  if (maxH > maxW) [maxW, maxH] = [maxH, maxW];
  const settings = { ...nestSettings(), sheetW: maxW, sheetH: maxH };
  const step = s.units === 'in' ? 12.7 : 10;
  const btn = $<HTMLButtonElement>('cncSuggest');
  const hint = $('cncSuggestHint');
  suggesting = true;
  btn.disabled = true;
  btn.textContent = 'Searching…';
  hint.hidden = true;
  suggestWorker?.terminate();
  suggestWorker = new Worker(new URL('./nest.worker.ts', import.meta.url), { type: 'module' });
  const done = () => { suggesting = false; btn.textContent = 'Suggest size'; suggestWorker?.terminate(); suggestWorker = null; syncControls(); };
  suggestWorker.onmessage = (e: MessageEvent<{ progress?: number; suggestion?: SuggestResult }>) => {
    if (e.data.progress) { btn.textContent = `Searching… ${e.data.progress}`; return; }
    const r = e.data.suggestion!;
    done();
    s.cnc.sheet = 'custom';
    s.cnc.sheetW = r.w;
    s.cnc.sheetH = r.h;
    const n = r.sheets.reduce((a, b) => a + b, 0);
    const lost = r.unplaced.reduce((a, b) => a + b, 0);
    const stockName = $<HTMLSelectElement>('cncStock').selectedOptions[0]?.text ?? 'stock';
    const limit = fit && (fit.x * 2 < Math.max(sw, sh) || fit.y * 2 < Math.min(sw, sh)) ? `, within the ${fit.x * 2} × ${fit.y * 2} mm the table reaches` : '';
    hint.innerHTML = `Cut ${n === 1 ? 'one piece' : `${n} pieces`}, <b>${fmtLen(r.w, s.units, false)} × ${fmtLen(r.h, s.units)}</b>, from ${n === 1 ? 'a ' : ''}${esc(stockName)} stock${limit}`
      + ` · ${(r.fill * 100).toFixed(0)}% used`
      + (lost ? ` <b class="warnText">· ${lost} part${lost === 1 ? ' is' : 's are'} too big for it</b>` : '');
    hint.hidden = false;
    syncControls();
    if (state.parts.length) repack();
  };
  suggestWorker.onerror = (e) => { done(); setStatus(`Couldn't suggest a size: ${e.message}`); };
  const job: SuggestJob = { id: 0, suggest: { groups: groups.map((g) => g.items), settings, maxW, maxH, step } };
  suggestWorker.postMessage(job);
}

let reloadTimer = 0;
/** Re-read the open DXF after its thickness or units change (debounced while typing). */
function reloadDxf() {
  saveSettings();
  clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => {
    try { loadDxf(); } catch (err) { setStatus(`Couldn't read that file: ${(err as Error).message}`); }
  }, 400);
}

function showTab(tab: Tab) {
  if (tab === 'gcode' && !isCnc()) tab = 'sheets';
  state.tab = tab;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
  $('sheetsPane').hidden = tab !== 'sheets';
  $('viewPane').hidden = tab !== '3d';
  $('gcodePane').hidden = tab !== 'gcode';
  $('layoutSettings').hidden = tab === 'gcode';
  $('camSettings').hidden = tab !== 'gcode';
  if (tab === 'gcode') cam.render();
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
      <div class="name" data-tip="${esc(p.name)}">${esc(p.name)}
        <span class="dims">${fmtLen(p.w, units, false)} × ${fmtLen(p.h, units, false)} × ${fmtLen(p.thickness, units)}${p.isPanel ? '' : ' · not flat stock'}</span></div>
      <input type="number" min="0" step="1" value="${c.qty}" aria-label="Quantity" data-tip="Quantity" />`;
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
  // What the shown layout was packed for, which can lag the workflow until it re-packs.
  const cncView = s.mode === 'optimal';
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
      const plan = throughPlan(shapes);
      const card = document.createElement('div');
      card.className = 'sheetCard';
      card.innerHTML = `
        <div class="sheetHead">
          <b>Sheet ${si + 1} of ${r.sheets.length}</b>
          <span class="meta">${sh.placements.length} parts · ${((sh.usedArea / (s.sheetW * s.sheetH)) * 100).toFixed(0)}% used · ${fmtLen(s.sheetW, s.units, false)} × ${fmtLen(s.sheetH, s.units)}</span>
          <span class="actions"><button class="ghost" data-x="dxf">DXF</button><button class="ghost" data-x="svg">SVG</button>${cncView ? '<button class="ghost" data-x="gcode">G-code</button>' : ''}</span>
        </div>
        ${cncView ? '' : throughStats(plan, shapes)}
        ${cncView && s.showCuts ? cutStats(sh.network) : ''}
        ${sheetSvg(shapes, !cncView && s.showThrough ? plan.cuts : [], cncView && s.showCuts ? sh.network : undefined)}
        ${!cncView && plan.cuts.length ? `<details class="steps"><summary>Through-cut order</summary><ol>${plan.cuts.map((c) => `<li>${esc(cutText(c))}</li>`).join('')}</ol></details>` : ''}`;
      card.querySelector('[data-x="dxf"]')!.addEventListener('click', () =>
        download(`${baseName()}_${g.thickness}mm_sheet${si + 1}.dxf`, toDxf([dxfSheet(gi, si)], s.dxfUnits), 'application/dxf'));
      card.querySelector('[data-x="svg"]')!.addEventListener('click', () =>
        download(`${baseName()}_${g.thickness}mm_sheet${si + 1}.svg`, toSvg(dxfSheet(gi, si)), 'image/svg+xml'));
      card.querySelector('[data-x="gcode"]')?.addEventListener('click', () => {
        const idx = camSheets().findIndex((c) => c.gi === gi && c.si === si);
        showTab('gcode');
        cam.select(Math.max(0, idx));
      });
      for (const el of card.querySelectorAll<SVGElement>('.piece')) {
        const id = Number(el.dataset.part);
        el.addEventListener('mouseenter', () => highlight(id, true));
        el.addEventListener('mouseleave', () => highlight(id, false));
      }
      sec.appendChild(card);
    });
    host.appendChild(sec);
  });
  applyStale(isStale());
  if (state.tab === 'gcode') cam.render();
  update3d();
}

function throughPlan(shapes: PlacedShape[]): ThroughPlan {
  const s = view();
  return throughCuts(shapes.map((p) => ({ key: p.key, regions: p.regions })), s.sheetW, s.sheetH, s.kerf);
}

function throughStats(plan: ThroughPlan, shapes: PlacedShape[]): string {
  const total = shapes.length;
  const lockedNames = [...new Set(plan.locked.map((k) => shapes.find((p) => p.key === k)!.part.name))];
  return `<div class="cutStats">
    <span><b>${plan.cuts.length}</b> through cut${plan.cuts.length === 1 ? '' : 's'}</span>
    <span><b>${plan.freed}</b> of ${total} parts come free with straight cuts</span>
    ${plan.locked.length ? `<span>${plan.locked.length} need a CNC or jigsaw: ${lockedNames.map(esc).join(', ')}</span>` : ''}
  </div>`;
}

/** One line of the through-cut list; the sheet's long side runs left to right. */
function cutText(c: ThroughCut): string {
  const { units } = state.settings;
  const kind = c.vertical ? 'Crosscut' : 'Rip';
  const from = c.vertical ? 'left' : 'bottom';
  return `${kind} ${fmtLen(c.offset, units)} in from the ${from} edge of the piece (${fmtLen(c.length, units)} long).`;
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

function sheetSvg(shapes: PlacedShape[], cuts: ThroughCut[], net?: CutNetwork): string {
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
    out.push(`<line class="guide d${Math.min(c.depth, 2)}" x1="${c.x1.toFixed(1)}" y1="${y(c.y1)}" x2="${c.x2.toFixed(1)}" y2="${y(c.y2)}"/>`);
    // Numbered badge at the start of each cut: top end of a crosscut, left end of a rip.
    const r = Math.max(11, W / 85);
    const bx = c.vertical ? c.x1 : c.x1 + r * 1.4, by = c.vertical ? c.y2 - r * 1.4 : c.y1;
    out.push(`<circle class="badge" cx="${bx.toFixed(1)}" cy="${y(by)}" r="${r.toFixed(1)}"/><text class="badgeTxt" x="${bx.toFixed(1)}" y="${y(by)}" font-size="${(r * 1.1).toFixed(1)}" text-anchor="middle" dominant-baseline="central">${c.label}</text>`);
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
  const shapes = placedShapes(state.parts, sh.placements, s.shape);
  return {
    w: s.sheetW,
    h: s.sheetH,
    shapes,
    cuts: throughPlan(shapes).cuts,
    strokes: sh.network?.strokes ?? [],
    title: `${g.thickness} mm - sheet ${si + 1}`,
  };
}


// ---------------------------------------------------------------------------
// G-code
// ---------------------------------------------------------------------------

/** Every sheet of the shown layout, with true part shapes whatever the display mode. */
function camSheets(): (CamSheetRef & { gi: number; si: number })[] {
  const s = view();
  return shownGroups().flatMap((g, gi) => (g.result?.sheets ?? []).map((sh, si) => ({
    gi, si,
    label: `${g.thickness} mm stock · sheet ${si + 1} of ${g.result!.sheets.length}`,
    fileBase: `${baseName()}_${g.thickness}mm_sheet${si + 1}`,
    sheet: {
      w: s.sheetW, h: s.sheetH, thickness: g.thickness, kerf: s.kerf, edgeMargin: s.edgeMargin,
      shapes: placedShapes(state.parts, sh.placements, 'true'), title: `${g.thickness} mm sheet ${si + 1}`,
    },
  })));
}

const cam = new CamWorkspace({
  sheets: camSheets,
  stale: isStale,
  settings: () => state.settings.cam,
  // Machine, table and outline bit also set the CNC layout, so a change there may need a repack.
  // Only a change to the packing settings touches the layout; other edits just save, so typing in
  // the G-code settings never redraws the panel under the cursor.
  save: () => {
    saveSettings();
    syncControls();
    if (state.shown && packKey(nestSettings()) !== packKey(state.shown.settings)) settingsChanged();
    else updateRepack();
  },
  useWorkArea: () => {
    state.settings.cnc.sheet = 'table';
    syncControls();
    saveSettings();
    if (state.parts.length) repack();
  },
  download: (name, text) => download(name, text, 'text/plain'),
});

// ---------------------------------------------------------------------------
// 3D
// ---------------------------------------------------------------------------

const view3d = new View3D($('view3d'));
view3d.onProgress = (t) => {
  $<HTMLInputElement>('scrub').value = String(Math.round(t * 1000));
  if (t >= 1) setPlayState($('play'), false);
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
    setTimeout(() => { view3d.play(); setPlayState($('play'), true); }, 600);
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

const baseName = () => state.fileName.replace(/\.(step|stp|dxf)$/i, '') || 'layout';
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

initTips();
bindControls();
syncControls();
render();
// Expose a loader for scripted testing (e.g. from the browser console).
(window as unknown as { plywooderOpen: typeof openFile }).plywooderOpen = openFile;
