import { sheetsNeeded, type NestItem, type NestSettings } from './nest';

/**
 * The smallest sheet to cut down from stock so the parts still nest on as few sheets as the
 * biggest allowed sheet needs. Used to size the piece of plywood for a CNC: the GORDIX can only
 * reach part of a full sheet, and on any machine a smaller blank wastes less stock.
 *
 * Sizes are long side first and rounded up to `step`. The search tries a few short sides and, for
 * each, the shortest long side that still fits, keeping the smallest area. Each check is a short,
 * deterministic run of the real nester, so the full nest at the suggested size needs no more sheets.
 */
export type SuggestRequest = {
  groups: NestItem[][];
  /** Packing settings; sheetW and sheetH are ignored. */
  settings: NestSettings;
  /** Biggest sheet allowed (stock size, or what the machine reaches), long side first, mm. */
  maxW: number;
  maxH: number;
  /** Round sizes up to this, mm. */
  step: number;
};

export type SuggestResult = {
  w: number;
  h: number;
  /** Sheets per group at the suggested size (same as at the biggest size). */
  sheets: number[];
  /** Parts per group that don't fit even on the biggest sheet. */
  unplaced: number[];
  /** Area used by the parts as a fraction of the suggested sheets' area. */
  fill: number;
};

/** Most time one size check may search, ms. Checks stop early once a size is known to fit. */
const CHECK_MS = 800;
/** Search time for the biggest sheet, which sets the target: as long as the real nest searches. */
const BASE_MS = { quick: 700, normal: 2500, thorough: 9000 };

export function suggestSheet(req: SuggestRequest, progress?: (done: number) => void): SuggestResult {
  const { groups, settings, step } = req;
  const up = (v: number) => Math.ceil(v / step - 1e-9) * step;
  const maxW = Math.floor(req.maxW / step + 1e-9) * step || req.maxW;
  const maxH = Math.min(maxW, Math.floor(req.maxH / step + 1e-9) * step || req.maxH);
  const at = (w: number, h: number) => ({ ...settings, sheetW: w, sheetH: h });

  // The target: what the biggest sheet needs. Parts that don't fit there are left out of the search.
  const base = groups.map((items) => sheetsNeeded(items, at(maxW, maxH), BASE_MS[settings.effort]));
  const target = base.map((b) => b.sheets);
  const unplaced = base.map((b) => b.unplaced);
  const fits = (w: number, h: number) => groups.every((items, g) => {
    if (!items.length) return true;
    const goal = { sheets: target[g], unplaced: unplaced[g] };
    const r = sheetsNeeded(items, at(w, h), Math.min(CHECK_MS, BASE_MS[settings.effort]), goal);
    return r.unplaced <= goal.unplaced && r.sheets <= goal.sheets;
  });

  // Lower bounds: every part has to fit inside the margins, and the parts' area has to fit at all.
  const m = 2 * settings.edgeMargin;
  // Only parts that can fit the biggest sheet count (the nester leaves the others out anyway).
  const fitsMax = (it: NestItem) => Math.min(it.w, it.h) + m <= maxH && Math.max(it.w, it.h) + m <= maxW;
  const all = groups.flat().filter(fitsMax);
  const minSide = Math.max(step, ...all.map((it) => Math.min(it.w, it.h) + m));
  const longest = Math.max(step, ...all.map((it) => Math.max(it.w, it.h) + m));
  // Per group: parts' area spread over its sheets, the most demanding group sets the bound.
  const areaNeed = Math.max(0, ...groups.map((items, g) => target[g] ? items.filter(fitsMax).reduce((a, it) => a + it.area, 0) / target[g] : 0));

  let best = { w: maxW, h: maxH };
  let done = 0;
  const tick = () => progress?.(++done);

  // Short sides to try, from the biggest down; at least `step` apart.
  const hLow = up(Math.min(minSide, maxH));
  const tries = 7;
  const hs = [...new Set(Array.from({ length: tries }, (_, i) => up(maxH - ((maxH - hLow) * i) / (tries - 1))))]
    .filter((h) => h <= maxH);

  for (const h of hs) {
    const usable = h - m;
    if (usable <= 0) continue;
    // Shortest long side worth checking: the longest part if it can't turn, and the area bound.
    let lo = up(Math.max(h, longest > h ? longest : minSide, areaNeed / usable + m));
    let hi = Math.min(maxW, Math.floor((best.w * best.h) / h / step + 1e-9) * step);
    if (lo > hi) continue;
    // Can it fit at all with this short side? (If not at the longest useful length, shorter won't.)
    tick();
    if (!fits(hi, h)) continue;
    // Binary search the shortest long side that fits (fitting is close enough to monotonic).
    while (lo < hi) {
      const mid = up((lo + hi) / 2 - step / 2);
      const w = Math.max(lo, Math.min(hi - step, mid));
      tick();
      if (fits(w, h)) hi = w; else lo = w + step;
    }
    if (hi * h < best.w * best.h - 1e-6) best = { w: hi, h };
  }

  const used = all.reduce((a, it) => a + it.area, 0);
  const sheets = target.reduce((a, b) => a + b, 0);
  return { ...best, sheets: target, unplaced, fill: sheets ? used / (sheets * best.w * best.h) : 0 };
}
