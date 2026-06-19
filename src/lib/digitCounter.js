/**
 * Deriv binary digit counter — models CSPRNG last-digit output (uniform 0–9)
 * and refines entry using deficit/mean-reversion vs theoretical win mass.
 *
 * Deriv flow: CSPRNG → tick price → extractDigit(price, pipSize) → contract digit.
 * Long-run: each digit ≈ 10%; OVER wins on {6,7,8,9} ≈ 40%, UNDER on {0..4} ≈ 50%.
 */

import { directionWouldWin } from './convergenceCalculator.js';
import { BINARY_WIN_P, BINARY_BASELINE_PCT } from './entryEnsemble.js';

/** Equilibrium probability per digit (Deriv uniform last-digit model). */
export const UNIFORM_DIGIT_P = 0.1;

const WIN_WINDOWS = { short: 25, medium: 100, long: 200 };
const MIN_COUNTER_TICKS = 50;

function histogram(digits, windowSize) {
  const slice = digits.slice(-windowSize);
  const hist = Array(10).fill(0);
  for (const d of slice) {
    if (d >= 0 && d <= 9) hist[d]++;
  }
  return { hist, n: slice.length, slice };
}

function winMass(hist, n, dir) {
  if (n < 1) return 0;
  let wins = 0;
  for (let d = 0; d < 10; d++) {
    if (directionWouldWin(d, dir)) wins += hist[d];
  }
  return wins / n;
}

/**
 * Full counter state for one market buffer (call on every tick).
 */
export function analyzeDigitCounter(digits) {
  if (!digits || digits.length < 15) {
    return { ready: false, tickIndex: digits?.length ?? 0 };
  }

  const short = histogram(digits, WIN_WINDOWS.short);
  const medium = histogram(digits, WIN_WINDOWS.medium);
  const long = histogram(digits, WIN_WINDOWS.long);

  const d5PctMed = medium.n > 0 ? medium.hist[5] / medium.n : 0;
  const d5PctShort = short.n > 0 ? short.hist[5] / short.n : 0;
  const d5Surplus = d5PctMed - UNIFORM_DIGIT_P;

  const digitDeficit = medium.hist.map((c) => UNIFORM_DIGIT_P - (medium.n > 0 ? c / medium.n : 0));

  const sumWindow = digits.slice(-10);
  const sumMod10 = sumWindow.reduce((a, b) => a + b, 0) % 10;
  const sumHist = Array(10).fill(0);
  for (let i = 10; i <= digits.length; i++) {
    const s = digits.slice(i - 10, i).reduce((a, b) => a + b, 0) % 10;
    sumHist[s]++;
  }
  const sumBlocks = Math.max(1, digits.length - 9);
  const sumModDeficit = UNIFORM_DIGIT_P - sumHist[sumMod10] / sumBlocks;

  const dirEdge = {};
  for (const dir of ['OVER5', 'UNDER5', 'EVEN', 'ODD']) {
    const expected = BINARY_WIN_P[dir] ?? 0.5;
    const actualMed = winMass(medium.hist, medium.n, dir);
    const actualShort = winMass(short.hist, short.n, dir);
    const actualLong = winMass(long.hist, long.n, dir);
    const deficit = expected - actualMed;
    const momentum = actualShort - actualMed;
    const longBias = actualLong - expected;
    dirEdge[dir] = {
      expected,
      actualMed,
      actualShort,
      actualLong,
      deficit,
      momentum,
      longBias,
    };
  }

  let transitionBias = 0;
  const tail = digits.slice(-30);
  if (tail.length >= 2) {
    const last = tail[tail.length - 2];
    let same = 0;
    let total = 0;
    for (let i = 1; i < tail.length; i++) {
      if (tail[i - 1] === last) {
        total++;
        if (tail[i] === last) same++;
      }
    }
    if (total > 0) transitionBias = same / total - 0.1;
  }

  return {
    ready: medium.n >= MIN_COUNTER_TICKS,
    tickIndex: digits.length,
    d5PctMed,
    d5PctShort,
    d5Surplus,
    digitDeficit,
    sumMod10,
    sumModDeficit,
    transitionBias,
    dirEdge,
    hotDigit: digitDeficit.indexOf(Math.min(...digitDeficit)),
    coldDigit: digitDeficit.indexOf(Math.max(...digitDeficit)),
  };
}

/**
 * Counter signal for one direction — mean-reversion when win mass is below RNG expectation.
 */
export function getCounterSignal(counter, dir) {
  if (!counter?.ready) {
    return { score: 0, aligned: false, predictedPct: BINARY_BASELINE_PCT[dir] ?? 50 };
  }

  const edge = counter.dirEdge[dir];
  if (!edge) {
    return { score: 0, aligned: false, predictedPct: BINARY_BASELINE_PCT[dir] ?? 50 };
  }

  const baseline = BINARY_BASELINE_PCT[dir] ?? 50;
  let score = 0;

  if (edge.deficit >= 0.025) score += Math.min(35, edge.deficit * 280);
  if (edge.momentum >= 0) score += Math.min(15, edge.momentum * 120);
  if (edge.longBias <= 0.05) score += 8;

  if (counter.d5Surplus > 0.035 && (dir === 'OVER5' || dir === 'UNDER5')) {
    score -= Math.min(20, counter.d5Surplus * 200);
  }
  if (counter.d5Surplus < -0.02) score += 5;

  if (counter.sumModDeficit > 0.02) score += Math.min(10, counter.sumModDeficit * 80);

  const minDeficit = dir === 'OVER5' ? 0.028 : 0.022;
  const aligned = edge.deficit >= minDeficit
    && edge.momentum >= -0.03
    && score >= 18
    && (dir === 'OVER5' || dir === 'UNDER5' ? counter.d5PctMed <= 0.13 : counter.d5PctMed <= 0.12);

  const predictedPct = Math.round(
    Math.max(baseline, Math.min(baseline + 12, baseline + edge.deficit * 90 + (aligned ? 6 : 0)))
  );

  return { score: Math.round(score), aligned, predictedPct, edge };
}

export function counterAlignedForDirection(scores, dir) {
  const counter = scores?.counter;
  if (!counter?.ready) return false;
  return getCounterSignal(counter, dir).aligned;
}

/**
 * Pick best market+direction by counter deficit across buffers (omni refinement).
 */
export function rankMarketsByCounter(marketDigitsMap, dirs) {
  const rows = [];
  for (const [sym, digits] of Object.entries(marketDigitsMap)) {
    const counter = analyzeDigitCounter(digits);
    if (!counter.ready) continue;
    for (const dir of dirs) {
      const sig = getCounterSignal(counter, dir);
      if (!sig.aligned) continue;
      rows.push({ sym, dir, counterScore: sig.score, predictedPct: sig.predictedPct, counter });
    }
  }
  return rows.sort((a, b) => b.counterScore - a.counterScore);
}

export function mergeCounterIntoScores(scores, counter) {
  if (!counter?.ready) {
    return {
      ...scores,
      counter,
      counterReady: false,
    };
  }

  const overSig = getCounterSignal(counter, 'OVER5');
  const underSig = getCounterSignal(counter, 'UNDER5');
  const evenSig = getCounterSignal(counter, 'EVEN');
  const oddSig = getCounterSignal(counter, 'ODD');

  return {
    ...scores,
    counter,
    counterReady: true,
    counterTickIndex: counter.tickIndex,
    counterD5Surplus: parseFloat((counter.d5Surplus * 100).toFixed(2)),
    counterSumMod10: counter.sumMod10,
    counterOverScore: overSig.score,
    counterUnderScore: underSig.score,
    counterEvenScore: evenSig.score,
    counterOddScore: oddSig.score,
    counterOverAligned: overSig.aligned,
    counterUnderAligned: underSig.aligned,
    counterEvenAligned: evenSig.aligned,
    counterOddAligned: oddSig.aligned,
    counterOverPredicted: overSig.predictedPct,
    counterUnderPredicted: underSig.predictedPct,
  };
}
