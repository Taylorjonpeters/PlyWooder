import {
  planSheet, gordixFit, currentTable, parseTableCfg, stockKey, DEFAULT_TOOLS, STUDIO_TABLES, MACHINE_LABELS,
  type CamJob, type CamSettings, type CamSheet, type Move, type OpKind, type Tool,
} from './cam';
import { writeGcode, estimateSeconds, cutLength, MACHINES } from './gcode';
import { tip } from './tip';
import { icon, setPlayState } from './icons';

/** One sheet of the current layout, as the workspace sees it. */
export type CamSheetRef = { label: string; sheet: CamSheet; fileBase: string };

export type CamHost = {
  sheets: () => CamSheetRef[];
  /** The layout on screen is out of date, so nothing should be downloaded from it. */
  stale: () => boolean;
  settings: () => CamSettings;
  save: () => void;
  /** The layout's sheet already is the selected table's work area. */
  usingWorkArea: () => boolean;
  /** Lay the sheets out on the selected table's work area, and re-pack. */
  useWorkArea: () => void;
  download: (name: string, text: string) => void;
};

const OP_NAME: Record<OpKind, string> = { label: 'Labels', pocket: 'Pockets', hole: 'Holes', outline: 'Outlines' };
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmtTime = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
const num = (v: number) => String(Math.round(v * 1000) / 1000);

/**
 * The G-code tab: settings, the planned files for one sheet, and a preview that plays the job
 * back move by move.
 */
export class CamWorkspace {
  private index = 0;
  private job: CamJob | null = null;
  /** Every move of every file in run order, with the file it belongs to and the time it ends. */
  private timeline: { m: Move; file: number; t: number }[] = [];
  private step = 0;
  /** Whole-job run time, seconds. */
  private total = 0;
  private playing = false;
  private planTimer = 0;
  private $ = (id: string) => document.getElementById(id)!;

  constructor(private host: CamHost) {
    this.$('camSheet').addEventListener('change', (e) => { this.index = Number((e.target as HTMLSelectElement).value); this.plan(); });
    this.$('camDownloadAll').addEventListener('click', () => this.downloadAll());
    this.$('camPlay').addEventListener('click', () => this.togglePlay());
    this.$('camScrub').addEventListener('input', (e) => { this.pause(); this.setStep(Number((e.target as HTMLInputElement).value)); });
    this.bindSettings();
  }

  /** Show sheet `i` of the current layout (or the first). */
  select(i = this.index) {
    this.index = i;
    this.render();
  }

  /** Re-read the layout and settings and redraw everything. */
  render() {
    const sheets = this.host.sheets();
    this.$('camEmpty').hidden = !!sheets.length;
    this.$('camBody').hidden = !sheets.length;
    this.renderSettings();
    if (!sheets.length) { this.job = null; return; }
    if (this.index >= sheets.length) this.index = 0;
    const sel = this.$('camSheet') as HTMLSelectElement;
    sel.innerHTML = sheets.map((s, i) => `<option value="${i}">${esc(s.label)}</option>`).join('');
    sel.value = String(this.index);
    this.plan();
  }

  // -------------------------------------------------------------------------
  // Planning and files
  // -------------------------------------------------------------------------

  private schedulePlan() {
    clearTimeout(this.planTimer);
    this.planTimer = window.setTimeout(() => this.plan(), 150);
  }

  private plan() {
    const ref = this.host.sheets()[this.index];
    if (!ref) return;
    const cfg = this.host.settings();
    this.job = planSheet(ref.sheet, cfg);
    const centre = cfg.origin === 'center' ? { x: ref.sheet.w / 2, y: ref.sheet.h / 2 } : { x: 0, y: 0 };
    this.timeline = [];
    let t = 0;
    this.job.files.forEach((f, fi) => {
      let prev = centre, z = f.kind === 'router' ? cfg.safeZ : 0;
      for (const m of f.moves) {
        const d = Math.hypot(m.x - prev.x, m.y - prev.y, m.z - z);
        t += (d / (m.rapid ? MACHINES[cfg.machine].rapidSpeed : Math.max(1, m.f))) * 60;
        this.timeline.push({ m, file: fi, t });
        prev = m; z = m.z;
      }
      // Each file ends with a rapid back to X0 Y0, as estimateSeconds counts it.
      t += (Math.hypot(centre.x - prev.x, centre.y - prev.y) / MACHINES[cfg.machine].rapidSpeed) * 60;
    });
    this.total = t;
    this.renderFiles(ref, cfg);
    this.renderPreview(ref, cfg);
    const scrub = this.$('camScrub') as HTMLInputElement;
    scrub.max = String(this.timeline.length);
    this.setStep(this.timeline.length);
  }

  private fileName(ref: CamSheetRef, i: number) {
    const f = this.job!.files[i];
    const what = f.kind === 'laser' ? 'laser-labels' : `${num(f.tool!.diameter)}mm-bit`;
    const n = this.job!.files.length;
    return `${ref.fileBase}${n > 1 ? `_${i + 1}-of-${n}` : ''}_${what}.gcode`;
  }

  private text(ref: CamSheetRef, i: number) {
    const cfg = this.host.settings();
    return writeGcode(this.job!.files[i], {
      cfg, sheetW: ref.sheet.w, sheetH: ref.sheet.h, title: ref.label, index: i + 1, count: this.job!.files.length,
      stock: this.job!.stock, cutDepth: this.job!.cutDepth,
    });
  }

  private renderFiles(ref: CamSheetRef, cfg: CamSettings) {
    const job = this.job!;
    const centre = cfg.origin === 'center' ? { x: ref.sheet.w / 2, y: ref.sheet.h / 2 } : { x: 0, y: 0 };
    const times = job.files.map((f) => estimateSeconds(f.moves, cfg.machine, centre));
    const total = times.reduce((a, b) => a + b, 0);
    this.$('camSummary').innerHTML = job.files.length
      ? `<b>${job.files.length}</b> file${job.files.length > 1 ? 's' : ''} · about <b>${fmtTime(total)}</b> · stock ${num(job.stock)} mm, cut to Z−${num(job.cutDepth)}${cfg.airCut > 0 ? ' · <b class="air">air cut</b>' : ''}`
      : 'Nothing to cut on this sheet.';
    const warn = this.$('camWarn');
    warn.hidden = !job.warnings.length;
    warn.innerHTML = job.warnings.map(esc).join('<br>');
    const host = this.$('camFiles');
    host.innerHTML = job.files.map((f, i) => {
      const what = f.kind === 'laser' ? 'Laser module' : `${esc(f.tool!.name)} · ${num(f.tool!.diameter)} mm`;
      return `<div class="camFile">
        <span class="n">${i + 1}</span>
        <div><b>${what}</b><small>${f.ops.map((o) => `<i class="op ${o}"></i>${OP_NAME[o]}`).join(' ')} · ${fmtTime(times[i])} · ${(cutLength(f.moves) / 1000).toFixed(1)} m</small></div>
        <button class="ghost" data-dl="${i}">Download</button>
      </div>`;
    }).join('');
    const stale = this.host.stale();
    for (const b of host.querySelectorAll<HTMLButtonElement>('[data-dl]')) {
      b.disabled = stale;
      b.addEventListener('click', () => { const i = Number(b.dataset.dl); this.host.download(this.fileName(ref, i), this.text(ref, i)); });
    }
    (this.$('camDownloadAll') as HTMLButtonElement).disabled = !job.files.length || stale;
  }

  private downloadAll() {
    const ref = this.host.sheets()[this.index];
    if (!ref || !this.job) return;
    // Browsers drop rapid back-to-back downloads, so space them out.
    this.job.files.forEach((_, i) => setTimeout(() => this.host.download(this.fileName(ref, i), this.text(ref, i)), i * 400));
  }

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  private renderPreview(ref: CamSheetRef, cfg: CamSettings) {
    const { w, h } = ref.sheet;
    const y = (v: number) => (h - v).toFixed(2);
    const pad = Math.max(w, h) * 0.03;
    const parts: string[] = [];
    parts.push(`<rect class="sheetRect" x="0" y="0" width="${w}" height="${h}"/>`);
    if (cfg.machine === 'gordix' && cfg.origin === 'center') {
      const r = gordixFit(currentTable(cfg));
      parts.push(`<rect class="reach" x="${(w / 2 - r.x).toFixed(1)}" y="${(h / 2 - r.y).toFixed(1)}" width="${r.x * 2}" height="${r.y * 2}"><title>GORDIX work area</title></rect>`);
    }
    const ox = cfg.origin === 'center' ? w / 2 : 0, oy = cfg.origin === 'center' ? h / 2 : 0;
    parts.push(`<g class="origin"><line x1="${ox - pad}" y1="${y(oy)}" x2="${ox + pad}" y2="${y(oy)}"/><line x1="${ox}" y1="${y(oy - pad)}" x2="${ox}" y2="${y(oy + pad)}"/></g>`);
    const path = (p: { x: number; y: number }[]) => 'M' + p.map((q) => `${q.x.toFixed(1)},${y(q.y)}`).join('L') + 'Z';
    parts.push(`<path class="camPart" d="${this.job!.parts.flat().map((r) => [r.outer, ...r.holes].map(path).join('')).join('')}"/>`);
    // Every move, faint, as the plan; the played part is drawn over it.
    const { plan } = this.segments(this.timeline.length);
    parts.push(`<g class="plan">${plan}</g><g id="camDone"></g>`);
    parts.push(`<circle id="camTool" class="tool" r="3" cx="0" cy="0"/>`);
    const svg = this.$('camSvg');
    svg.setAttribute('viewBox', `${-pad} ${-pad} ${w + 2 * pad} ${h + 2 * pad}`);
    svg.innerHTML = parts.join('');
  }

  /** SVG paths for moves [0, n): cutting moves by operation, tabs, and rapids. */
  private segments(n: number) {
    const h = this.host.sheets()[this.index]?.sheet.h ?? 0;
    const buckets = new Map<string, string[]>();
    const add = (cls: string, s: string) => { let b = buckets.get(cls); if (!b) buckets.set(cls, (b = [])); b.push(s); };
    let prev: Move | null = null;
    for (let i = 0; i < n; i++) {
      const { m, file } = this.timeline[i];
      const p = prev && this.timeline[i - 1]?.file === file ? prev : null;
      if (p && (Math.abs(p.x - m.x) > 1e-3 || Math.abs(p.y - m.y) > 1e-3)) {
        const cls = m.rapid ? 'rapid' : m.tab ? 'tab' : m.op;
        add(cls, `M${p.x.toFixed(1)},${(h - p.y).toFixed(1)}L${m.x.toFixed(1)},${(h - m.y).toFixed(1)}`);
      }
      prev = m;
    }
    const plan = [...buckets].map(([cls, ds]) => `<path class="mv ${cls}" d="${ds.join('')}"/>`).join('');
    return { plan };
  }

  private setStep(n: number) {
    this.step = Math.max(0, Math.min(n, this.timeline.length));
    (this.$('camScrub') as HTMLInputElement).value = String(this.step);
    const done = document.getElementById('camDone');
    if (!done) return;
    const full = this.step >= this.timeline.length;
    this.$('camSvg').classList.toggle('playing', !full);
    done.innerHTML = full ? '' : this.segments(this.step).plan;
    const ref = this.host.sheets()[this.index];
    const tool = document.getElementById('camTool');
    const cur = this.timeline[Math.max(0, this.step - 1)];
    const total = this.total;
    if (!cur || !ref || !this.job) { this.$('camReadout').textContent = ''; return; }
    const f = this.job.files[cur.file];
    if (tool) {
      tool.setAttribute('cx', cur.m.x.toFixed(1));
      tool.setAttribute('cy', (ref.sheet.h - cur.m.y).toFixed(1));
      tool.setAttribute('r', String(f.tool ? f.tool.diameter / 2 : 1.5));
      tool.classList.toggle('below', cur.m.z < 0);
      (tool as unknown as SVGElement).style.display = full ? 'none' : '';
    }
    this.$('camReadout').textContent = full
      ? `${this.timeline.length} moves · ${fmtTime(total)}`
      : `File ${cur.file + 1} · ${OP_NAME[cur.m.op]} · Z ${num(cur.m.z)} · ${fmtTime(cur.t)} / ${fmtTime(total)}`;
  }

  private togglePlay() {
    if (this.playing) { this.pause(); return; }
    if (this.step >= this.timeline.length) this.setStep(0);
    this.playing = true;
    setPlayState(this.$('camPlay'), true);
    // Play the whole job in about 20 seconds, whatever its length.
    const perFrame = Math.max(1, Math.ceil(this.timeline.length / (20 * 60)));
    const tick = () => {
      if (!this.playing) return;
      this.setStep(this.step + perFrame);
      if (this.step >= this.timeline.length) { this.pause(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private pause() {
    this.playing = false;
    setPlayState(this.$('camPlay'), false);
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  private renderSettings() {
    const c = this.host.settings();
    const sheets = this.host.sheets();
    const kerfs = [...new Set(sheets.map((s) => s.sheet.kerf))];
    const stocks = [...new Set(sheets.map((s) => s.sheet.thickness))].sort((a, b) => b - a);
    const gordix = c.machine === 'gordix';
    const tables = c.tables.length ? c.tables : STUDIO_TABLES;
    const table = currentTable(c);
    const fit = gordixFit(table);
    /** Label text with an optional ⓘ, kept in one span so the label's grid gives them one row. */
    const lt = (label: string, help?: string) => `<span>${label}${help ? ` ${tip(help)}` : ''}</span>`;
    const numIn = (k: keyof CamSettings, label: string, min = 0, step = 'any', help?: string) =>
      `<label>${lt(label, help)}<input type="number" data-k="${k}" value="${c[k] as number}" min="${min}" step="${step}"/></label>`;
    const check = (k: keyof CamSettings, label: string, help?: string) =>
      `<label class="check"><input type="checkbox" data-k="${k}" ${c[k] ? 'checked' : ''}/> ${label}${help ? ` ${tip(help)}` : ''}</label>`;
    const toolSel = (k: 'pocketTool' | 'holeTool' | 'outlineTool', label: string, help?: string) =>
      `<label>${lt(label, help)}<select data-k="${k}">${c.tools.map((t) => `<option value="${esc(t.id)}" ${t.id === c[k] ? 'selected' : ''}>${esc(t.name)} (${num(t.diameter)} mm)</option>`).join('')}</select></label>`;

    this.$('camSettings').innerHTML = `
      <section>
        <h2>Machine</h2>
        <label>${lt('Machine', gordix ? 'Writes G-code in the dialect GORDIX Studio writes.' : 'Writes standard GRBL G-code.')}<select data-k="machine">
          <option value="gordix" ${gordix ? 'selected' : ''}>${MACHINE_LABELS.gordix}</option>
          <option value="grbl" ${!gordix ? 'selected' : ''}>${MACHINE_LABELS.grbl}</option>
        </select></label>
        <label>Origin (X0 Y0)<select data-k="origin">
          <option value="center" ${c.origin === 'center' ? 'selected' : ''}>Centre of the sheet</option>
          <option value="corner" ${c.origin === 'corner' ? 'selected' : ''}>Lower-left corner</option>
        </select></label>
        ${gordix ? `<label>${lt('GORDIX table', `${c.tablesFile ? `From ${c.tablesFile}` : "GORDIX Studio's default tables"}. Table ${table.id}: S ${num(table.S)}, W ${num(table.W)}, E ${num(table.E)}, N ${num(table.N)}, diagonal ${num(table.D)} mm. Also sets the layout's sheet.`)}<select data-k="tableId" data-num="1">${tables.map((t) => {
            const f = gordixFit(t);
            return `<option value="${t.id}" ${t.id === table.id ? 'selected' : ''}>${t.id}: ${num(t.S)} × ${num(t.W)} → cuts ${f.x * 2} × ${f.y * 2}</option>`;
          }).join('')}</select></label>
          ${fit.rotate ? `<p class="hint">Sheet turned 90° ${tip("This table's X side (S) is its short one, so the G-code runs the sheet's long side along side W.")}</p>` : ''}
          <div class="pair">
            <button class="ghost" id="camLoadTables" type="button" data-tip="Exported from GORDIX Studio's table setup page">Load table.cfg…</button>
            <button class="ghost" id="camResetTables" type="button" ${c.tablesFile ? '' : 'disabled'}>Studio defaults</button>
          </div>
          <input type="file" id="camTableFile" accept=".cfg,.txt,text/plain" hidden />
          ${this.host.usingWorkArea()
            ? `<p class="hint">The sheet is this table's work area (${fit.x * 2} × ${fit.y * 2} mm).</p>`
            : `<button class="ghost wide" id="camWorkArea" type="button" data-tip="The GORDIX reaches less than its table">Use work area as sheet (${fit.x * 2} × ${fit.y * 2} mm)</button>`}`
        : numIn('rpm', 'Spindle RPM', 0, '100', '0 leaves the spindle command out.')}
      </section>

      <section>
        <h2>Bits ${tip('Feeds in mm/min. GORDIX suggests 3–5 mm per pass in wood.')}</h2>
        <div class="tools">
          ${c.tools.map((t, i) => `<div class="toolRow">
            <div class="toolName">
              <input data-tool="${i}" data-f="name" value="${esc(t.name)}" aria-label="Bit name"/>
              <button class="ghost x" data-del="${i}" data-tip="Remove this bit" aria-label="Remove ${esc(t.name)}" ${c.tools.length < 2 ? 'disabled' : ''}>${icon('close')}</button>
            </div>
            <label><span>Ø mm</span><input type="number" data-tool="${i}" data-f="diameter" value="${t.diameter}" min="0.1" step="any"/></label>
            <label><span>Feed</span><input type="number" data-tool="${i}" data-f="feed" value="${t.feed}" min="1" step="any"/></label>
            <label><span>Plunge</span><input type="number" data-tool="${i}" data-f="plungeFeed" value="${t.plungeFeed}" min="1" step="any"/></label>
            <label><span>Per pass</span><input type="number" data-tool="${i}" data-f="depthPerPass" value="${t.depthPerPass}" min="0.1" step="any"/></label>
          </div>`).join('')}
        </div>
        <button class="ghost" id="camAddTool" type="button">${icon('plus')} Add bit</button>
      </section>

      <section>
        <h2>Operations ${tip('Each bit change starts a new file. Re-zero Z after changing bits.')}</h2>
        ${toolSel('pocketTool', 'Pockets')}
        ${toolSel('holeTool', 'Holes and slots')}
        ${toolSel('outlineTool', 'Outlines', `Also sets the gap between parts in the layout (packed for ${kerfs.map(num).join(', ') || '—'} mm).`)}
        ${check('labels', 'Mark part names with the laser')}
        ${c.labels ? `<div class="pair">${numIn('labelHeight', 'Text height (mm)', 3)}${numIn('laserFeed', 'Laser feed (mm/min)', 1)}</div>${gordix ? '' : numIn('laserPower', 'Laser power (%)', 0, '1')}` : ''}
      </section>

      <section>
        <h2>Fit</h2>
        ${stocks.map((t) => `<label>Measured ${num(t)} mm stock<input type="number" data-stock="${stockKey(t)}" value="${c.stockActual[stockKey(t)] ?? ''}" placeholder="${num(t)}" min="0.5" step="any"/></label>`).join('')}
        ${numIn('fitAllowance', 'Fit allowance (mm)', -5, 'any', 'Slots, holes and pockets get this much wider; tabs and outlines this much narrower.')}
        ${check('dogbones', 'Dogbone corners', 'Notches inside corners so square tabs seat fully.')}
      </section>

      <section>
        <h2>Cutting</h2>
        <div class="pair">${numIn('throughExtra', 'Extra depth (mm)', 0, 'any', 'Through cuts go this far below the stock so parts come free.')}${numIn('safeZ', 'Safe height (mm)', 0.5)}</div>
        <label>Pocket stepover (% of bit)<input type="number" data-k="stepover" data-scale="100" value="${Math.round(c.stepover * 100)}" min="10" max="90" step="5"/></label>
        ${check('ramp', 'Ramp into each pass', "Eases the bit in along the path instead of plunging. GORDIX Studio's editor can't adjust the depth of ramped files.")}
        ${c.ramp ? numIn('rampAngle', 'Ramp angle (°)', 1) : ''}
      </section>

      <section>
        <h2>Tabs</h2>
        ${check('tabs', 'Holding tabs')}
        ${c.tabs ? `${check('tabsOnHoles', 'Tabs on holes too')}
          <div class="pair">${numIn('tabHeight', 'Height (mm)')}${numIn('tabWidth', 'Width (mm)')}</div>
          ${numIn('tabSpacing', 'Spacing (mm)', 1)}` : ''}
      </section>

      <section>
        <h2>Dry run</h2>
        <label class="check"><input type="checkbox" id="camAir" ${c.airCut > 0 ? 'checked' : ''}/> Air cut</label>
        ${c.airCut > 0 ? numIn('airCut', 'Raise by (mm)', 1) : ''}
      </section>`;
    this.$('camWorkArea')?.addEventListener('click', () => {
      const cfg = this.host.settings();
      cfg.origin = 'center';
      this.host.useWorkArea();
    });
  }

  /** Read a GORDIX table.cfg and keep its tables in the settings. */
  private async loadTables(file: File) {
    const cfg = this.host.settings();
    try {
      cfg.tables = parseTableCfg(await file.text());
      cfg.tablesFile = file.name;
      if (!cfg.tables.some((t) => t.id === cfg.tableId)) cfg.tableId = cfg.tables[0].id;
      this.host.save();
      this.renderSettings();
      this.schedulePlan();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  /** One delegated listener set for the settings panel, which is re-rendered often. */
  private bindSettings() {
    const panel = this.$('camSettings');
    const changed = (rerender: boolean) => {
      this.host.save();
      if (rerender) this.renderSettings();
      this.schedulePlan();
    };
    panel.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement;
      const c = this.host.settings();
      if (el.dataset.tool !== undefined) {
        const t = c.tools[Number(el.dataset.tool)];
        const f = el.dataset.f as keyof Tool;
        if (f === 'name') { t.name = el.value; this.host.save(); return; }
        const v = parseFloat(el.value);
        if (!Number.isFinite(v) || v <= 0) return;
        (t as Record<string, unknown>)[f] = v;
        changed(false);
      } else if (el.dataset.stock !== undefined) {
        const v = parseFloat(el.value);
        if (el.value === '' || !Number.isFinite(v)) delete c.stockActual[el.dataset.stock];
        else if (v > 0) c.stockActual[el.dataset.stock] = v;
        changed(false);
      } else if (el.dataset.k && el.type === 'number') {
        const v = parseFloat(el.value);
        if (!Number.isFinite(v)) return;
        (c as Record<string, unknown>)[el.dataset.k] = el.dataset.scale ? v / Number(el.dataset.scale) : v;
        changed(false);
      }
    });
    panel.addEventListener('change', (e) => {
      const el = e.target as HTMLInputElement | HTMLSelectElement;
      const c = this.host.settings() as Record<string, unknown>;
      if (el.id === 'camTableFile') {
        const f = (el as HTMLInputElement).files?.[0];
        if (f) void this.loadTables(f);
        (el as HTMLInputElement).value = '';
        return;
      }
      if (el.id === 'camAir') {
        c.airCut = (el as HTMLInputElement).checked ? 25 : 0;
        changed(true);
      } else if (el.dataset.f === 'name' || el.dataset.f === 'diameter' || el.dataset.tool !== undefined) {
        changed(true); // bit names and sizes appear in the operation pickers
      } else if (el.dataset.k && (el instanceof HTMLSelectElement || el.type === 'checkbox')) {
        c[el.dataset.k] = el instanceof HTMLSelectElement ? (el.dataset.num ? Number(el.value) : el.value) : el.checked;
        if (el.dataset.k === 'machine') c.origin = el.value === 'gordix' ? 'center' : 'corner';
        changed(true);
      }
    });
    panel.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest('button');
      if (!el) return;
      const c = this.host.settings();
      if (el.id === 'camLoadTables') {
        (this.$('camTableFile') as HTMLInputElement).click();
      } else if (el.id === 'camResetTables') {
        c.tables = [];
        c.tablesFile = '';
        if (!STUDIO_TABLES.some((t) => t.id === c.tableId)) c.tableId = 1;
        changed(true);
      } else if (el.id === 'camAddTool') {
        const base = c.tools.at(-1) ?? DEFAULT_TOOLS[0];
        c.tools.push({ ...base, id: `bit-${Date.now().toString(36)}`, name: 'New bit' });
        changed(true);
      } else if (el.dataset.del !== undefined && c.tools.length > 1) {
        const [gone] = c.tools.splice(Number(el.dataset.del), 1);
        for (const k of ['pocketTool', 'holeTool', 'outlineTool'] as const) if (c[k] === gone.id) c[k] = c.tools[0].id;
        changed(true);
      }
    });
  }
}
