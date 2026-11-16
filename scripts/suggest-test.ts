// Checks the sheet-size suggestion against a STEP file: npm run test:suggest -- path/to/file.step
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { partsFromStep } from '../src/parts';
import { groupItems } from '../src/layout';
import { nest, type NestSettings } from '../src/nest';
import { suggestSheet } from '../src/suggest';

const require = createRequire(import.meta.url);
const occtimportjs = require('occt-import-js');
const file = process.argv[2] ?? 'public/samples/RrReid_YarnStorage.step';
const occt = await occtimportjs();
const parts = partsFromStep(occt, new Uint8Array(readFileSync(file)));
const only = process.argv[3] ? Number(process.argv[3]) : Infinity; // optional: just the first N panels
const panels = parts.filter((p) => p.isPanel).slice(0, only).map((p) => p.id);
const groups = groupItems(parts, new Map(parts.map((p) => [p.id, { include: panels.includes(p.id), qty: 1 }])));
const settings: NestSettings = { sheetW: 0, sheetH: 0, edgeMargin: 12.7, kerf: 6.35, errorGap: 3.2, shareCuts: true, mode: 'optimal', shape: 'true', rotation: 'free90', effort: 'normal' };

for (const [maxW, maxH, label] of [[2438.4, 1219.2, '4x8 stock'], [2280, 1038, "GORDIX-ish reach"]] as const) {
  const t0 = performance.now();
  let checks = 0;
  const r = suggestSheet({ groups: groups.map((g) => g.items), settings, maxW, maxH, step: 10 }, (n) => (checks = n));
  const ms = performance.now() - t0;
  console.log(`${label}: suggest ${r.w} x ${r.h} mm, sheets ${r.sheets.join('/')}, unplaced ${r.unplaced.join('/')}, fill ${(r.fill * 100).toFixed(0)}% (${checks} checks, ${ms.toFixed(0)} ms)`);
  // The full nest at the suggested size must not need more sheets.
  groups.forEach((g, i) => {
    const full = nest(g.items, { ...settings, sheetW: r.w, sheetH: r.h });
    const ok = full.sheets.length <= r.sheets[i] && full.unplaced.length <= r.unplaced[i];
    console.log(`  ${g.thickness} mm: full nest ${full.sheets.length} sheets, ${full.unplaced.length} unplaced ${ok ? 'OK' : 'FAIL'}`);
    if (!ok) process.exitCode = 1;
  });
}
