import type { CamSettings, LibraryBit, Tool } from './cam';
import { icon } from './icons';

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const num = (v: number) => String(Math.round(v * 1000) / 1000);

export type BitLibraryHost = {
  settings: () => CamSettings;
  save: () => void;
  /** The job's own bit list changed: save, redraw the settings and re-plan. */
  jobChanged: () => void;
};

/** A folder filter: every bit, one named folder, or the unfiled bits (''). */
type Filter = { all: true } | { all: false; folder: string };

const NUM_FIELDS: { k: keyof Tool; label: string; min: number }[] = [
  { k: 'diameter', label: 'Diameter (mm)', min: 0.1 },
  { k: 'flutes', label: 'Flutes', min: 1 },
  { k: 'fluteLength', label: 'Flute length (mm)', min: 0.1 },
  { k: 'shank', label: 'Shank (mm)', min: 0.1 },
  { k: 'overall', label: 'Overall length (mm)', min: 0.1 },
  { k: 'tipAngle', label: 'V angle (°)', min: 1 },
  { k: 'rpm', label: 'Spindle (rpm)', min: 0 },
  { k: 'feed', label: 'Feed (mm/min)', min: 1 },
  { k: 'plungeFeed', label: 'Plunge (mm/min)', min: 1 },
  { k: 'depthPerPass', label: 'Per pass (mm)', min: 0.1 },
];

/**
 * The bit library, as a modal: bits filed in folders, with the details a Fusion tool library
 * keeps (maker, part number, geometry, spindle speed and feeds). The library lives in the settings,
 * so it persists; it can also be exported to a file and imported back.
 */
export class BitLibraryModal {
  private root: HTMLElement | null = null;
  private filter: Filter = { all: true };
  private selected = '';

  constructor(private host: BitLibraryHost) {}

  open() {
    if (this.root) return;
    const root = document.createElement('div');
    root.className = 'modal';
    root.innerHTML = `<div class="modalBox libBox" role="dialog" aria-modal="true" aria-label="Bit library"></div>
      <input type="file" id="libFile" accept=".json,application/json" hidden />`;
    document.body.appendChild(root);
    this.root = root;
    root.addEventListener('mousedown', (e) => { if (e.target === root) this.close(); });
    root.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('input', (e) => this.onInput(e));
    root.addEventListener('change', (e) => this.onChange(e));
    document.addEventListener('keydown', this.onKey);
    this.render();
    (root.querySelector('.libClose') as HTMLElement | null)?.focus();
  }

  close() {
    document.removeEventListener('keydown', this.onKey);
    this.root?.remove();
    this.root = null;
    this.host.jobChanged(); // preset bits in the job follow the library
  }

  private onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.close(); };

  private get lib() { return this.host.settings().library; }
  private inFilter(b: LibraryBit) { return this.filter.all || b.folder === this.filter.folder; }

  private render() {
    if (!this.root) return;
    const { lib } = this;
    const c = this.host.settings();
    const f = this.filter;
    const count = (folder: string) => lib.bits.filter((b) => b.folder === folder).length;
    const unfiled = count('');
    const folderBtn = (label: string, on: boolean, n: number, attr: string) =>
      `<button type="button" class="libFolder ${on ? 'on' : ''}" ${attr}>${esc(label)} <small>${n}</small></button>`;
    const shown = lib.bits.filter((b) => this.inFilter(b));
    const sel = lib.bits.find((b) => b.id === this.selected);
    const realFolder = !f.all && f.folder !== '';
    const title = f.all ? 'All bits' : f.folder || 'Unfiled';

    const row = (b: LibraryBit) => {
      const geo = [`Ø${num(b.diameter)} mm`, b.kind === 'vbit' && b.tipAngle ? `${num(b.tipAngle)}° V` : '',
        b.flutes ? `${b.flutes}T` : '', b.rpm ? `${b.rpm} rpm` : '', `${num(b.feed)} mm/min`].filter(Boolean).join(' · ');
      const maker = [b.manufacturer, b.partNo].filter(Boolean).join(' ');
      const inJob = c.tools.some((t) => t.id === b.id);
      return `<div class="libRow ${b.id === this.selected ? 'on' : ''}" data-select="${esc(b.id)}">
        <div class="libInfo"><b>${esc(b.name)}</b><small>${esc(geo)}${maker ? ` · ${esc(maker)}` : ''}${f.all && b.folder ? ` · ${esc(b.folder)}` : ''}</small></div>
        <button type="button" class="ghost" data-addjob="${esc(b.id)}" ${inJob ? 'disabled' : ''}>${inJob ? 'In job' : 'Add to job'}</button>
      </div>`;
    };

    const field = (label: string, key: string, value: string, extra = '') =>
      `<label><span>${label}</span><input data-f="${key}" value="${esc(value)}" ${extra}/></label>`;
    const editor = sel ? `<div class="libEdit">
      <h3>Edit bit</h3>
      <div class="libGrid">
        ${field('Name', 'name', sel.name)}
        ${field('Manufacturer', 'manufacturer', sel.manufacturer ?? '')}
        ${field('Part number', 'partNo', sel.partNo ?? '')}
        <label><span>Type</span><select data-f="kind"><option value="flat" ${sel.kind !== 'vbit' ? 'selected' : ''}>Flat end mill</option><option value="vbit" ${sel.kind === 'vbit' ? 'selected' : ''}>V bit</option></select></label>
        <label><span>Folder</span><select data-f="folder"><option value="">Unfiled</option>${lib.folders.map((n) => `<option value="${esc(n)}" ${n === sel.folder ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
        ${NUM_FIELDS.filter((n) => n.k !== 'tipAngle' || sel.kind === 'vbit').map((n) =>
          `<label><span>${n.label}</span><input type="number" data-f="${n.k}" value="${sel[n.k] ?? ''}" min="${n.min}" step="any"/></label>`).join('')}
      </div>
      <label><span>Notes</span><textarea data-f="notes" rows="2">${esc(sel.notes ?? '')}</textarea></label>
      <div class="pair"><button type="button" class="ghost" data-delbit>Delete from library</button></div>
    </div>` : '';

    this.root.querySelector('.libBox')!.innerHTML = `
      <header class="modalHead">
        <h2>Bit library</h2>
        <button type="button" class="ghost libClose" data-close aria-label="Close">${icon('close')}</button>
      </header>
      <div class="libBody">
        <nav class="libFolders" aria-label="Folders">
          ${folderBtn('All bits', f.all, lib.bits.length, 'data-folder-all')}
          ${lib.folders.map((n) => folderBtn(n, !f.all && f.folder === n, count(n), `data-folder="${esc(n)}"`)).join('')}
          ${unfiled ? folderBtn('Unfiled', !f.all && f.folder === '', unfiled, 'data-folder=""') : ''}
          <button type="button" class="ghost" data-newfolder>${icon('plus')} New folder</button>
        </nav>
        <div class="libMain">
          <div class="libHead">
            <h3>${esc(title)}</h3>
            <span>
              ${realFolder ? '<button type="button" class="ghost" data-renamefolder>Rename</button><button type="button" class="ghost" data-delfolder>Delete folder</button>' : ''}
              <button type="button" class="ghost" data-newbit>${icon('plus')} New bit</button>
            </span>
          </div>
          <div class="libList">${shown.map(row).join('') || '<p class="hint">No bits here yet.</p>'}</div>
          ${editor}
        </div>
      </div>
      <footer class="modalFoot">
        <button type="button" class="ghost" data-savejob data-tip="Add the bits in this job to the library, or update them if they're already there">Save job's bits to library</button>
        <span>
          <button type="button" class="ghost" data-import>Import…</button>
          <button type="button" class="ghost" data-export>Export…</button>
        </span>
      </footer>`;
  }

  private onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const btn = t.closest('button') as HTMLElement | null;
    const { lib } = this;
    const c = this.host.settings();
    if (btn) {
      const d = btn.dataset;
      if (d.close !== undefined) return this.close();
      if (d.folderAll !== undefined) { this.filter = { all: true }; return this.render(); }
      if (d.folder !== undefined) { this.filter = { all: false, folder: d.folder }; return this.render(); }
      if (d.newfolder !== undefined) {
        const name = prompt('Folder name')?.trim();
        if (!name) return;
        if (!lib.folders.includes(name)) lib.folders.push(name);
        this.filter = { all: false, folder: name };
        this.host.save();
        return this.render();
      }
      if (d.renamefolder !== undefined && !this.filter.all) {
        const old = this.filter.folder;
        const name = prompt('Folder name', old)?.trim();
        if (!name || name === old) return;
        if (lib.folders.includes(name)) { alert('There is already a folder with that name.'); return; }
        lib.folders[lib.folders.indexOf(old)] = name;
        for (const b of lib.bits) if (b.folder === old) b.folder = name;
        this.filter = { all: false, folder: name };
        this.host.save();
        return this.render();
      }
      if (d.delfolder !== undefined && !this.filter.all) {
        const old = this.filter.folder;
        const n = lib.bits.filter((b) => b.folder === old).length;
        if (!confirm(n ? `Delete "${old}"? Its ${n} ${n === 1 ? 'bit moves' : 'bits move'} to Unfiled.` : `Delete "${old}"?`)) return;
        lib.folders = lib.folders.filter((x) => x !== old);
        for (const b of lib.bits) if (b.folder === old) b.folder = '';
        this.filter = { all: true };
        this.host.save();
        return this.render();
      }
      if (d.newbit !== undefined) {
        const folder = this.filter.all ? '' : this.filter.folder;
        const bit: LibraryBit = {
          id: `lib-${Date.now().toString(36)}`, name: 'New bit', kind: 'flat', diameter: 6, feed: 1000, plungeFeed: 300,
          depthPerPass: 3, rpm: 12000, folder,
        };
        lib.bits.push(bit);
        this.selected = bit.id;
        this.host.save();
        return this.render();
      }
      if (d.addjob !== undefined) {
        const b = lib.bits.find((x) => x.id === d.addjob);
        if (b && !c.tools.some((x) => x.id === b.id)) {
          const { folder: _folder, ...tool } = b;
          c.tools.push({ ...tool, preset: true });
          this.host.jobChanged();
          this.render();
        }
        return;
      }
      if (d.delbit !== undefined) {
        const b = lib.bits.find((x) => x.id === this.selected);
        if (!b || !confirm(`Delete "${b.name}" from the library? The job keeps its own copy.`)) return;
        lib.bits = lib.bits.filter((x) => x !== b);
        this.selected = '';
        this.host.save();
        return this.render();
      }
      if (d.savejob !== undefined) {
        const folder = this.filter.all ? '' : this.filter.folder;
        for (const { preset: _p, ...t } of c.tools) {
          const at = lib.bits.findIndex((x) => x.id === t.id);
          if (at >= 0) lib.bits[at] = { ...t, folder: lib.bits[at].folder };
          else lib.bits.push({ ...t, folder });
        }
        this.host.save();
        return this.render();
      }
      if (d.export !== undefined) return this.exportFile();
      if (d.import !== undefined) return (this.root!.querySelector('#libFile') as HTMLInputElement).click();
      return;
    }
    const row = t.closest('[data-select]') as HTMLElement | null;
    if (row) { this.selected = row.dataset.select!; this.render(); }
  }

  /** Typing updates the bit in place; the list redraws when the field is left. */
  private onInput(e: Event) {
    const el = e.target as HTMLInputElement;
    const b = this.lib.bits.find((x) => x.id === this.selected);
    if (!b || !el.dataset.f || el.tagName === 'SELECT') return;
    this.setField(b, el.dataset.f, el.value);
  }

  private onChange(e: Event) {
    const el = e.target as HTMLInputElement;
    if (el.id === 'libFile') {
      const file = el.files?.[0];
      if (file) void this.importFile(file);
      el.value = '';
      return;
    }
    const b = this.lib.bits.find((x) => x.id === this.selected);
    if (!b || !el.dataset.f) return;
    if (el.tagName === 'SELECT') this.setField(b, el.dataset.f, el.value);
    this.render();
  }

  private setField(b: LibraryBit, k: string, raw: string) {
    const rec = b as unknown as Record<string, unknown>;
    if (NUM_FIELDS.some((n) => n.k === k)) {
      const v = parseFloat(raw);
      if (raw === '') {
        if (k === 'diameter' || k === 'feed' || k === 'plungeFeed' || k === 'depthPerPass') return; // required
        delete rec[k];
      } else if (Number.isFinite(v) && v >= 0) rec[k] = v;
      else return;
    } else if (k === 'name') {
      rec[k] = raw;
    } else if (k === 'folder') {
      rec[k] = raw;
    } else if (raw === '') {
      delete rec[k];
    } else {
      rec[k] = raw;
    }
    this.host.save();
  }

  private exportFile() {
    const data = { plywooderBitLibrary: 1, folders: this.lib.folders, bits: this.lib.bits };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'plywooder-bit-library.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Merge an exported library into this one: bits with the same id are replaced, folders are added. */
  private async importFile(file: File) {
    try {
      const data = JSON.parse(await file.text());
      if (data?.plywooderBitLibrary !== 1 || !Array.isArray(data.bits)) throw new Error('not a library');
      const { lib } = this;
      let n = 0;
      for (const raw of data.bits) {
        if (typeof raw?.id !== 'string' || typeof raw.name !== 'string' || !(raw.diameter > 0) || !(raw.feed > 0)
          || !(raw.plungeFeed > 0) || !(raw.depthPerPass > 0)) continue;
        const bit: LibraryBit = { ...raw, folder: typeof raw.folder === 'string' ? raw.folder : '' };
        if (bit.folder && !lib.folders.includes(bit.folder)) lib.folders.push(bit.folder);
        const at = lib.bits.findIndex((x) => x.id === bit.id);
        if (at >= 0) lib.bits[at] = bit; else lib.bits.push(bit);
        n++;
      }
      for (const f of data.folders ?? []) if (typeof f === 'string' && f && !lib.folders.includes(f)) lib.folders.push(f);
      this.host.save();
      this.render();
      if (!n) alert('That file had no usable bits.');
    } catch {
      alert("This isn't a PlyWooder bit library file.");
    }
  }
}
