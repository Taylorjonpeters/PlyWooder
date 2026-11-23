/**
 * Hairline X (red) and Y (green) arrows from one corner point, sized from the drawing's margin
 * `pad`. Directions are in screen terms (SVG y runs down): [1, 0] is right, [0, -1] is up.
 * Styled by `.sheetAxes` in style.css. Used by the layout sheets and the G-code preview.
 */
export function axesSvg(corner: { x: number; y: number }, dirX: [number, number], dirY: [number, number], pad: number): string {
  const len = pad * 2.6, hd = pad * 0.14;
  const arrow = (cls: string, label: string, [dx, dy]: [number, number]) => {
    const tx = corner.x + dx * len, ty = corner.y + dy * len;
    // Arrowhead: two short strokes back from the tip, either side of the shaft.
    const bx = tx - dx * hd, by = ty - dy * hd;
    const px = -dy * hd, py = dx * hd;
    const f = (v: number) => v.toFixed(1);
    return `<g class="${cls}"><path d="M${f(corner.x)},${f(corner.y)}L${f(tx)},${f(ty)}M${f(bx + px)},${f(by + py)}L${f(tx)},${f(ty)}L${f(bx - px)},${f(by - py)}"/>`
      + `<text x="${f(tx + dx * pad * 0.32)}" y="${f(ty + dy * pad * 0.32)}" text-anchor="middle" dominant-baseline="central">${label}</text></g>`;
  };
  return `<g class="sheetAxes" style="stroke-width:${(pad * 0.018).toFixed(2)}px;font-size:${(pad * 0.34).toFixed(1)}px">`
    + arrow('ax', 'X', dirX) + arrow('ay', 'Y', dirY) + '</g>';
}
