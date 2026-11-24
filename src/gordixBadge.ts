/**
 * A small top view of the GORDIX for the corner of a sheet drawing, so it's clear which way the
 * machine faces the sheet. Drawn like GORDIX Studio's table page (table_conf.html, drawMachine):
 * four legs in an X, the rectangular box at the north end and the round screen at the south end.
 * North is the machine's +Y and east its +X; side S of the table runs along X.
 *
 * `turn` is how far the machine is turned on screen, in quarter turns clockwise: 0 when the drawing
 * is in machine coordinates (north up), 1 when the drawing shows the sheet and the G-code turns it
 * 90° (machine north then points to the sheet's +X, to the right).
 */
export function gordixBadge(turn: 0 | 1): string {
  const S = 100, c = S / 2;
  // Machine frame (x east, y north) to screen (y down), turned `turn` quarters clockwise.
  const at = (x: number, y: number): [number, number] => (turn ? [c + y, c + x] : [c + x, c - y]);
  const f = (v: number) => v.toFixed(1);
  const poly = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${f(at(x, y)[0])},${f(at(x, y)[1])}`).join('') + 'Z';
  // Legs: two bars crossed at 45°, as in Studio.
  const bar = (a: number) => {
    const ca = Math.cos(a), sa = Math.sin(a), L = 33, Wd = 8.5;
    return poly([[-L, -Wd], [L, -Wd], [L, Wd], [-L, Wd]].map(([x, y]) => [x * ca - y * sa, x * sa + y * ca] as [number, number]));
  };
  const [sx, sy] = at(0, -21);
  const arrow = (cls: string, label: string, dx: number, dy: number) => {
    const [x0, y0] = at(0, 0), [x1, y1] = at(dx * 41, dy * 41);
    const ux = (x1 - x0) / 40, uy = (y1 - y0) / 41, h = 5;
    const [lx, ly] = at(dx * 47, dy * 47);
    return `<g class="${cls}"><path d="M${f(x0)},${f(y0)}L${f(x1)},${f(y1)}M${f(x1 - ux * h - uy * h)},${f(y1 - uy * h + ux * h)}L${f(x1)},${f(y1)}L${f(x1 - ux * h + uy * h)},${f(y1 - uy * h - ux * h)}"/>`
      + `<text x="${f(lx)}" y="${f(ly)}" text-anchor="middle" dominant-baseline="central">${label}</text></g>`;
  };
  const title = turn
    ? 'GORDIX as it sits on this sheet. The G-code turns the sheet 90°: the box end (north, machine +Y) points to the right of this drawing.'
    : 'GORDIX as it sits on the sheet: box end is north (machine +Y), screen end is south. +X runs east.';
  return `<div class="gordixBadge${turn ? ' turned' : ''}" data-tip="${title}"><svg viewBox="0 0 ${S} ${S}" aria-label="${title}" role="img">`
    + `<path class="legs" d="${bar(Math.PI / 4)}${bar(-Math.PI / 4)}"/>`
    + `<path class="box" d="${poly([[-9, 12], [9, 12], [9, 33], [-9, 33]])}"/>`
    + `<circle class="hub" cx="${f(at(0, 0)[0])}" cy="${f(at(0, 0)[1])}" r="7"/>`
    + `<circle class="screen" cx="${f(sx)}" cy="${f(sy)}" r="6.5"/>`
    + `<g class="sheetAxes">${arrow('ax', 'X', 1, 0)}${arrow('ay', 'Y', 0, 1)}</g>`
    + `</svg><span>${turn ? 'GORDIX · north →' : 'GORDIX · north ↑'}</span></div>`;
}
