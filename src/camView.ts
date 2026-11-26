import {
  planSheet, gordixFit, currentTable, stockKey, FIRMWARE_Z_MAX, stockSupport, leavesSupport, DEFAULT_TOOLS, MACHINE_LABELS,
  type CamJob, type CamSettings, type CamSheet, type Move, type OpKind, type Tool,
} from './cam';
import { writeGcode, writeBoundsGcode, writePenBoundsGcode, stockEdgeReach, estimateSeconds, cutLength, MACHINES } from './gcode';
import { tip } from './tip';
import { BitLibraryModal } from './bitLibraryView';
import { icon, setPlayState } from './icons';
import { fmtLen, type Units } from './units';
import { axesSvg } from './axesSvg';
import { gordixBadge } from './gordixBadge';

/** One sheet of the current layout, as the workspace sees it. */
/**
 * `label` is the full name (used in file headers); `name` and `group` are what the picker shows:
 * "Sheet 2" under the heading "18 mm stock".
 */
export type CamSheetRef = { label: string; name: string; group: string; sheet: CamSheet; fileBase: string };

export type CamHost = {
  sheets: () => CamSheetRef[];
  /** The layout on screen is out of date, so nothing should be downloaded from it. */
  stale: () => boolean;
  settings: () => CamSettings;
  /** Display units for lengths shown on this tab. The G-code itself is always in mm. */
  units: () => Units;
  save: () => void;
  /** The layout's sheet already is the selected table's work area. */
  /** Go back to step 2, where the machine, table and sheet are set. */
  showLayout: () => void;
  download: (name: string, text: string) => void;
};

const OP_NAME: Record<OpKind, string> = { label: 'Labels', pocket: 'Pockets', hole: 'Holes', outline: 'Outlines' };
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmtTime = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
/** Plain-words duration for the summary and file cards: "1 h 42 min", "6 min", "40 s". */
const fmtRun = (s: number) => {
  const mins = Math.round(s / 60);
  if (mins < 1) return `${Math.max(1, Math.round(s))} s`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
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
  /** A length for display: whole fractions of an inch, or mm. */
  private len = (mm: number, unit = true) => fmtLen(mm, this.host.units(), unit);
  /** A depth for display, to the thousandth in inches, since Z needs more than 1/16". */
  private depth = (mm: number) => {
    const u = this.host.units();
    return u === 'in' ? `${(mm / 25.4).toFixed(3)}"` : u === 'cm' ? `${num(mm / 10)} cm` : `${num(mm)} mm`;
  };
  private library = new BitLibraryModal({
    settings: () => this.host.settings(),
    save: () => this.host.save(),
    jobChanged: () => { this.host.save(); this.renderSettings(); this.schedulePlan(); },
  });

  constructor(private host: CamHost) {
    const strip = this.$('camSheet');
    strip.addEventListener('click', (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-sheet]');
      if (chip) this.pick(Number(chip.dataset.sheet));
    });
    // Arrow keys move between sheets, as in any tab list.
    strip.addEventListener('keydown', (e) => {
      const n = this.host.sheets().length;
      const to = { ArrowRight: this.index + 1, ArrowDown: this.index + 1, ArrowLeft: this.index - 1, ArrowUp: this.index - 1, Home: 0, End: n - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      this.pick(Math.max(0, Math.min(n - 1, to)), true);
    });
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
    this.renderSheetStrip(sheets);
    this.plan();
  }

  /** Show sheet `i` without redrawing the strip's thumbnails. */
  private pick(i: number, focus = false) {
    if (i === this.index) return;
    this.index = i;
    this.markSheet(focus);
    this.plan();
  }

  /** One chip per sheet: a thumbnail of what is on it, its name and part count, grouped by stock. */
  private renderSheetStrip(sheets: CamSheetRef[]) {
    const groups = new Set(sheets.map((s) => s.group));
    let html = '';
    sheets.forEach((ref, i) => {
      if (groups.size > 1 && ref.group !== sheets[i - 1]?.group) html += `<span class="stripGroup" role="presentation">${esc(ref.group)}</span>`;
      const { w, h, shapes } = ref.sheet;
      const d = (poly: { x: number; y: number }[]) => 'M' + poly.map((q) => `${q.x.toFixed(0)},${(h - q.y).toFixed(0)}`).join('L') + 'Z';
      const path = shapes.map((sh) => sh.regions.map((r) => [r.outer, ...r.holes].map(d).join('')).join('')).join('');
      const n = shapes.length;
      html += `<button class="sheetChip" role="tab" type="button" data-sheet="${i}">
        <svg viewBox="0 0 ${w} ${h}" aria-hidden="true"><rect class="sheetRect" width="${w}" height="${h}"/><path class="mini" d="${path}"/></svg>
        <b>${esc(ref.name)}</b><small>${n} ${n === 1 ? 'part' : 'parts'}${groups.size > 1 ? '' : ` · ${this.len(ref.sheet.thickness)}`}</small>
      </button>`;
    });
    this.$('camSheet').innerHTML = html;
    this.markSheet(false);
  }

  /** Mark the current sheet's chip (and make it the one that takes the Tab key). */
  private markSheet(focus: boolean) {
    for (const chip of this.$('camSheet').querySelectorAll<HTMLElement>('[data-sheet]')) {
      const on = Number(chip.dataset.sheet) === this.index;
      chip.classList.toggle('on', on);
      chip.setAttribute('aria-selected', String(on));
      chip.tabIndex = on ? 0 : -1;
      if (on) {
        chip.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        if (focus) chip.focus();
      }
    }
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

  private fileName(ref: CamSheetRef, i: number, air = false) {
    const f = this.job!.files[i];
    const what = f.kind === 'laser' ? 'laser-labels' : `${num(f.tool!.diameter)}mm-bit`;
    const n = this.job!.files.length;
    return `${ref.fileBase}${n > 1 ? `_${i + 1}-of-${n}` : ''}_${what}${air ? '_aircut' : ''}.gcode`;
  }

  /** One file's G-code; `air` raises it by the air cut height for a dry run. */
  private text(ref: CamSheetRef, i: number, air = false) {
    const saved = this.host.settings();
    const cfg = { ...saved, airCut: air ? Math.max(1, saved.airLift) : 0 };
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
      ? `<b>${job.files.length}</b> file${job.files.length > 1 ? 's' : ''} · est. run time <b>${fmtRun(total)}</b> · cut to Z−${this.depth(job.cutDepth)}`
      : 'Nothing to cut on this sheet.';
    // The piece to put on the machine: the sheet size and the thickness the depths use.
    const stock = this.$('camStock');
    stock.hidden = false;
    stock.innerHTML = `Stock <b>${this.len(ref.sheet.w, false)} × ${this.len(ref.sheet.h, false)} × ${this.len(job.stock)}</b>`;
    stock.dataset.tip = `The piece to put on the machine for this sheet: X length × Y width × thickness. The thickness is your measured one if you set it under Fit.`;
    const warn = this.$('camWarn');
    warn.hidden = !job.warnings.length;
    warn.innerHTML = job.warnings.map(esc).join('<br>');
    const host = this.$('camFiles');
    host.innerHTML = job.files.map((f, i) => {
      const what = f.kind === 'laser' ? 'Laser module' : `${esc(f.tool!.name)} · ${num(f.tool!.diameter)} mm`;
      return `<div class="camFile">
        <span class="n">${i + 1}</span>
        <div><b>${what}</b><small class="ops">${f.ops.map((o) => `<span><i class="op ${o}"></i>${OP_NAME[o]}</span>`).join('')}</small><small>${fmtRun(times[i])} · ${this.host.units() === 'in' ? `${(cutLength(f.moves) / 304.8).toFixed(0)} ft` : `${(cutLength(f.moves) / 1000).toFixed(1)} m`} of cutting</small></div>
        <button class="ghost" data-dl="${i}">Download</button>
      </div>`;
    }).join('');
    const stale = this.host.stale();
    for (const b of host.querySelectorAll<HTMLButtonElement>('[data-dl]')) {
      b.disabled = stale;
      b.addEventListener('click', () => {
        const i = Number(b.dataset.dl);
        this.checkSupport(ref, [i], () => this.host.download(this.fileName(ref, i), this.text(ref, i)));
      });
    }
    (this.$('camDownloadAll') as HTMLButtonElement).disabled = !job.files.length || stale;
    const bounds = document.getElementById('camBounds') as HTMLButtonElement | null;
    if (bounds) bounds.disabled = this.boundsBlocked();
    const air = document.getElementById('camAirDl') as HTMLButtonElement | null;
    if (air) air.disabled = this.boundsBlocked();
    const pen = document.getElementById('camPenBounds') as HTMLButtonElement | null;
    if (pen) pen.disabled = this.boundsBlocked();
  }

  /**
   * A warning over the dry run buttons when the stock's edge is at or past what the GORDIX reaches,
   * so the bounds and pen files can't drive to it. Empty when they can, or when it can't be told.
   */
  private edgeReachWarning(c: CamSettings) {
    const sheets = this.host.sheets();
    const sheet = (sheets[this.index] ?? sheets[0])?.sheet;
    const r = sheet && stockEdgeReach(c, sheet.w, sheet.h);
    if (!r) return '';
    return `<div class="warn edgeReach" role="alert">Stock edge is outside the ${this.len(r.area.w, false)} × ${this.len(r.area.h)} `
      + `the GORDIX reaches on table ${r.table.id}, so Bounds G-code can't get there. `
      + (r.edges.length ? 'The pen draws only the edges in reach.' : "The pen can't reach any edge.") + '</div>';
  }

  /** The bounds file needs a planned, up-to-date job with something to cut. */
  private boundsBlocked() {
    return !this.job?.files.length || this.host.stale();
  }

  private downloadBounds() {
    const ref = this.host.sheets()[this.index];
    if (!ref || !this.job || this.boundsBlocked()) return;
    const text = writeBoundsGcode(this.job.files, {
      cfg: { ...this.host.settings(), airCut: 0 }, sheetW: ref.sheet.w, sheetH: ref.sheet.h, title: ref.label,
      stock: this.job.stock, cutDepth: this.job.cutDepth,
    });
    // It goes to the stock's corner, which is always past what the stock alone supports.
    if (text) this.checkSupport(ref, 'edge', () => this.host.download(`${ref.fileBase}_bounds.gcode`, text));
  }

  /** Pen plotter file that draws the rectangle the cuts reach on the material. */
  private downloadPenBounds() {
    const ref = this.host.sheets()[this.index];
    if (!ref || !this.job || this.boundsBlocked()) return;
    const text = writePenBoundsGcode(this.job.files, {
      cfg: { ...this.host.settings(), airCut: 0 }, sheetW: ref.sheet.w, sheetH: ref.sheet.h, title: ref.label,
      stock: this.job.stock, cutDepth: this.job.cutDepth,
    });
    // No stock-support check: the pen marks where the stock goes, so the machine stands on the table.
    if (text) this.host.download(`${ref.fileBase}_pen_bounds.gcode`, text);
  }

  /**
   * The router files raised by the air cut height, so the whole job runs in the air. Laser label
   * files are left out: the laser would still mark the material.
   */
  private downloadAir() {
    const ref = this.host.sheets()[this.index];
    if (!ref || !this.job || this.boundsBlocked()) return;
    const router = this.job.files.map((f, i) => (f.kind === 'router' ? i : -1)).filter((i) => i >= 0);
    this.checkSupport(ref, router, () =>
      router.forEach((i, k) => setTimeout(() => this.host.download(this.fileName(ref, i, true), this.text(ref, i, true)), k * 400)));
  }

  private downloadAll() {
    const ref = this.host.sheets()[this.index];
    if (!ref || !this.job) return;
    // Browsers drop rapid back-to-back downloads, so space them out.
    this.checkSupport(ref, this.job.files.map((_, i) => i), () =>
      this.job!.files.forEach((_, i) => setTimeout(() => this.host.download(this.fileName(ref, i), this.text(ref, i)), i * 400)));
  }

  /**
   * On the GORDIX, warn before a download whose moves (`files`, or `'edge'` for the dry run files
   * that go to the stock's edge) leave what the stock alone can carry the machine over. The user
   * can add scrap around the stock and download anyway, or go back to the Layout step's margins.
   */
  private checkSupport(ref: CamSheetRef, files: number[] | 'edge', go: () => void) {
    const s = stockSupport(ref.sheet, this.host.settings());
    const crosses = s && (files === 'edge' || files.some((i) => leavesSupport(this.job!.files[i].moves, ref.sheet, s)));
    if (!s || !crosses) { go(); return; }
    const root = document.createElement('div');
    root.className = 'modal';
    root.innerHTML = `<div class="modalBox supportBox" role="alertdialog" aria-modal="true" aria-labelledby="supportTitle" aria-describedby="supportText">
        <header class="modalHead"><h2 id="supportTitle">Tool path crosses bounds of stock</h2></header>
        <div class="supportBody" id="supportText">
          <p>Please add scrap for support, or keep parts ${this.len(s.edge)} from the stock's edges.</p>
        </div>
        <footer class="modalFoot">
          <button class="ghost" type="button" data-act="cancel">Cancel</button>
          <span>
            <button class="ghost" type="button" data-act="margin">Change safe area</button>
            <button class="primary" type="button" data-act="scrap" title="Downloads the file. Put scrap around the stock before running it.">Add scrap</button>
          </span>
        </footer>
      </div>`;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const close = () => { document.removeEventListener('keydown', onKey); root.remove(); };
    root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
    root.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (!act) return;
      close();
      if (act === 'scrap') go();
      else if (act === 'margin') {
        this.host.showLayout();
        const m = document.getElementById('edgeMargin') as HTMLInputElement | null;
        m?.scrollIntoView({ block: 'center' });
        m?.focus();
        m?.select();
      }
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(root);
    (root.querySelector('[data-act="scrap"]') as HTMLElement).focus();
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
    // Drawn as the sheet sits on the machine, so X always runs right and Y up. On a GORDIX table
    // whose X side is short the G-code turns the sheet 90°, and the preview turns with it.
    const turned = cfg.machine === 'gordix' && cfg.origin === 'center' && gordixFit(currentTable(cfg)).rotate;
    const vw = turned ? h : w, vh = turned ? w : h;
    const o = pad * 0.5;
    const svg = this.$('camSvg');
    svg.setAttribute('viewBox', `${-pad} ${-pad} ${vw + 2 * pad} ${vh + 2 * pad}`);
    svg.innerHTML = `<g${turned ? ` transform="matrix(0 -1 1 0 0 ${w})"` : ''}>${parts.join('')}</g>`
      + axesSvg({ x: -o, y: vh + o }, [1, 0], [0, -1], pad);
    // The preview is in machine coordinates, so the GORDIX always faces north (up) here.
    const badge = svg.parentElement!.querySelector('.gordixBadge');
    if (cfg.machine === 'gordix') {
      if (badge) badge.outerHTML = gordixBadge(0); else svg.insertAdjacentHTML('afterend', gordixBadge(0));
    } else badge?.remove();
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
      : `File ${cur.file + 1} · ${OP_NAME[cur.m.op]} · Z ${cur.m.z < 0 ? '−' : ''}${this.depth(Math.abs(cur.m.z))} · ${fmtTime(cur.t)} / ${fmtTime(total)}`;
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

  private bitSummary(t: Tool) {
    return [`Ø${num(t.diameter)} mm`, t.kind === 'vbit' && t.tipAngle ? `${num(t.tipAngle)}° V` : '', t.flutes ? `${t.flutes}T` : '',
      t.rpm ? `${t.rpm} rpm` : '', `${num(t.feed)} / ${num(t.plungeFeed)} mm/min`, `${num(t.depthPerPass)} mm per pass`].filter(Boolean).join(' · ');
  }

  /** Preset bits follow the library: refresh their copies, or turn them custom if the library dropped them. */
  private syncPresets() {
    const c = this.host.settings();
    c.tools = c.tools.map((t) => {
      if (!t.preset) return t;
      const b = c.library.bits.find((x) => x.id === t.id);
      if (!b) { const { preset: _p, ...rest } = t; return rest; }
      const { folder: _f, ...rest } = b;
      return { ...rest, preset: true };
    });
  }

  private renderSettings() {
    this.syncPresets();
    const c = this.host.settings();
    const sheets = this.host.sheets();
    const kerfs = [...new Set(sheets.map((s) => s.sheet.kerf))];
    const stocks = [...new Set(sheets.map((s) => s.sheet.thickness))].sort((a, b) => b - a);
    const gordix = c.machine === 'gordix';
    const sheet0 = sheets[0]?.sheet;
    const table = currentTable(c);
    const fit = gordixFit(table);
    /** Label text with an optional ⓘ, kept in one span so the label's grid gives them one row. */
    const lt = (label: string, help?: string, art?: string) => `<span>${label}${help ? ` ${tip(help, art)}` : ''}</span>`;
    const numIn = (k: keyof CamSettings, label: string, min = 0, step = 'any', help?: string, art?: string) =>
      `<label>${lt(label, help, art)}<input type="number" data-k="${k}" value="${c[k] as number}" min="${min}" step="${step}"/></label>`;
    const check = (k: keyof CamSettings, label: string, help?: string, art?: string) =>
      `<label class="check"><input type="checkbox" data-k="${k}" ${c[k] ? 'checked' : ''}/> ${label}${help ? ` ${tip(help, art)}` : ''}</label>`;
    const toolSel = (k: 'pocketTool' | 'holeTool' | 'outlineTool', label: string, help?: string) =>
      `<label>${lt(label, help)}<select data-k="${k}">${c.tools.map((t) => `<option value="${esc(t.id)}" ${t.id === c[k] ? 'selected' : ''}>${esc(t.name)} (${num(t.diameter)} mm)</option>`).join('')}</select></label>`;

    this.$('camSettings').innerHTML = `
      <section>
        <div class="sectionHead">
          <h2>Job</h2>
          <button class="ghost small" id="camToLayout" type="button">Change in Layout</button>
        </div>
        <p class="hint jobSummary"><b>${gordix ? `GORDIX · Table ${table.id}` : MACHINE_LABELS.grbl}</b>${sheet0 ? ` · ${this.len(sheet0.w, false)} × ${this.len(sheet0.h)} sheet` : ''}</p>
        ${gordix && fit.rotate ? `<p class="hint">Sheet turned 90° ${tip("The GORDIX reaches further along Y than X on this table, so the G-code runs the sheet's long side along Y (sides E and W).")}</p>` : ''}
        <label>Origin (X0 Y0)<select data-k="origin">
          <option value="center" ${c.origin === 'center' ? 'selected' : ''}>Centre of the sheet</option>
          <option value="corner" ${c.origin === 'corner' ? 'selected' : ''}>Lower-left corner</option>
        </select></label>
        ${gordix ? '' : numIn('rpm', 'Spindle RPM', 0, '100', '0 leaves the spindle command out.')}
      </section>

      <section>
        <h2>Bits ${tip('Feeds in mm/min. GORDIX suggests 3–5 mm per pass in wood.')}</h2>
        <div class="tools">
          ${c.tools.map((t, i) => t.preset ? `<div class="toolRow preset">
            <div class="toolName">
              <div class="presetInfo"><b>${esc(t.name)}</b><small>${esc(this.bitSummary(t))}</small></div>
              <button class="ghost" data-unlock="${i}" data-tip="Make an editable copy of this bit">Customize</button>
              <button class="ghost x" data-del="${i}" data-tip="Remove this bit" aria-label="Remove ${esc(t.name)}" ${c.tools.length < 2 ? 'disabled' : ''}>${icon('close')}</button>
            </div>
          </div>` : `<div class="toolRow">
            <div class="toolName">
              <input data-tool="${i}" data-f="name" value="${esc(t.name)}" aria-label="Bit name"/>
              <button class="ghost x" data-save="${i}" data-tip="${c.library.bits.some((b) => b.id === t.id) ? 'Update this bit in the library and lock it' : 'Save this bit to the library and lock it'}" aria-label="Save ${esc(t.name)} to the library">${icon('save')}</button>
              <button class="ghost x" data-del="${i}" data-tip="Remove this bit" aria-label="Remove ${esc(t.name)}" ${c.tools.length < 2 ? 'disabled' : ''}>${icon('close')}</button>
            </div>
            <label><span>Ø (mm)</span><input type="number" data-tool="${i}" data-f="diameter" value="${t.diameter}" min="0.1" step="any"/></label>
            <label><span>Feed (mm/min)</span><input type="number" data-tool="${i}" data-f="feed" value="${t.feed}" min="1" step="any"/></label>
            <label><span>Plunge (mm/min)</span><input type="number" data-tool="${i}" data-f="plungeFeed" value="${t.plungeFeed}" min="1" step="any"/></label>
            <label><span>Per pass (mm)</span><input type="number" data-tool="${i}" data-f="depthPerPass" value="${t.depthPerPass}" min="0.1" step="any"/></label>
          </div>`).join('')}
        </div>
        <div class="pair">
          <button class="ghost" id="camAddTool" type="button">${icon('plus')} Custom bit</button>
          <button class="ghost" id="camLibrary" type="button" data-tip="Pick a preset bit from the library, or manage the library">Bit library…</button>
        </div>
      </section>

      <section>
        <h2>Operations ${tip('Each bit change starts a new file. Re-zero Z after changing bits.')}</h2>
        ${toolSel('pocketTool', 'Pockets')}
        ${toolSel('holeTool', 'Holes and slots')}
        <label>${lt('Outlines', `Set in step 2, Layout, because it also sets the gap between parts (packed for ${kerfs.map(num).join(', ') || '—'} mm).`)}<input value="${esc(c.tools.find((t) => t.id === c.outlineTool)?.name ?? c.tools[0]?.name ?? '')} (${num((c.tools.find((t) => t.id === c.outlineTool) ?? c.tools[0]).diameter)} mm)" disabled/></label>
        ${check('labels', 'Mark part names with the laser')}
        ${c.labels ? `<div class="pair">${numIn('labelHeight', 'Text height (mm)', 3)}${numIn('laserFeed', 'Laser feed (mm/min)', 1)}</div>${gordix ? '' : numIn('laserPower', 'Laser power (%)', 0, '1')}` : ''}
      </section>

      <section>
        <h2>Fit</h2>
        ${stocks.map((t) => `<label>Measured ${num(t)} mm stock<input type="number" data-stock="${stockKey(t)}" value="${c.stockActual[stockKey(t)] ?? ''}" placeholder="${num(t)}" min="0.5" step="any"/></label>`).join('')}
        ${numIn('fitAllowance', 'Fit allowance (mm)', -5, 'any', 'Slots, holes and pockets get this much wider; tabs and outlines this much narrower.', 'fit')}
        ${check('dogbones', 'Dogbone corners', 'Notches inside corners so square tabs seat fully.', 'dogbone')}
      </section>

      <section>
        <h2>Cutting</h2>
        <div class="pair">${numIn('throughExtra', 'Extra depth (mm)', 0, 'any', 'Through cuts go this far below the stock so parts come free.', 'depth')}${numIn('safeZ', 'Safe height (mm)', 0.5)}</div>
        <label>Pocket stepover (% of bit)<input type="number" data-k="stepover" data-scale="100" value="${Math.round(c.stepover * 100)}" min="10" max="90" step="5"/></label>
        ${check('ramp', 'Ramp into each pass', "Eases the bit in along the path instead of plunging. GORDIX Studio's editor can't adjust the depth of ramped files.", 'ramp')}
        ${c.ramp ? numIn('rampAngle', 'Ramp angle (°)', 1) : ''}
      </section>

      <section>
        <h2>Tabs</h2>
        ${check('tabs', 'Holding tabs', "Short bridges of uncut wood hold each part in the sheet so it can't shift on the last pass. Snap or trim them after cutting.", 'tabs')}
        ${c.tabs ? `${check('tabsOnHoles', 'Tabs on holes too')}
          <div class="pair">${numIn('tabHeight', 'Height (mm)')}${numIn('tabWidth', 'Width (mm)')}</div>
          ${numIn('tabSpacing', 'Spacing (mm)', 1)}` : ''}
      </section>

      <section>
        <h2>Dry run</h2>
        ${this.edgeReachWarning(c)}
        <div class="${gordix ? '' : 'pair'}">
          ${gordix ? '' : `<button class="ghost" id="camAirDl" type="button" data-tip-art="air" data-tip="Downloads this sheet's cutting files raised ${num(Math.max(1, c.airLift))} mm, so the whole job runs in the air and nothing touches the material. Laser label files are left out." ${this.boundsBlocked() ? 'disabled' : ''}>Air cut G-code</button>`}
          <button class="ghost" id="camBounds" type="button" data-tip-art="bounds" data-tip="Downloads one file that moves the bit to the stock sheet's lower-left corner at safe height and stops there, with nothing switched on, so you can line the stock's corner up under it." ${this.boundsBlocked() ? 'disabled' : ''}>Bounds G-code</button>
        </div>
        <button class="ghost" id="camPenBounds" type="button" data-tip-art="penBounds" data-tip="Downloads a pen plotter file that draws the stock sheet's left edge, with 10 cm of its top and bottom edges, so you can place the stock against it. Edges past the GORDIX's reach are left out. Put a pen in the machine and zero Z with its tip touching the surface; it draws ${num(c.penDepth)} mm below that. Nothing is cut." ${this.boundsBlocked() ? 'disabled' : ''}>Draw stock edge with pen</button>
        ${gordix
          ? `<p class="hint">For an air cut, zero Z ${num(Math.max(1, c.airLift))} mm above the material and run the normal files: the GORDIX refuses files that go above Z+${FIRMWARE_Z_MAX}.</p>`
          : numIn('airLift', 'Air cut height (mm)', 1)}
        ${numIn('penDepth', 'Pen depth below Z0 (mm)', 0, 'any', 'How far the pen file pushes the pen below Z0 so it presses on the material. Raise it if the line is faint or missing; a spring-loaded pen holder takes up the extra.')}
      </section>`;
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
      if (el.dataset.f === 'name' || el.dataset.f === 'diameter' || el.dataset.tool !== undefined) {
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
      if (el.id === 'camToLayout') {
        this.host.showLayout();
      } else if (el.id === 'camBounds') {
        this.downloadBounds();
      } else if (el.id === 'camPenBounds') {
        this.downloadPenBounds();
      } else if (el.id === 'camAirDl') {
        this.downloadAir();
      } else if (el.id === 'camLibrary') {
        this.library.open();
      } else if (el.id === 'camAddTool') {
        const { preset: _p, ...base } = c.tools.at(-1) ?? DEFAULT_TOOLS[0];
        c.tools.push({ ...base, id: `bit-${Date.now().toString(36)}`, name: 'New bit' });
        changed(true);
      } else if (el.dataset.unlock !== undefined) {
        const t = c.tools[Number(el.dataset.unlock)];
        const { preset: _p, ...rest } = t;
        const id = `bit-${Date.now().toString(36)}`;
        c.tools[Number(el.dataset.unlock)] = { ...rest, id, name: `${t.name} (custom)` };
        for (const k of ['pocketTool', 'holeTool', 'outlineTool'] as const) if (c[k] === t.id) c[k] = id; // operations keep using it
        changed(true);
      } else if (el.dataset.save !== undefined) {
        const i = Number(el.dataset.save);
        const { preset: _p, ...t } = c.tools[i];
        const at = c.library.bits.findIndex((b) => b.id === t.id);
        if (at >= 0) c.library.bits[at] = { ...t, folder: c.library.bits[at].folder };
        else c.library.bits.push({ ...t, folder: '' });
        c.tools[i] = { ...t, preset: true }; // the job's bit becomes the saved one, locked
        changed(true);
      } else if (el.dataset.del !== undefined && c.tools.length > 1) {
        const [gone] = c.tools.splice(Number(el.dataset.del), 1);
        for (const k of ['pocketTool', 'holeTool', 'outlineTool'] as const) if (c[k] === gone.id) c[k] = c.tools[0].id;
        changed(true);
      }
    });
  }
}
