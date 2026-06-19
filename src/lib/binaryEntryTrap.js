/**
 * Shared binary digit trap detection for synthetic BOTH / BOTH5 entry ranking.
 * Skips clustered digits, heavy digit-5 noise, chop without edge, and false hot streaks.
 */

import { analyzeDigitCounter } from './digitCounter.js';

function oppositeStreak(ticks, dir) {
  let streak = 0;
  for (let i = ticks.length - 1; i >= 0; i--) {
    const digit = parseInt(String(ticks[i]).slice(-1), 10);
    if (Number.isNaN(digit)) break;
    let isOpposite = false;
    if (dir === 'EVEN') isOpposite = digit % 2 !== 0;
    else if (dir === 'ODD') isOpposite = digit % 2 === 0;
    else if (dir.startsWith('OVER')) {
      isOpposite = digit <= parseInt(dir.slice(4), 10);
    } else if (dir.startsWith('UNDER')) {
      isOpposite = digit >= parseInt(dir.slice(5), 10);
    }
    if (isOpposite) streak++;
    else break;
  }
  return streak;
}

function winFrequency(ticks, dir, windowSize = 10) {
  const count = Math.min(windowSize, ticks.length);
  if (count <= 0) return 0;
  let wins = 0;
  for (const tick of ticks.slice(-count)) {
    const digit = parseInt(String(tick).slice(-1), 10);
    if (Number.isNaN(digit)) continue;
    let won = false;
    if (dir === 'EVEN') won = digit % 2 === 0;
    else if (dir === 'ODD') won = digit % 2 !== 0;
    else if (dir.startsWith('OVER')) won = digit > parseInt(dir.slice(4), 10);
    else if (dir.startsWith('UNDER')) won = digit < parseInt(dir.slice(5), 10);
    if (won) wins++;
  }
  return wins / count;
}

function chopIndex(ticks, window = 10) {
  const slice = ticks.slice(-window);
  if (slice.length < 3) return 50;
  let flips = 0;
  for (let i = 1; i < slice.length; i++) {
    const prevOver = slice[i - 1] > 5;
    const currOver = slice[i] > 5;
    const prevEven = slice[i - 1] % 2 === 0;
    const currEven = slice[i] % 2 === 0;
    if (prevOver !== currOver || prevEven !== currEven) flips++;
  }
  return Math.round((flips / (slice.length - 1)) * 100);
}

/**
 * Standard Deviation of tick digits — measures market volatility/noise.
 * Lower values = cleaner trend, higher values = choppy/noisy.
 * @param {number[]} ticks
 * @param {number} window
 * @returns {number} standard deviation (0–4.5 range for digits 0–9)
 */
export function tickStdDev(ticks, window = 20) {
  const slice = ticks.slice(-window).map(t => parseInt(String(t).slice(-1), 10)).filter(d => !Number.isNaN(d));
  if (slice.length < 3) return 3; // default to moderate
  const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / slice.length;
  return Math.sqrt(variance);
}

/**
 * Relative Strength Index adapted for digit ticks.
 * Measures directional momentum: >70 = overbought (too many wins recently),
 * <30 = oversold (overdue for wins). Best entries are near 30–45 (reversal zone).
 * @param {number[]} ticks
 * @param {string} dir - direction like 'EVEN', 'ODD', 'OVER5', 'UNDER5'
 * @param {number} period
 * @returns {number} RSI value 0–100
 */
export function digitRSI(ticks, dir, period = 14) {
  const slice = ticks.slice(-(period + 1));
  if (slice.length < 3) return 50; // neutral default
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const digit = parseInt(String(slice[i]).slice(-1), 10);
    if (Number.isNaN(digit)) continue;
    let won = false;
    if (dir === 'EVEN') won = digit % 2 === 0;
    else if (dir === 'ODD') won = digit % 2 !== 0;
    else if (dir.startsWith('OVER')) won = digit > parseInt(dir.slice(4), 10);
    else if (dir.startsWith('UNDER')) won = digit < parseInt(dir.slice(5), 10);
    if (won) gains++;
    else losses++;
  }
  if (losses === 0) return 100;
  if (gains === 0) return 0;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

/**
 * @returns {boolean} true when the setup should be skipped (trap / false edge)
 */
export function isBinaryEntryTrap(ticks, dir, scores = {}) {
  if (!ticks || ticks.length < 5) return true;

  const last5 = ticks.slice(-5);
  const counts = {};
  for (const d of last5) counts[d] = (counts[d] || 0) + 1;
  if (Object.values(counts).some(c => c >= 3)) return true;

  // New rules for avoiding poor digit distributions (red/yellow/green bars)
  if (scores?.freq && scores.freq.length === 10) {
    const sortedFreq = scores.freq.map((count, digit) => ({ count, digit })).sort((a, b) => b.count - a.count);
    
    const highestCount = sortedFreq[0].count;
    const lowestCount = sortedFreq[9].count;

    const highestTies = sortedFreq.filter(p => p.count === highestCount).length;
    const lowestTies = sortedFreq.filter(p => p.count === lowestCount).length;

    // Avoid markets with two green bars or two red bars
    if (highestTies >= 2 || lowestTies >= 2) return true;

    const redDigit = sortedFreq[9].digit;
    const yellowDigit = sortedFreq[8].digit;

    const isDigitInSide = (d, direction) => {
      if (direction === 'EVEN') return d % 2 === 0;
      if (direction === 'ODD') return d % 2 !== 0;
      if (direction.startsWith('OVER')) return d > parseInt(direction.slice(4), 10);
      if (direction.startsWith('UNDER')) return d < parseInt(direction.slice(5), 10);
      return false;
    };

    // Avoid when the lowest (red) OR second lowest (yellow) appearing digit are in the side of the trade
    if (isDigitInSide(redDigit, dir) || isDigitInSide(yellowDigit, dir)) {
      return true;
    }
  }

  const counter = scores.counter || analyzeDigitCounter(ticks);
  if (counter?.ready) {
    if ((dir.startsWith('OVER') || dir.startsWith('UNDER')) && counter.d5PctShort > 0.14) return true;
    if (counter.transitionBias > 0.18 && oppositeStreak(ticks, dir) <= 1) return true;
  }

  const chop = chopIndex(ticks, 10);
  const oppStreak = oppositeStreak(ticks, dir);
  if (chop > 68 && oppStreak < 3) return true;

  const baseline = 0.5;
  const winFreq = winFrequency(ticks, dir, 10);
  if (winFreq > baseline + 0.28 && oppStreak < 3) return true;

  return false;
}
