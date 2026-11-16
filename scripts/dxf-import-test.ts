// DXF import checks: round-trip a PlyWooder export, and a hand-written drawing with arcs,
// bulges, a chained outline, a block insert, inch units and a sheet border.
import { readFileSync } from 'node:fs';
import { partsFromDxf } from '../src/dxfImport';
import { regionArea } from '../src/geom';

const show = (label: string, r: ReturnType<typeof partsFromDxf>) => {
  console.log(`${label}: ${r.parts.length} parts, units ${r.units}${r.unitsFromFile ? ' (file)' : ''}, open ${r.openShapes}, borders ${r.borders}`);
  for (const p of r.parts) {
    console.log(`  ${p.name.padEnd(20)} ${p.w.toFixed(1)} x ${p.h.toFixed(1)} x ${p.thickness.toFixed(1)}  holes=${p.regions.reduce((a, g) => a + g.holes.length, 0)} pockets=${p.pockets.map((k) => `${k.side}:${k.depth.toFixed(1)}`).join(',') || '-'} area=${regionArea(p.regions[0]).toFixed(0)}`);
  }
};

show('round trip', partsFromDxf(readFileSync('scripts/out/all.dxf', 'utf8'), 18));

// 2 in = 50.8 mm. Units: inches.
const pair = (c: number, v: string | number) => `${c}\n${v}`;
const ents = [
  // Sheet border 40 x 20 in on layer 0
  ['LWPOLYLINE', pair(8, 0), pair(90, 4), pair(70, 1), pair(10, 0), pair(20, 0), pair(10, 40), pair(20, 0), pair(10, 40), pair(20, 20), pair(10, 0), pair(20, 20)],
  // Rounded-end slot plate: 10 x 4 in with semicircle ends via bulges, and a 1 in hole
  ['LWPOLYLINE', pair(8, 'CUT'), pair(90, 4), pair(70, 1), pair(10, 2), pair(20, 2), pair(42, 0), pair(10, 10), pair(20, 2), pair(42, 1), pair(10, 10), pair(20, 6), pair(42, 0), pair(10, 2), pair(20, 6), pair(42, 1)],
  ['CIRCLE', pair(8, 'CUT'), pair(10, 6), pair(20, 4), pair(40, 0.5)],
  ['TEXT', pair(8, 'TXT'), pair(10, 5), pair(20, 3), pair(40, 0.3), pair(1, 'Slot plate')],
  // An L-bracket made of separate LINEs and an ARC (fillet), out of order
  ['LINE', pair(8, 'CUT'), pair(10, 15), pair(20, 2), pair(11, 22), pair(21, 2)],
  ['LINE', pair(8, 'CUT'), pair(10, 15), pair(20, 10), pair(11, 15), pair(21, 2)],
  ['LINE', pair(8, 'CUT'), pair(10, 22), pair(20, 2), pair(11, 22), pair(21, 4)],
  ['LINE', pair(8, 'CUT'), pair(10, 17), pair(20, 10), pair(11, 15), pair(21, 10)],
  ['LINE', pair(8, 'CUT'), pair(10, 17), pair(20, 6), pair(11, 17), pair(21, 10)],
  ['ARC', pair(8, 'CUT'), pair(10, 19), pair(20, 6), pair(40, 2), pair(50, 180), pair(51, 270)],
  ['LINE', pair(8, 'CUT'), pair(10, 19), pair(20, 4), pair(11, 22), pair(21, 4)],
  // Block of a 3 x 3 in square with a pocket, inserted twice (once rotated)
  ['INSERT', pair(8, 'CUT'), pair(2, 'SQ'), pair(10, 26), pair(20, 2)],
  ['INSERT', pair(8, 'CUT'), pair(2, 'SQ'), pair(10, 34), pair(20, 12), pair(50, 45)],
  // An open line that doesn't close
  ['LINE', pair(8, 'CUT'), pair(10, 30), pair(20, 15), pair(11, 35), pair(21, 18)],
];
const block = [
  `0\nBLOCK\n${pair(8, 0)}\n${pair(2, 'SQ')}\n${pair(70, 0)}\n${pair(10, 0)}\n${pair(20, 0)}`,
  `0\nLWPOLYLINE\n${[pair(8, 0), pair(90, 4), pair(70, 1), pair(10, 0), pair(20, 0), pair(10, 3), pair(20, 0), pair(10, 3), pair(20, 3), pair(10, 0), pair(20, 3)].join('\n')}`,
  `0\nLWPOLYLINE\n${[pair(8, 'POCKET_6_0mm'), pair(90, 4), pair(70, 1), pair(10, 1), pair(20, 1), pair(10, 2), pair(20, 1), pair(10, 2), pair(20, 2), pair(10, 1), pair(20, 2)].join('\n')}`,
  `0\nENDBLK`,
].join('\n');
const dxf = [
  '0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n1\n0\nENDSEC',
  `0\nSECTION\n2\nBLOCKS\n${block}\n0\nENDSEC`,
  '0\nSECTION\n2\nENTITIES',
  ...ents.map(([t, ...codes]) => `0\n${t}\n${codes.join('\n')}`),
  '0\nENDSEC\n0\nEOF',
].join('\n');
show('hand-made (in)', partsFromDxf(dxf, 18));
import { writeFileSync } from 'node:fs';
writeFileSync('scripts/out/handmade.dxf', dxf);
