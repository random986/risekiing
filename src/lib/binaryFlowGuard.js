/**
 * Binary digit-flow analysis — avoid firing into active runs after losses.
 */
import { extractDigit } from './marketScanner.js';
import { isMomentumContinuationTrap } from './tradeDirection.js';

function lastDigits(ticks, n = 12) {
  const buf = ticks || [];
  const out = [];
  for (const t of buf.slice(-n)) {
    if (typeof t === 'number') {
      out.push(Math.abs(t) % 10);
      continue;
    }
    const d = t?.digit ?? t?.lastDigit;
    if (d != null && Number.isFinite(Number(d))) {
      out.push(Number(d) % 10);
      continue;
    }
    const dig = extractDigit(t?.price ?? t?.quote ?? t);
    if (dig != null) out.push(dig);
  }
  return out;
}

function runLengthAtEnd(digits, predicate) {
  let n = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    if (!predicate(digits[i])) break;
    n++;
  }
  return n;
}

/** @returns {{ chop: boolean, overRun: number, underRun: number, evenRun: number, oddRun: number, favored: string[], blocked: string[] }} */
export function analyzeBinaryFlow(ticks, strategy = 'BOTH5') {
  const digits = lastDigits(ticks, 16);
  const empty = { chop: true, overRun: 0, underRun: 0, evenRun: 0, oddRun: 0, favored: [], blocked: [] };
  if (digits.length < 8) return empty;

  const overRun = runLengthAtEnd(digits, d => d > 5);
  const underRun = runLengthAtEnd(digits, d => d < 5);
  const evenRun = runLengthAtEnd(digits, d => d % 2 === 0);
  const oddRun = runLengthAtEnd(digits, d => d % 2 !== 0);

  let flips = 0;
  for (let i = 1; i < digits.length; i++) {
    if (digits[i] !== digits[i - 1]) flips++;
  }
  const chop = flips >= digits.length * 0.55;

  const favored = [];
  const blocked = [];

  if (strategy === 'BOTH5' || strategy === 'OU_WINNING') {
    if (overRun >= 4) {
      blocked.push('OVER5');
      favored.push('UNDER5');
    } else if (underRun >= 4) {
      blocked.push('UNDER5');
      favored.push('OVER5');
    }
  }
  if (strategy === 'BOTH' || strategy === 'EO_WINNING') {
    if (evenRun >= 4) {
      blocked.push('EVEN');
      favored.push('ODD');
    } else if (oddRun >= 4) {
      blocked.push('ODD');
      favored.push('EVEN');
    }
  }

  return { chop, overRun, underRun, evenRun, oddRun, favored, blocked };
}

/**
 * After losses, require mean-reversion alignment with live digit flow.
 * NOW: always-on — chop and blocked directions checked even before first loss.
 */
export function passesBinaryFlowGate(ticks, dir, strategy, sessionLosses = 0) {
  if (!dir) return true;
  const digits = lastDigits(ticks, 12);
  if (digits.length < 6) return true;

  if (isMomentumContinuationTrap(digits, dir, 3, 3)) return false;

  const flow = analyzeBinaryFlow(ticks, strategy);
  // Always block chop — choppy markets have no mean-reversion edge
  if (flow.chop) return false;
  // Always block if direction is in an active opposing run
  if (flow.blocked.includes(dir)) return false;

  if (sessionLosses >= 2 && flow.favored.length && !flow.favored.includes(dir)) {
    return false;
  }

  return true;
}

export function flowScoreBonus(ticks, dir, strategy) {
  const flow = analyzeBinaryFlow(ticks, strategy);
  if (flow.favored.includes(dir)) return 12;
  if (flow.blocked.includes(dir)) return -20;
  if (flow.chop) return -8;
  return 0;
}
