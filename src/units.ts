export type Units = 'mm' | 'in';

/** Format a length in mm for display: millimetres, or inches to the nearest 1/16. */
export function fmtLen(mm: number, u: Units, withUnit = true): string {
  if (u === 'mm') return `${Math.round(mm * 10) / 10}${withUnit ? ' mm' : ''}`;
  const sixteenths = Math.round((mm / 25.4) * 16);
  const whole = Math.floor(sixteenths / 16);
  let num = sixteenths % 16;
  let den = 16;
  while (num && num % 2 === 0) { num /= 2; den /= 2; }
  const frac = num ? `${whole ? ' ' : ''}${num}/${den}` : '';
  return `${whole || !num ? whole : ''}${frac}${withUnit ? '"' : ''}`;
}

export const toUnits = (mm: number, u: Units) => (u === 'mm' ? Math.round(mm * 100) / 100 : Math.round((mm / 25.4) * 1000) / 1000);
export const fromUnits = (v: number, u: Units) => (u === 'mm' ? v : v * 25.4);
