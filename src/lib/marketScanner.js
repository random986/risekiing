/* ══════════════════════════════════════════════════════════════
   DERIVPRINTER — Market Scanner
   Real-time analysis of all Deriv digit markets.
   Maintains 200-tick buffers, digit counter (CSPRNG model), rankings.
   ══════════════════════════════════════════════════════════════ */

import { analyzeDigitCounter, mergeCounterIntoScores } from './digitCounter.js';

export const MARKETS = [
  'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
  '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'
];

export const MARKET_LABELS = {
  'R_10': 'V10', 'R_25': 'V25', 'R_50': 'V50', 'R_75': 'V75', 'R_100': 'V100',
  '1HZ10V': 'V10 1s', '1HZ25V': 'V25 1s', '1HZ50V': 'V50 1s',
  '1HZ75V': 'V75 1s', '1HZ100V': 'V100 1s'
};

export function isLossForDir(d, dir, prevD = null, price = null, prevPrice = null, hottestDigit = null) {
  if (dir.startsWith('OVER')) return d <= parseInt(dir.slice(4), 10);
  if (dir.startsWith('UNDER')) return d >= parseInt(dir.slice(5), 10);
  if (dir === 'EVEN') return d % 2 !== 0;
  if (dir === 'ODD') return d % 2 === 0;
  if (dir === 'RISE') {
    if (price !== null && prevPrice !== null) return price <= prevPrice;
    return false;
  }
  if (dir === 'FALL') {
    if (price !== null && prevPrice !== null) return price >= prevPrice;
    return false;
  }
  if (dir === 'MATCH') {
    if (hottestDigit !== null) return d !== hottestDigit;
    return d !== 5;
  }
  if (dir === 'DIFF') {
    if (hottestDigit !== null) return d === hottestDigit;
    return d === 5;
  }
  return false;
}

/** Average length of interrupted loss runs (for convergence exhaustion depth). */
export function computeAvgMaxLossStreak(digits, pricesOrSide, side = null, hottestDigit = null) {
  let prices = null;
  let sideKey = '';
  if (Array.isArray(pricesOrSide)) {
    prices = pricesOrSide;
    sideKey = side;
  } else {
    sideKey = pricesOrSide;
  }
  const runs = [];
  let cur = 0;
  for (let i = 0; i < digits.length; i++) {
    const d = digits[i];
    const prevD = i > 0 ? digits[i-1] : null;
    const price = prices ? prices[i] : null;
    const prevPrice = (prices && i > 0) ? prices[i-1] : null;
    
    let isLoss = false;
    if (sideKey === 'over') isLoss = isLossForDir(d, 'OVER5', prevD, price, prevPrice, hottestDigit);
    else if (sideKey === 'under') isLoss = isLossForDir(d, 'UNDER5', prevD, price, prevPrice, hottestDigit);
    else if (sideKey === 'even') isLoss = isLossForDir(d, 'EVEN', prevD, price, prevPrice, hottestDigit);
    else if (sideKey === 'odd') isLoss = isLossForDir(d, 'ODD', prevD, price, prevPrice, hottestDigit);
    else isLoss = isLossForDir(d, sideKey, prevD, price, prevPrice, hottestDigit);
    
    if (isLoss) cur++;
    else {
      if (cur > 0) runs.push(cur);
      cur = 0;
    }
  }
  if (cur > 0) runs.push(cur);
  if (runs.length === 0) return 3;
  return runs.reduce((a, b) => a + b, 0) / runs.length;
}

function tailLossStreakFromEnd(digits, prices, dir, hottestDigit = null) {
  let streak = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = digits[i];
    const prevD = i > 0 ? digits[i-1] : null;
    const price = prices?.[i] ?? null;
    const prevPrice = i > 0 ? (prices?.[i-1] ?? null) : null;
    if (isLossForDir(d, dir, prevD, price, prevPrice, hottestDigit)) streak++;
    else break;
  }
  return streak;
}

/** Digit history depth — 1000 ticks for Rise/Fall condition + chi-square analysis. */
export const APEX_TICK_CAP = 1000;
export const APEX_ANALYSIS_WINDOW = 100;
const BUFFER_SIZE = APEX_TICK_CAP;
const ANALYSIS_WINDOW = 25;

/* ── Extract last digit from tick price using pip_size ── */
export function extractDigit(price, pipSize = 3) {
  const formatted = Number(price).toFixed(pipSize);
  return parseInt(formatted[formatted.length - 1], 10);
}

/* ── Market Scanner Class ── */
class MarketScanner {
  constructor() {
    this.buffers = {};     // symbol -> digit array
    this.priceBuffers = {}; // symbol -> price array (to compute RISE/FALL)
    this.scores = {};      // symbol -> analysis object
    this.pipSizes = {};    // symbol -> pip size
    this.tickCounts = {};  // symbol -> total ticks received
    this.lastTickAt = {};  // symbol -> local receipt epoch (network phase)
    this.listeners = new Set(); // multiple callbacks
    MARKETS.forEach(sym => {
      this.buffers[sym] = [];
      this.priceBuffers[sym] = [];
      this.scores[sym] = this._emptyScore();
      this.pipSizes[sym] = 3; // Default fallback
      this.tickCounts[sym] = 0;
      this.lastTickAt[sym] = 0;
    });
  }

  addTick(symbol, price, pipSize = null) {
    if (!this.buffers[symbol]) return;

    if (pipSize !== null) {
      this.pipSizes[symbol] = pipSize;
    }

    const digit = extractDigit(price, this.pipSizes[symbol]);
    const buf = this.buffers[symbol];
    buf.push(digit);
    if (buf.length > APEX_TICK_CAP) {
      this.buffers[symbol] = buf.slice(-APEX_TICK_CAP);
    }

    const numPrice = parseFloat(price) || 0;
    const pBuf = this.priceBuffers[symbol] || [];
    pBuf.push(numPrice);
    if (pBuf.length > APEX_TICK_CAP) {
      this.priceBuffers[symbol] = pBuf.slice(-APEX_TICK_CAP);
    }

    this.lastTickAt[symbol] = Date.now();
    this.tickCounts[symbol]++;

    const base = this._analyze(this.buffers[symbol], this.priceBuffers[symbol]);
    const counter = analyzeDigitCounter(this.buffers[symbol]);
    this.scores[symbol] = mergeCounterIntoScores(base, counter);

    this.listeners.forEach(cb => cb(symbol, this.scores));
  }

  onUpdate(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /* ── Get ranked markets for a strategy ── */
  getRanked(strategy = 'BOTH5') {
    return MARKETS
      .map(sym => ({ symbol: sym, label: MARKET_LABELS[sym], ...this.scores[sym] }))
      .sort((a, b) => {
        if (strategy === 'BOTH5') {
          const maxA = Math.max(parseFloat(a.overPct) || 0, parseFloat(a.underPct) || 0);
          const maxB = Math.max(parseFloat(b.overPct) || 0, parseFloat(b.underPct) || 0);
          return maxB - maxA;
        }
        const maxA = Math.max(parseFloat(a.evenPct) || 0, parseFloat(a.oddPct) || 0);
        const maxB = Math.max(parseFloat(b.evenPct) || 0, parseFloat(b.oddPct) || 0);
        return maxB - maxA;
      });
  }

  /* ── Get best market for a strategy ── */
  getBest(strategy = 'BOTH5') {
    const ranked = this.getRanked(strategy);
    return ranked[0]?.symbol || MARKETS[0];
  }

  getTicks(symbol) {
    return [...(this.buffers[symbol] || [])];
  }

  getAllScores() {
    return { ...this.scores };
  }

  isWarmed(minTicks = 30) {
    return MARKETS.every(s => (this.buffers[s]?.length || 0) >= minTicks);
  }

  /* ── Analysis engine ── */
  _analyze(digits, prices = null) {
    if (digits.length < 10) return this._emptyScore();

    const slice = digits.slice(-ANALYSIS_WINDOW);
    const full = digits.slice(-BUFFER_SIZE);
    const priceSlice = prices ? prices.slice(-ANALYSIS_WINDOW) : Array(slice.length).fill(0);
    
    // ═══ LONG-TERM TREND (last 100 ticks) ═══
    const LONG_WINDOW = 100;
    const longSlice = digits.slice(-Math.min(digits.length, LONG_WINDOW));
    const priceLongSlice = prices ? prices.slice(-Math.min(digits.length, LONG_WINDOW)) : Array(longSlice.length).fill(0);

    let ltOverCount = 0, ltUnderCount = 0;
    for (const d of longSlice) {
      if (d > 5) ltOverCount++;
      else if (d < 5) ltUnderCount++;
    }
    const ltOverPct = (ltOverCount / longSlice.length) * 100;
    const ltUnderPct = (ltUnderCount / longSlice.length) * 100;

    let ltEvenCount = 0, ltOddCount = 0;
    for (const d of longSlice) {
      if (d % 2 === 0) ltEvenCount++;
      else ltOddCount++;
    }
    const ltEvenPct = (ltEvenCount / longSlice.length) * 100;
    const ltOddPct = (ltOddCount / longSlice.length) * 100;

    // ═══ SHORT-TERM MOMENTUM (last 25 ticks) ═══
    // Over/Under 5 analysis
    let overCount = 0, underCount = 0, d5Count = 0;
    for (const d of slice) {
      if (d > 5) overCount++;
      else if (d < 5) underCount++;
      else d5Count++;
    }
    const overPct = (overCount / slice.length) * 100;
    const underPct = (underCount / slice.length) * 100;
    const d5Pct = (d5Count / slice.length) * 100;

    // Digit 5 penalty (baseline is 10%, penalize if > 15%)
    const d5Penalty = d5Pct > 15 ? (d5Pct - 15) * 2 : 0;
    const overUnderScore = Math.max(0, Math.max(overPct, underPct) - d5Penalty);

    // Even/Odd analysis
    let evenCount = 0, oddCount = 0;
    for (const d of slice) {
      if (d % 2 === 0) evenCount++;
      else oddCount++;
    }
    const evenPct = (evenCount / slice.length) * 100;
    const oddPct = (oddCount / slice.length) * 100;
    const balance = 100 - Math.abs(evenPct - oddPct);
    const evenOddScore = balance;

    // Streak analysis (from the end)
    let streak = 1;
    let streakType = null;
    if (slice.length >= 2) {
      const lastIsEven = slice[slice.length - 1] % 2 === 0;
      streakType = lastIsEven ? 'even' : 'odd';
      for (let i = slice.length - 2; i >= 0; i--) {
        if ((slice[i] % 2 === 0) === lastIsEven) streak++;
        else break;
      }
    }

    // ═══ CONSECUTIVE LOSS STREAK ANALYSIS ═══
    // Count how many of the LAST N ticks went AGAINST each direction
    // This tells us how "exhausted" the losing side is
    const recentWindow = digits.slice(-15);
    const priceRecentWindow = prices ? prices.slice(-15) : Array(recentWindow.length).fill(0);
    let recentOverLosses = 0, recentUnderLosses = 0;
    let recentEvenLosses = 0, recentOddLosses = 0;
    // Count from the END backwards — how many consecutive ticks go against each direction
    for (let i = recentWindow.length - 1; i >= 0; i--) {
      const d = recentWindow[i];
      if (d <= 5 && recentOverLosses === (recentWindow.length - 1 - i)) recentOverLosses++;
      if (d >= 5 && recentUnderLosses === (recentWindow.length - 1 - i)) recentUnderLosses++;
      if (d % 2 !== 0 && recentEvenLosses === (recentWindow.length - 1 - i)) recentEvenLosses++;
      if (d % 2 === 0 && recentOddLosses === (recentWindow.length - 1 - i)) recentOddLosses++;
    }

    // Confidence calculation (200-tick history)
    let confidence = 50;
    if (full.length >= 50) {
      let cont = 0, total = 0;
      for (let i = 1; i < full.length; i++) {
        const prev = full[i - 1] % 2 === 0;
        const curr = full[i] % 2 === 0;
        if (streakType === 'even' && prev) { total++; if (curr) cont++; }
        if (streakType === 'odd' && !prev) { total++; if (!curr) cont++; }
      }
      if (total > 0) confidence = (cont / total) * 100;
    }

    // Digit frequency distribution
    const freq = Array(10).fill(0);
    for (const d of slice) freq[d]++;

    const histBuf = digits.slice(-BUFFER_SIZE);
    const priceHistBuf = prices ? prices.slice(-BUFFER_SIZE) : Array(histBuf.length).fill(0);

    const slice20 = digits.slice(-20);
    const counts20 = Array(10).fill(0);
    for (const d of slice20) counts20[d]++;
    let maxCount = -1;
    let hottestDigit = 5;
    for (let d = 0; d < 10; d++) {
      if (counts20[d] > maxCount) {
        maxCount = counts20[d];
        hottestDigit = d;
      }
    }

    const avgMaxOverLoss = computeAvgMaxLossStreak(histBuf, priceHistBuf, 'over', hottestDigit);
    const avgMaxUnderLoss = computeAvgMaxLossStreak(histBuf, priceHistBuf, 'under', hottestDigit);
    const avgMaxEvenLoss = computeAvgMaxLossStreak(histBuf, priceHistBuf, 'even', hottestDigit);
    const avgMaxOddLoss = computeAvgMaxLossStreak(histBuf, priceHistBuf, 'odd', hottestDigit);
    const tailOverLoss = tailLossStreakFromEnd(histBuf, priceHistBuf, 'OVER5', hottestDigit);
    const tailUnderLoss = tailLossStreakFromEnd(histBuf, priceHistBuf, 'UNDER5', hottestDigit);
    const tailEvenLoss = tailLossStreakFromEnd(histBuf, priceHistBuf, 'EVEN', hottestDigit);
    const tailOddLoss = tailLossStreakFromEnd(histBuf, priceHistBuf, 'ODD', hottestDigit);

    const DIRS = ['OVER3','OVER4','OVER5','OVER6','OVER7','UNDER4','UNDER5','UNDER6','UNDER7','UNDER8','EVEN','ODD','RISE','FALL','MATCH','DIFF'];
    const pct = {};
    const ltPctMap = {};
    const recentLossesMap = {};
    const tailLossMap = {};
    const avgMaxLossMap = {};
    
    for (const dir of DIRS) {
      let count = 0;
      for (let i = 0; i < slice.length; i++) {
        const d = slice[i];
        const prevD = i > 0 ? slice[i-1] : null;
        const price = priceSlice[i];
        const prevPrice = i > 0 ? priceSlice[i-1] : null;
        if (!isLossForDir(d, dir, prevD, price, prevPrice, hottestDigit)) count++;
      }
      pct[dir] = ((count / slice.length) * 100).toFixed(1);
      
      let ltCount = 0;
      for (let i = 0; i < longSlice.length; i++) {
        const d = longSlice[i];
        const prevD = i > 0 ? longSlice[i-1] : null;
        const price = priceLongSlice[i];
        const prevPrice = i > 0 ? priceLongSlice[i-1] : null;
        if (!isLossForDir(d, dir, prevD, price, prevPrice, hottestDigit)) ltCount++;
      }
      ltPctMap[dir] = ((ltCount / longSlice.length) * 100).toFixed(1);
      
      let rL = 0;
      for (let i = recentWindow.length - 1; i >= 0; i--) {
        const d = recentWindow[i];
        const prevD = i > 0 ? recentWindow[i-1] : null;
        const price = priceRecentWindow[i];
        const prevPrice = i > 0 ? priceRecentWindow[i-1] : null;
        if (isLossForDir(d, dir, prevD, price, prevPrice, hottestDigit) && rL === (recentWindow.length - 1 - i)) rL++;
      }
      recentLossesMap[dir] = rL;
      
      tailLossMap[dir] = tailLossStreakFromEnd(histBuf, priceHistBuf, dir, hottestDigit);
      avgMaxLossMap[dir] = computeAvgMaxLossStreak(histBuf, priceHistBuf, dir, hottestDigit);
    }

    return {
      overCount, underCount, d5Count,
      overPct: overPct.toFixed(1),
      underPct: underPct.toFixed(1),
      d5Pct: d5Pct.toFixed(1),
      overUnderScore: Math.round(overUnderScore),
      evenCount, oddCount,
      evenPct: evenPct.toFixed(1),
      oddPct: oddPct.toFixed(1),
      evenOddScore: Math.round(evenOddScore),
      streak, streakType,
      confidence: Math.round(confidence),
      freq,
      tickCount: digits.length,
      lastDigit: digits[digits.length - 1],
      // ═══ DUAL-TIMEFRAME FIELDS ═══
      ltOverPct: ltOverPct.toFixed(1),
      ltUnderPct: ltUnderPct.toFixed(1),
      ltEvenPct: ltEvenPct.toFixed(1),
      ltOddPct: ltOddPct.toFixed(1),
      ltTickCount: longSlice.length,
      // ═══ CONSECUTIVE LOSS STREAK FIELDS ═══
      recentOverLosses,
      recentUnderLosses,
      recentEvenLosses,
      recentOddLosses,
      avgMaxOverLoss,
      avgMaxUnderLoss,
      avgMaxEvenLoss,
      avgMaxOddLoss,
      tailOverLoss,
      tailUnderLoss,
      tailEvenLoss,
      tailOddLoss,
      pct, ltPct: ltPctMap, recentLossesMap, tailLossMap, avgMaxLossMap,
    };
  }

  _emptyScore() {
    return {
      overCount: 0, underCount: 0, d5Count: 0,
      overPct: '0.0', underPct: '0.0', d5Pct: '0.0',
      overUnderScore: 0,
      evenCount: 0, oddCount: 0,
      evenPct: '0.0', oddPct: '0.0',
      evenOddScore: 0,
      streak: 0, streakType: null,
      confidence: 50,
      freq: Array(10).fill(0),
      tickCount: 0,
      lastDigit: null,
      avgMaxOverLoss: 3,
      avgMaxUnderLoss: 3,
      avgMaxEvenLoss: 3,
      avgMaxOddLoss: 3,
      tailOverLoss: 0,
      tailUnderLoss: 0,
      tailEvenLoss: 0,
      tailOddLoss: 0,
      counterReady: false,
      counterOverAligned: false,
      counterUnderAligned: false,
      pct: {}, ltPct: {}, recentLossesMap: {}, tailLossMap: {}, avgMaxLossMap: {},
    };
  }

  /* ── Reset all buffers ── */
  reset() {
    MARKETS.forEach(sym => {
      this.buffers[sym] = [];
      this.priceBuffers[sym] = [];
      this.scores[sym] = this._emptyScore();
    });
  }
}

const scanner = new MarketScanner();
export default scanner;
