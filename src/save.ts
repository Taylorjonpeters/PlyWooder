/**
 * Saving files the user downloads. Where the browser has the File System Access pickers
 * (Chromium, including the Claude app's browser pane, which drops ordinary downloads), one file
 * opens a "Save as" dialog and several files go into one folder the user picks, so they arrive
 * together. Elsewhere each file is a normal download.
 *
 * Call it straight from a click handler, before any await: the pickers only open during a click.
 */
export type SaveFile = { name: string; text: string; type: string };

type Writable = { write: (data: Blob) => Promise<void>; close: () => Promise<void> };
type FileHandle = { createWritable: () => Promise<Writable> };
type DirHandle = { getFileHandle: (name: string, opts: { create: boolean }) => Promise<FileHandle> };
type Pickers = {
  showSaveFilePicker?: (opts: { suggestedName: string }) => Promise<FileHandle>;
  showDirectoryPicker?: (opts: { mode: 'readwrite' }) => Promise<DirHandle>;
};

const write = async (handle: FileHandle, f: SaveFile) => {
  const w = await handle.createWritable();
  await w.write(new Blob([f.text], { type: f.type }));
  await w.close();
};

/** A cancelled picker ends the save; any other failure falls back to plain downloads. */
const cancelled = (err: unknown) => (err as Error)?.name === 'AbortError';

export async function saveFiles(files: SaveFile[]): Promise<void> {
  if (!files.length) return;
  const w = window as unknown as Pickers;
  try {
    if (files.length === 1 && w.showSaveFilePicker) {
      await write(await w.showSaveFilePicker({ suggestedName: files[0].name }), files[0]);
      return;
    }
    if (files.length > 1 && w.showDirectoryPicker) {
      const dir = await w.showDirectoryPicker({ mode: 'readwrite' });
      for (const f of files) await write(await dir.getFileHandle(f.name, { create: true }), f);
      return;
    }
  } catch (err) {
    if (cancelled(err)) return;
    console.warn('Save dialog unavailable, downloading instead', err);
  }
  // Browsers drop rapid back-to-back downloads, so space them out.
  files.forEach((f, i) => setTimeout(() => download(f), i * 400));
}

function download(f: SaveFile) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([f.text], { type: f.type }));
  a.download = f.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
