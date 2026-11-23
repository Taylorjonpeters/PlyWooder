export type Units = 'mm' | 'cm' | 'in';

/** Format a length in mm for display: millimetres, centimetres to the millimetre, or inches to the nearest 1/16. */
export function fmtLen(mm: number, u: Units, withUnit = true): string {
  if (u === 'mm') return `${Math.round(mm * 10) / 10}${withUnit ? ' mm' : ''}`;
  if (u === 'cm') return `${Math.round(mm) / 10}${withUnit ? ' cm' : ''}`;
  const sixteenths = Math.round((mm / 25.4) * 16);
  const whole = Math.floor(sixteenths / 16);
  let num = sixteenths % 16;
  let den = 16;
  while (num && num % 2 === 0) { num /= 2; den /= 2; }
  const frac = num ? `${whole ? ' ' : ''}${num}/${den}` : '';
  return `${whole || !num ? whole : ''}${frac}${withUnit ? '"' : ''}`;
}

export const toUnits = (mm: number, u: Units) =>
  (u === 'mm' ? Math.round(mm * 100) / 100 : u === 'cm' ? Math.round(mm * 10) / 100 : Math.round((mm / 25.4) * 1000) / 1000);
export const fromUnits = (v: number, u: Units) => (u === 'mm' ? v : u === 'cm' ? v * 10 : v * 25.4);
