/** Safe numeric formatting — Deriv/API values are often strings. */
export function num(v, fallback = 0) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function fmt(v, digits = 2) {
  return num(v).toFixed(digits);
}

export function fmtMoney(v) {
  return fmt(v, 2);
}

export function fmtPct(v, digits = 1) {
  return `${fmt(v, digits)}%`;
}
