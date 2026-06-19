/* ══════════════════════════════════════════════════════════════
   DERIVPRINTER — Convergence Calculator
   5-signal entry quality gate for VL exhaustion trades.
   Signal 4 hard-blocks relieved streaks; 1/2/3/5 rank quality.
   ══════════════════════════════════════════════════════════════ */

import { MARKETS } from './marketScanner.js';

const PURITY_MIN = 0.92;
const MULTI_FRAME_MIN = 58;
const EXHAUSTION_RATIO = 0.85;
const RELIEF_WINDOW = 3;
const CROSS_MARKET_MIN = 2;

const BASELINE_WR = {
  OVER5: 40,
  UNDER5: 50,
  EVEN: 50,
  ODD: 50,
};

/** Mirror enhancedTradeEngine._directionWouldWin */
export function directionWouldWin(digit, direction) {
  if (direction === 'OVER5') return digit > 5;
  if (direction === 'UNDER5') return digit < 5;
  if (direction === 'EVEN') return digit % 2 === 0;
  if (direction === 'ODD') return digit % 2 !== 0;
  return false;
}

export function isVirtualLossTick(digit, direction) {
  if (direction === 'OVER5') return digit <= 5;
  if (direction === 'UNDER5') return digit >= 5;
  if (direction === 'EVEN') return digit % 2 !== 0;
  if (direction === 'ODD') return digit % 2 === 0;
  return false;
}

/** Tail consecutive loss streak from buffer end. */
export function tailLossStreak(ticks, direction) {
  let streak = 0;
  for (let i = ticks.length - 1; i >= 0; i--) {
    if (isVirtualLossTick(ticks[i], direction)) streak++;
    else break;
  }
  return streak;
}

/** Loss ticks in trailing window (not necessarily consecutive). */
export function lossCountInWindow(ticks, direction, windowSize) {
  const w = ticks.slice(-windowSize);
  return w.filter(d => isVirtualLossTick(d, direction)).length;
}

/** Average length of interrupted loss runs in buffer (for exhaustion depth). */
export function computeAvgMaxLossStreak(digits, side) {
  const isLoss = (d) => {
    if (side === 'over') return d <= 5;
    if (side === 'under') return d >= 5;
    if (side === 'even') return d % 2 !== 0;
    if (side === 'odd') return d % 2 === 0;
    return false;
  };
  const runs = [];
  let cur = 0;
  for (const d of digits) {
    if (isLoss(d)) cur++;
    else {
      if (cur > 0) runs.push(cur);
      cur = 0;
    }
  }
  if (cur > 0) runs.push(cur);
  if (runs.length === 0) return 3;
  const sum = runs.reduce((a, b) => a + b, 0);
  return sum / runs.length;
}

export function sideKeyForDirection(dir) {
  if (dir === 'OVER5') return 'over';
  if (dir === 'UNDER5') return 'under';
  if (dir === 'EVEN') return 'even';
  return 'odd';
}

export function avgMaxForDirection(scores, dir) {
  const sk = sideKeyForDirection(dir);
  if (sk === 'over') return scores.avgMaxOverLoss ?? 3;
  if (sk === 'under') return scores.avgMaxUnderLoss ?? 3;
  if (sk === 'even') return scores.avgMaxEvenLoss ?? 3;
  return scores.avgMaxOddLoss ?? 3;
}

export function computeStreakMetrics(ticks, dir) {
  const tailStreak = tailLossStreak(ticks, dir);
  const loss20 = lossCountInWindow(ticks, dir, 20);
  const purity = loss20 > 0 ? Math.min(1, tailStreak / loss20) : (tailStreak > 0 ? 1 : 0);
  const frames = [5, 10, 15, 20].map(w => {
    const slice = ticks.slice(-w);
    if (slice.length < w) return { w, pct: 0, ok: false };
    const losses = slice.filter(d => isVirtualLossTick(d, dir)).length;
    const pct = (losses / slice.length) * 100;
    return { w, pct, ok: pct >= MULTI_FRAME_MIN };
  });
  const multiFrameOk = frames.length === 4 && frames.every(f => f.ok);
  const last3 = ticks.slice(-RELIEF_WINDOW);
  const recentWins = last3.filter(d => directionWouldWin(d, dir)).length;
  return { tailStreak, loss20, purity, frames, multiFrameOk, recentWins, last3 };
}

/**
 * Evaluate all 5 convergence signals.
 */
export function evaluateSignals({ ticks, dir, scores = {}, allScores = {}, allTicks = {}, required = 4, symbol = null }) {
  const metrics = computeStreakMetrics(ticks, dir);
  const avgMax = avgMaxForDirection(scores, dir);
  const exhaustionOk = metrics.tailStreak >= avgMax * EXHAUSTION_RATIO;

  const purityPass = metrics.purity >= PURITY_MIN;
  const purityScore = Math.min(25, Math.round(metrics.purity * 25));

  const multiFrameScore = metrics.multiFrameOk
    ? 25
    : Math.round((metrics.frames.filter(f => f.ok).length / 4) * 25);

  const exhaustionScore = exhaustionOk
    ? 25
    : Math.min(25, Math.round((metrics.tailStreak / Math.max(avgMax, 1)) * 20));

  // Single win is noise during deep exhaustion (5+ streak) — only hard-block on 2+ wins
  // or if the streak is too shallow for a single blip to be noise
  const reliefBlocked = metrics.recentWins >= 2
    || (metrics.recentWins >= 1 && metrics.tailStreak < 5);
  const reliefReason = reliefBlocked
    ? `${metrics.recentWins} win(s) in last ${RELIEF_WINDOW} ticks (${metrics.last3.join(',')})${metrics.tailStreak >= 5 ? ' · deep streak override' : ''}`
    : null;

  let crossCount = 0;
  for (const sym of MARKETS) {
    if (sym === symbol) continue;
    const otherTicks = allTicks[sym];
    if (!otherTicks || otherTicks.length < 8) continue;
    const otherStreak = tailLossStreak(otherTicks, dir);
    if (otherStreak >= Math.max(1, required - 1)) {
      crossCount++;
      continue;
    }
    const otherScores = allScores[sym] || {};
    const biasPct = dir === 'OVER5' ? parseFloat(otherScores.overPct)
      : dir === 'UNDER5' ? parseFloat(otherScores.underPct)
      : dir === 'EVEN' ? parseFloat(otherScores.evenPct)
      : parseFloat(otherScores.oddPct);
    if (biasPct >= MULTI_FRAME_MIN) crossCount++;
  }
  const crossPass = crossCount >= CROSS_MARKET_MIN;
  const crossScore = Math.min(25, Math.round((crossCount / Math.max(CROSS_MARKET_MIN, 1)) * 25));

  const convergenceScore = purityScore + multiFrameScore + exhaustionScore + crossScore;

  return {
    signal1: { name: 'purity', pass: purityPass, score: purityScore, value: metrics.purity },
    signal2: { name: 'multiFrame', pass: metrics.multiFrameOk, score: multiFrameScore, frames: metrics.frames },
    signal3: { name: 'exhaustion', pass: exhaustionOk, score: exhaustionScore, tail: metrics.tailStreak, avgMax },
    signal4: { name: 'relief', pass: !reliefBlocked, blocked: reliefBlocked, reason: reliefReason, recentWins: metrics.recentWins },
    signal5: { name: 'crossMarket', pass: crossPass, score: crossScore, count: crossCount },
    convergenceScore,
    metrics,
  };
}

/**
 * Full convergence scan for a market+direction entry.
 * @param {string} symbol
 * @param {string} dir - OVER5 | UNDER5 | EVEN | ODD
 * @param {object} ctx - { ticks, scores, allScores, allTicks, required, streak }
 */
export function convergenceScan(symbol, dir, ctx = {}) {
  const ticks = ctx.ticks || [];
  const scores = ctx.scores || {};
  const required = ctx.required ?? 4;
  const streak = ctx.streak ?? tailLossStreak(ticks, dir);

  if (ticks.length < 8) {
    return {
      blocked: true,
      blockReason: 'insufficient ticks',
      convergenceScore: 0,
      winEst: 0,
      signals: null,
      streak,
    };
  }

  const signals = evaluateSignals({
    ticks,
    dir,
    scores,
    allScores: ctx.allScores || {},
    allTicks: ctx.allTicks || {},
    required,
    symbol,
  });

  const blocked = signals.signal4.blocked;
  const blockReason = blocked ? signals.signal4.reason : null;
  const baseline = BASELINE_WR[dir] ?? 50;
  const winEst = Math.max(0, Math.min(72, Math.round(
    baseline + (signals.convergenceScore - 50) * 0.35 + Math.min(6, Math.max(0, streak - required) * 1.5)
  )));

  return {
    blocked,
    blockReason,
    convergenceScore: signals.convergenceScore,
    signals,
    winEst,
    streak,
    purity: signals.signal1.value,
    crossCount: signals.signal5.count,
  };
}

/** Preset self-checks (run via node import). */
export function runConvergenceSelfChecks() {
  const recentWinBlocked = {
    ticks: [7, 8, 9, 7, 8, 3, 2, 1],
    dir: 'UNDER5',
    scores: { avgMaxUnderLoss: 4 },
  };
  const r1 = convergenceScan('R_25', recentWinBlocked.dir, {
    ticks: recentWinBlocked.ticks,
    scores: recentWinBlocked.scores,
    required: 4,
  });
  if (!r1.blocked) throw new Error('Preset "Recent win blocked" should be blocked');

  const clean = {
    ticks: [4, 3, 4, 5, 4, 3, 4, 5, 4, 3, 4, 5],
    dir: 'OVER5',
    scores: { avgMaxOverLoss: 4 },
  };
  const r2 = convergenceScan('R_10', clean.dir, {
    ticks: clean.ticks,
    scores: clean.scores,
    required: 4,
    streak: 12,
  });
  if (r2.blocked) throw new Error('Preset "Clean signal" should not be blocked');
  if (r2.convergenceScore < 50) throw new Error('Preset "Clean signal" should score >= 50');

  return { recentWinBlocked: r1, clean: r2 };
}
