import type { Pt } from './geom';

/**
 * A single-stroke font for marking part names with a laser or pen: each glyph is a few polylines
 * on a 4 × 6 grid (cap height 6, baseline 0). Outline fonts would need filling; single strokes
 * mark in one pass. Lowercase is drawn as uppercase.
 */
const GLYPHS: Record<string, string> = {
  A: '0,0 2,6 4,0; 0.8,2.4 3.2,2.4',
  B: '0,0 0,6 3,6 4,5 4,4 3,3 0,3; 3,3 4,2 4,1 3,0 0,0',
  C: '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1',
  D: '0,0 0,6 3,6 4,5 4,1 3,0 0,0',
  E: '4,6 0,6 0,0 4,0; 0,3 3,3',
  F: '4,6 0,6 0,0; 0,3 3,3',
  G: '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1 4,3 2,3',
  H: '0,0 0,6; 4,0 4,6; 0,3 4,3',
  I: '1,6 3,6; 2,6 2,0; 1,0 3,0',
  J: '4,6 4,1 3,0 1,0 0,1',
  K: '0,0 0,6; 4,6 0,2; 1.3,3.3 4,0',
  L: '0,6 0,0 4,0',
  M: '0,0 0,6 2,3 4,6 4,0',
  N: '0,0 0,6 4,0 4,6',
  O: '1,0 0,1 0,5 1,6 3,6 4,5 4,1 3,0 1,0',
  P: '0,0 0,6 3,6 4,5 4,4 3,3 0,3',
  Q: '1,0 0,1 0,5 1,6 3,6 4,5 4,1 3,0 1,0; 2.5,1.5 4,0',
  R: '0,0 0,6 3,6 4,5 4,4 3,3 0,3; 2,3 4,0',
  S: '4,5 3,6 1,6 0,5 0,4 1,3 3,3 4,2 4,1 3,0 1,0 0,1',
  T: '0,6 4,6; 2,6 2,0',
  U: '0,6 0,1 1,0 3,0 4,1 4,6',
  V: '0,6 2,0 4,6',
  W: '0,6 1,0 2,4 3,0 4,6',
  X: '0,0 4,6; 0,6 4,0',
  Y: '0,6 2,3 4,6; 2,3 2,0',
  Z: '0,6 4,6 0,0 4,0',
  0: '1,0 0,1 0,5 1,6 3,6 4,5 4,1 3,0 1,0; 0.3,1 3.7,5',
  1: '1,5 2,6 2,0; 1,0 3,0',
  2: '0,5 1,6 3,6 4,5 4,4 0,0 4,0',
  3: '0,5 1,6 3,6 4,5 4,4 3,3 4,2 4,1 3,0 1,0 0,1; 1.5,3 3,3',
  4: '3,0 3,6 0,2 4,2',
  5: '4,6 0,6 0,3 3,3 4,2 4,1 3,0 1,0 0,1',
  6: '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1 4,2 3,3 0,3',
  7: '0,6 4,6 1.5,0',
  8: '1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3 1,3 0,2 0,1 1,0 3,0 4,1 4,2 3,3',
  9: '0,1 1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,4 1,3 4,3',
  '-': '1,3 3,3',
  '(': '2.5,6 1.5,4.5 1.5,1.5 2.5,0',
  ')': '1.5,6 2.5,4.5 2.5,1.5 1.5,0',
  '.': '1.8,0 2.2,0 2.2,0.4 1.8,0.4 1.8,0',
  '#': '1,0 1.5,6; 2.5,0 3,6; 0,2 4,2; 0,4 4,4',
  '/': '0,0 4,6',
  _: '0,0 4,0',
  ' ': '',
};
const ADVANCE = 5.5;

const parsed = new Map<string, Pt[][]>(
  Object.entries(GLYPHS).map(([ch, s]) => [ch, s ? s.split(';').map((run) => run.trim().split(/\s+/).map((xy) => {
    const [x, y] = xy.split(',').map(Number);
    return { x, y };
  })) : []]),
);

/** Width of `text` at cap height `h`. */
export const textWidth = (text: string, h: number) => Math.max(0, text.length * ADVANCE - 1.5) * (h / 6);

/** Polylines for `text` centred on (cx, cy) at cap height `h`. Characters the font lacks are left blank. */
export function strokeText(text: string, cx: number, cy: number, h: number): Pt[][] {
  const k = h / 6;
  const x0 = cx - textWidth(text, h) / 2, y0 = cy - h / 2;
  const out: Pt[][] = [];
  [...text.toUpperCase()].forEach((ch, i) => {
    for (const run of parsed.get(ch) ?? []) {
      out.push(run.map((p) => ({ x: x0 + (i * ADVANCE + p.x) * k, y: y0 + p.y * k })));
    }
  });
  return out;
}
