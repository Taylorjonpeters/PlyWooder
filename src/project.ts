import type { PartChoice } from './layout';

/** The opened STEP or DXF, kept so a project can be parsed again after a reload or from a file. */
export type ProjectSource = { name: string; kind: 'step' | 'dxf'; data: string | Uint8Array };

/** What the user did with the parts: which are included, how many, and how far they got. */
export type ProjectView = { choices: [number, PartChoice][]; packRequested: boolean; tab: string };

export type Project = ProjectView & { source: ProjectSource; settings?: unknown };

export const PROJECT_EXT = '.plywooder';
const FORMAT = 'plywooder-project';

// ---------------------------------------------------------------------------
// Autosave in IndexedDB. STEP files can be several MB, more than localStorage holds.
// The source is written only when a file opens; the view is written on every change.
// ---------------------------------------------------------------------------

const DB_NAME = 'plywooder';
const STORE = 'autosave';
let dbPromise: Promise<IDBDatabase> | null = null;

const openDb = () => (dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(STORE);
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
}));

const request = <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest) =>
  openDb().then((db) => new Promise<T>((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  }));

/** Storage can be unavailable (private windows, blocked site data); autosave then quietly does nothing. */
const quietly = <T>(p: Promise<T>) => p.catch((err) => { console.warn('Autosave unavailable', err); return undefined; });

export const autosaveSource = (src: ProjectSource) => quietly(request('readwrite', (s) => s.put(src, 'source')));
export const autosaveView = (view: ProjectView) => quietly(request('readwrite', (s) => s.put(view, 'view')));
export const clearAutosave = () => quietly(request('readwrite', (s) => s.clear()));

/** The last autosaved project, or null when nothing was open. Settings are kept separately. */
export async function readAutosave(): Promise<Project | null> {
  const [source, view] = await Promise.all([
    quietly(request<ProjectSource | undefined>('readonly', (s) => s.get('source'))),
    quietly(request<ProjectView | undefined>('readonly', (s) => s.get('view'))),
  ]);
  if (!source) return null;
  return { source, choices: view?.choices ?? [], packRequested: view?.packRequested ?? false, tab: view?.tab ?? '3d' };
}

// ---------------------------------------------------------------------------
// Project files: JSON, with a STEP file's bytes as base64.
// ---------------------------------------------------------------------------

export function encodeProject(p: Project): string {
  const { data } = p.source;
  const source = typeof data === 'string'
    ? { ...p.source, encoding: 'text' }
    : { ...p.source, data: toBase64(data), encoding: 'base64' };
  return JSON.stringify({ format: FORMAT, version: 1, ...p, source });
}

export function decodeProject(text: string): Project {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(text); } catch { throw new Error("This isn't a PlyWooder project file."); }
  if (raw?.format !== FORMAT) throw new Error("This isn't a PlyWooder project file.");
  if (typeof raw.version !== 'number' || raw.version > 1) throw new Error('This project was saved by a newer version of PlyWooder.');
  const src = raw.source as { name: string; kind: 'step' | 'dxf'; data: string; encoding: string };
  if (!src || typeof src.data !== 'string' || (src.kind !== 'step' && src.kind !== 'dxf')) throw new Error('The project file is missing its parts.');
  return {
    source: { name: String(src.name), kind: src.kind, data: src.encoding === 'base64' ? fromBase64(src.data) : src.data },
    choices: Array.isArray(raw.choices) ? (raw.choices as [number, PartChoice][]) : [],
    packRequested: !!raw.packRequested,
    tab: typeof raw.tab === 'string' ? raw.tab : '3d',
    settings: raw.settings,
  };
}

function toBase64(bytes: Uint8Array): string {
  // In chunks: spreading a multi-MB array into String.fromCharCode overflows the call stack.
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
