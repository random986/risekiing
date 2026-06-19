/** Digit direction helpers for BOTH / BOTH5 tournament firing. */

export function flipDigitDirection(dir) {
  if (dir === 'OVER5') return 'UNDER5';
  if (dir === 'UNDER5') return 'OVER5';
  if (dir === 'EVEN') return 'ODD';
  if (dir === 'ODD') return 'EVEN';
  return dir;
}

export function wouldDirectionWinOnDigit(digit, dir) {
  const d = parseInt(String(digit).slice(-1), 10);
  if (Number.isNaN(d)) return false;
  if (dir === 'EVEN') return d % 2 === 0;
  if (dir === 'ODD') return d % 2 !== 0;
  if (dir.startsWith('OVER')) return d > parseInt(dir.slice(4), 10);
  if (dir.startsWith('UNDER')) return d < parseInt(dir.slice(5), 10);
  return false;
}

/** Last N ticks mostly winning for `dir` = momentum continuation (bad for mean-reversion entries). */
export function isMomentumContinuationTrap(ticks, dir, window = 3, minHits = 3) {
  if (!ticks?.length || ticks.length < window) return false;
  let hits = 0;
  for (const t of ticks.slice(-window)) {
    if (wouldDirectionWinOnDigit(t, dir)) hits++;
  }
  return hits >= minHits;
}

/** Wider check: 4 of last 5 winning = still in momentum, not mean-reverting yet.
 *  Used as a ranking penalty (–40 unified score) so the market loses to any non-trapped market. */
export function isRecentlyDominant(ticks, dir, window = 5, minHits = 4) {
  if (!ticks?.length || ticks.length < window) return false;
  let hits = 0;
  for (const t of ticks.slice(-window)) {
    if (wouldDirectionWinOnDigit(t, dir)) hits++;
  }
  return hits >= minHits;
}
