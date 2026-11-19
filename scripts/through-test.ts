// Through-cut list: each cut says which piece it is made in. Self-contained.
import { throughCuts } from '../src/through';
import type { Region } from '../src/geom';

const box = (x0: number, y0: number, x1: number, y1: number): Region[] =>
  [{ outer: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], holes: [] }];

let failed = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? '  ok  ' : '  FAIL'}  ${msg}`); if (!ok) failed++; };

// Four parts in a 2 x 2 grid with a 6 mm kerf between them, on a 1000 x 600 sheet.
const grid = [
  { key: 'A', regions: box(10, 10, 490, 290) }, { key: 'B', regions: box(496, 10, 990, 290) },
  { key: 'C', regions: box(10, 296, 490, 590) }, { key: 'D', regions: box(496, 296, 990, 590) },
];
const plan = throughCuts(grid, 1000, 600, 6);
console.log(plan.cuts.map((c) => `${c.label}: ${c.vertical ? 'crosscut' : 'rip'} in ${c.piece}`).join('\n'));
check(plan.cuts.length === 3 && plan.freed === 4, 'a 2 x 2 grid takes 3 cuts and frees 4 parts');
check(plan.cuts[0].piece === 'the sheet', 'the first cut is made in the sheet');
check(plan.cuts[1].piece === 'the piece left of cut 1', 'the second cut names the piece left of cut 1');
check(plan.cuts[2].piece === 'the piece right of cut 1', 'the third cut names the piece right of cut 1');

// Three strips side by side: the middle strip sits between two cuts.
const strips = [
  { key: 'A', regions: box(10, 10, 300, 590) }, { key: 'B', regions: box(306, 10, 600, 300) }, { key: 'B2', regions: box(306, 306, 600, 590) },
  { key: 'C', regions: box(606, 10, 990, 590) },
];
const p2 = throughCuts(strips, 1000, 600, 6);
console.log(p2.cuts.map((c) => `${c.label}: ${c.vertical ? 'crosscut' : 'rip'} in ${c.piece}`).join('\n'));
check(p2.cuts.some((c) => c.piece === 'the piece between cuts 1 and 2'), 'a piece bounded by two cuts is named by both');

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('all passed');
