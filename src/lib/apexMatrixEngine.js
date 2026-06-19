/**
 * Multi-Market Matrix Sniper — unified 15-market × both-sides probability matrix.
 *
 * Strategy 1: Exhaustion Sniper (mean reversion on opposing digit runs)
 * Strategy 2: Macro Boundary Bounce (50-tick floor/ceiling + fast RSI/Stochastic)
 * Strategy 3: High-Probability Boundary Clusters (danger digits absent 5–6 ticks)
 *
 * Outputs a real-time leaderboard; cherry-picks one global apex entry.
 */

import { MARKETS, MARKET_LABELS, APEX_TICK_CAP, APEX_ANALYSIS_WINDOW } from './marketScanner.js';
import { isVirtualLossTick } from './convergenceCalculator.js';
import { isBinaryEntryTrap } from './binaryEntryTrap.js';
import { computeVirtualWinTrend, computeVirtualWinTrendFromMap } from './virtualWinTrend.js';
import {
  buildMeanReversionLeaderboard,
  resetMeanReversionLedgers,
  globalStrategyFocus,
  globalMatrixState,
  dirToContractType,
  runApexMatrix20Sweep,
  registerMatrix20Outcome,
  usesMatrix20Engine,
  isAssetBlacklisted,
  getGlobalMartingaleStake,
  getEffectiveWinRate,
  isHighVolatility,
  MEAN_REVERSION_CONFIG,
} from './apexMeanReversionLeaderboard.js';

export {
  globalStrategyFocus,
  globalMatrixState,
  MEAN_REVERSION_CONFIG,
  SNIPER_CONFIG,
  usesMatrix20Engine,
  isHighVolatility,
  getTop5,
  getTop10,
  evaluateSniperScore,
  buildSniperPool,
  buildTripleGateReadyPool,
  runApexMatrix20Sweep,
  registerMatrix20Outcome,
  isAssetBlacklisted,
  blacklistAsset,
  getGlobalMartingaleStake,
} from './apexMeanReversionLeaderboard.js';
import { BINARY_LOSS_P } from './entryEnsemble.js';
import {
  isApexOrderInFlight,
  tryAcquireApexLock,
  armApexOrderInFlight,
  setApexOrderInFlight,
} from './apexFlightLock.js';

export { APEX_TICK_CAP } from './marketScanner.js';
export const APEX_MACRO_LOOKBACK = 50;
export const APEX_CLUSTER_WINDOW = 6;
export const APEX_MIN_EXHAUSTION_STREAK = 4;
export const APEX_MAX_EXTEND_PROB = 0.0312;
export const APEX_MIN_CONFIDENCE = 55;

/** Per-index risk isolation — win resets per symbol; no cross-market stake bleed. */
export const ENGINE_CONFIG = {
  MARTINGALE_MULTIPLIER: 2,
  THROTTLE_WINDOW_MS: 1500,
  STAKE_SAFETY_CEILING: 0,
  SUPER_MIN_SCORE: 55,
  EXHAUSTION_STREAK_MIN: 4,
  MOMENTUM_MIN_TICKS: 8,
  CHOP_SKIP_THRESHOLD: 80,
  PREMIUM_SNIPE_THRESHOLD: 35,
  MIN_MEAN_REVERSION_WIN_RATE: MEAN_REVERSION_CONFIG.MIN_REQUIRED_WIN_RATE,
  VIRTUAL_LEDGER_DEPTH: MEAN_REVERSION_CONFIG.VIRTUAL_LEDGER_DEPTH,
  MARTINGALE_RESET_LOSSES: MEAN_REVERSION_CONFIG.MARTINGALE_RESET_LOSSES,
  SNIPER_SCORE_THRESHOLD: MEAN_REVERSION_CONFIG.SCORE_THRESHOLD,
  WIN_RATE_BAR: MEAN_REVERSION_CONFIG.WIN_RATE_BAR,
  ASSET_BLACKLIST_MS: MEAN_REVERSION_CONFIG.BLACKLIST_MS,
};

/** Live per-symbol chaos / snipe quality for the dashboard risk matrix. */
export const globalMarketRiskScores = {};

/** @deprecated alias */
export const RUNTIME_CONFIG = ENGINE_CONFIG;

const assetRiskMatrix = {};

const DIR_TO_CONTRACT = {
  OVER5: 'DIGITOVER',
  UNDER5: 'DIGITUNDER',
  EVEN: 'DIGITEVEN',
  ODD: 'DIGITODD',
};

/** Cap digit history for analysis windows (default 100; buffers hold up to 200). */
export function capTickBuffer(ticks, maxLen = APEX_ANALYSIS_WINDOW) {
  if (!ticks?.length) return [];
  return ticks.length > maxLen ? ticks.slice(-maxLen) : ticks;
}

function oppositeDir(dir) {
  if (dir === 'OVER5') return 'UNDER5';
  if (dir === 'UNDER5') return 'OVER5';
  if (dir === 'EVEN') return 'ODD';
  return 'EVEN';
}

/** Consecutive run length of opposite side winning (reversion setup). */
export function opposingRunStreak(ticks, dir) {
  const opp = oppositeDir(dir);
  let n = 0;
  for (let i = ticks.length - 1; i >= 0; i--) {
    if (isVirtualLossTick(ticks[i], dir)) n++;
    else break;
  }
  return n;
}

function targetLossStreak(ticks, dir) {
  let n = 0;
  for (let i = ticks.length - 1; i >= 0; i--) {
    if (isVirtualLossTick(ticks[i], dir)) n++;
    else break;
  }
  return n;
}

// ─── Strategy 1: Exhaustion Sniper ───────────────────────────────────────────

export function scoreExhaustionSniper(ticks, dir) {
  const opp = opposingRunStreak(ticks, dir);
  if (opp < APEX_MIN_EXHAUSTION_STREAK) {
    return { score: 0, oppStreak: opp, active: false };
  }

  let score = 10 + opp * 18;
  if (opp >= 5) score += 25;
  if (opp >= 6) score += 35;

  const lossP = BINARY_LOSS_P[oppositeDir(dir)] ?? 0.5;
  const extendProb = Math.pow(lossP, opp);
  if (extendProb <= APEX_MAX_EXTEND_PROB) score += 20;

  return { score: Math.round(score), oppStreak: opp, active: true, extendProb };
}

// ─── Strategy 2: Macro Boundary Bounce ───────────────────────────────────────

function computeRsi(values, period = 14) {
  if (values.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  const start = values.length - period;
  for (let i = start; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function computeStochastic(values, period = 14) {
  if (values.length < period) return 50;
  const slice = values.slice(-period);
  const low = Math.min(...slice);
  const high = Math.max(...slice);
  if (high === low) return 50;
  return ((values[values.length - 1] - low) / (high - low)) * 100;
}

export function scoreMacroBoundaryBounce(ticks, dir) {
  const macro = ticks.slice(-Math.min(APEX_MACRO_LOOKBACK, ticks.length));
  if (macro.length < 12) return { score: 0, active: false };

  const last = macro[macro.length - 1];
  const floor = Math.min(...macro);
  const ceiling = Math.max(...macro);
  const rsi = computeRsi(macro);
  const stoch = computeStochastic(macro);

  let score = 0;
  let active = false;

  const wantLow = dir === 'UNDER5' || dir === 'EVEN';
  const wantHigh = dir === 'OVER5' || dir === 'ODD';

  if (wantLow && last <= floor + 1 && floor <= 2) {
    if (rsi <= 35 || stoch <= 25) {
      score = 28 + (35 - rsi) * 0.4 + (25 - stoch) * 0.3;
      active = true;
    }
  }
  if (wantHigh && last >= ceiling - 1 && ceiling >= 7) {
    if (rsi >= 65 || stoch >= 75) {
      score = 28 + (rsi - 65) * 0.4 + (stoch - 75) * 0.3;
      active = true;
    }
  }

  return {
    score: Math.round(score),
    active,
    rsi: Math.round(rsi),
    stoch: Math.round(stoch),
    floor,
    ceiling,
    last,
  };
}

// ─── Strategy 3: Boundary Clusters ─────────────────────────────────────────────

const CLUSTER_RULES = {
  OVER5: { danger: [0, 1], label: 'low cluster clear' },
  UNDER5: { danger: [8, 9], label: 'high cluster clear' },
  EVEN: { danger: null },
  ODD: { danger: null },
};

export function scoreBoundaryCluster(ticks, dir, isOverUnder) {
  const w = ticks.slice(-APEX_CLUSTER_WINDOW);
  if (w.length < 4) return { score: 0, active: false };

  const rule = CLUSTER_RULES[dir];
  if (!rule?.danger) {
    return { score: isOverUnder ? 0 : 8, active: !isOverUnder };
  }

  const dangerPresent = w.some(d => rule.danger.includes(d));
  if (dangerPresent) return { score: 0, active: false, dangerPresent: true };

  const premium = dir === 'UNDER5' ? 32 : 22;
  return {
    score: premium + w.length * 2,
    active: true,
    dangerPresent: false,
    window: w.length,
  };
}

// ─── Combined matrix cell ────────────────────────────────────────────────────

export function evaluateMatrixCell(ticks, dir, isOverUnder, symbol = null) {
  const buf = capTickBuffer(ticks);
  if (buf.length < ENGINE_CONFIG.MOMENTUM_MIN_TICKS) {
    return null;
  }

  if (symbol) {
    const chaos = updateGlobalMarketRiskScore(symbol, buf);
    const tracker = getAssetTracker(symbol);
    if (chaos.riskPercent > ENGINE_CONFIG.CHOP_SKIP_THRESHOLD && tracker.currentMartingaleLevel === 0) {
      return null;
    }
  }

  if (isBinaryEntryTrap(buf, dir, {})) return null;

  const s1 = scoreExhaustionSniper(buf, dir);
  const s2 = scoreMacroBoundaryBounce(buf, dir);
  const s3 = scoreBoundaryCluster(buf, dir, isOverUnder);

  const confidenceScore = s1.score + s2.score + s3.score;
  const strategiesActive = [s1.active, s2.active, s3.active].filter(Boolean).length;
  const perfect = s1.active && s1.oppStreak >= APEX_MIN_EXHAUSTION_STREAK
    && (s2.active || !isOverUnder)
    && (s3.active || !isOverUnder);

  if (confidenceScore < APEX_MIN_CONFIDENCE && !perfect) return null;

  if (s1.active && s1.oppStreak >= APEX_MIN_EXHAUSTION_STREAK) {
    const len = buf.length;
    const t0 = buf[len - 1];
    const t1 = buf[len - 2];
    const t2 = buf[len - 3];
    const mode = isOverUnder
      ? (dir === 'OVER5' ? 'low' : 'high')
      : 'center';
    if (!passesThreeTickMomentum(t0, t1, t2, mode)) return null;
  }

  return {
    sym: null,
    dir,
    contractType: DIR_TO_CONTRACT[dir],
    confidenceScore: Math.round(confidenceScore),
    score: Math.round(confidenceScore),
    perfect,
    strategiesActive,
    oppStreak: s1.oppStreak,
    streak: targetLossStreak(buf, dir),
    strategy1: s1,
    strategy2: s2,
    strategy3: s3,
    algorithm: 'apex_matrix',
    ready: true,
    apexPerfect: perfect,
    binaryWinPct: Math.min(58, 42 + Math.floor(confidenceScore / 8)),
    convergenceScore: 50 + strategiesActive * 8,
  };
}

/**
 * Sweep all 15 markets × both sides — full leaderboard.
 */
export function runMatrixSweep(marketBuffers, strategy = 'BOTH5') {
  const isOverUnder = strategy === 'BOTH5' || strategy === 'OU_WINNING';
  const dirs = isOverUnder ? ['OVER5', 'UNDER5'] : ['EVEN', 'ODD'];
  const leaderboard = [];

  for (const sym of MARKETS) {
    const raw = marketBuffers[sym];
    const ticks = capTickBuffer(raw);
    if (ticks.length < ENGINE_CONFIG.MOMENTUM_MIN_TICKS) continue;
    updateGlobalMarketRiskScore(sym, ticks);

    for (const dir of dirs) {
      const cell = evaluateMatrixCell(ticks, dir, isOverUnder, sym);
      if (!cell) continue;
      leaderboard.push({
        ...cell,
        sym,
        marketLabel: MARKET_LABELS[sym] || sym,
        strategyFamily: isOverUnder ? 'OVER_UNDER' : 'EVEN_ODD',
      });
    }
  }

  leaderboard.sort((a, b) =>
    (b.perfect === true) - (a.perfect === true)
    || b.confidenceScore - a.confidenceScore
    || (b.oppStreak ?? 0) - (a.oppStreak ?? 0)
  );

  computeVirtualWinTrend(marketBuffers);
  buildMeanReversionLeaderboard(
    Object.fromEntries(MARKETS.map(sym => [sym, { history: marketBuffers[sym] || [] }])),
    strategy
  );

  const stealth = pickStealthTopEntry(leaderboard, APEX_MIN_CONFIDENCE, 3);
  const apex = stealth?.entry
    ? { ...stealth.entry, stealthRank: stealth.rank, stealthPool: stealth.poolSize }
    : leaderboard[0] || null;

  return {
    leaderboard,
    apex,
    stealthPick: stealth,
    scannedAt: Date.now(),
    marketCount: MARKETS.length,
    candidateCount: leaderboard.length,
  };
}

/** @deprecated alias */
export function sweepApexMatrix(marketBuffers, strategy) {
  return runMatrixSweep(marketBuffers, strategy).leaderboard;
}

export function sweepApexBestDualMarket(marketBuffers, isOverUnder) {
  const { leaderboard } = runMatrixSweep(
    marketBuffers,
    isOverUnder ? 'BOTH5' : 'BOTH'
  );
  if (!leaderboard.length) return null;

  const bySym = new Map();
  for (const c of leaderboard) {
    const prev = bySym.get(c.sym);
    if (!prev || c.confidenceScore > prev.confidenceScore) bySym.set(c.sym, c);
  }

  let best = null;
  for (const [, top] of bySym) {
    const combo = top.confidenceScore + (top.perfect ? 50 : 0);
    if (!best || combo > best.comboScore) {
      best = { market: top.sym, apex: top, comboScore: combo, ranked: leaderboard };
    }
  }
  return best;
}

/**
 * Leaderboard recovery pick for EO/OU dual winning — ranks markets where the
 * losing leg (e.g. EVEN) has mean-reversion / volatility edge to recover.
 */
export function sweepApexBestRecoveryForDir(marketBuffers, isOverUnder, rescueDir, opts = {}) {
  const strategy = isOverUnder ? 'BOTH5' : 'BOTH';
  const { leaderboard } = runMatrixSweep(marketBuffers, strategy);
  if (!leaderboard.length) return null;

  const minConf = Number(opts.minConfidence) || 38;
  const winBar = Number(opts.winRateBar) || MEAN_REVERSION_CONFIG.WIN_RATE_BAR;

  let candidates = rescueDir
    ? leaderboard.filter(c => c.dir === rescueDir)
    : [...leaderboard];
  if (rescueDir && !candidates.length) candidates = [...leaderboard];

  const scored = candidates.map((c, idx) => {
    const ticks = marketBuffers[c.sym] || [];
    const ct = c.contractType || dirToContractType(c.dir);
    const wr = ct ? getEffectiveWinRate(c.sym, ct, ticks) : 0;
    const volatile = isHighVolatility(ticks);
    const oppStreak = c.oppStreak ?? 0;
    const recoveryScore =
      c.confidenceScore
      + (c.perfect ? 50 : 0)
      + (volatile ? 14 : 0)
      + (wr >= winBar ? 12 : wr >= winBar - 8 ? 6 : 0)
      + Math.min(18, oppStreak * 3)
      + (rescueDir && c.dir === rescueDir ? 10 : 0);
    return { ...c, wr, volatile, recoveryScore, rank: idx + 1 };
  });

  scored.sort((a, b) =>
    (b.perfect === true) - (a.perfect === true)
    || b.recoveryScore - a.recoveryScore
    || b.confidenceScore - a.confidenceScore
  );

  const best = scored[0];
  if (!best || best.confidenceScore < minConf) return null;

  return {
    market: best.sym,
    apex: best,
    recoveryScore: best.recoveryScore,
    ranked: scored,
    leaderboard,
  };
}

/**
 * Build Deriv API buy payload for one apex candidate.
 */
export function buildApexBuyPayload(apexTrade, stake, currency = 'USD') {
  const spec = { contract_type: apexTrade.contractType || DIR_TO_CONTRACT[apexTrade.dir] };
  const payload = {
    buy: 1,
    price: stake,
    parameters: {
      amount: stake,
      basis: 'stake',
      contract_type: spec.contract_type,
      currency,
      duration: 1,
      duration_unit: 't',
      symbol: apexTrade.sym,
    },
  };
  if (apexTrade.dir === 'OVER5' || apexTrade.dir === 'UNDER5') {
    payload.parameters.barrier = '5';
  }
  return payload;
}

/**
 * Cherry-pick global apex and dispatch over shared WebSocket (single-flight).
 * @returns {Promise<object|null>} buy response or null if blocked
 */
export async function executeApexMatrixSweep({
  marketBuffers,
  strategy,
  derivWS,
  stake,
  currency,
  onLog,
}) {
  if (isApexOrderInFlight()) {
    return { blocked: true, reason: 'order_in_flight' };
  }

  const sweep = runMatrixSweep(marketBuffers, strategy);
  if (!sweep.apex) {
    return { blocked: true, reason: 'no_candidate', sweep };
  }

  if (!tryAcquireApexLock()) {
    return { blocked: true, reason: 'lock_race' };
  }

  const apex = sweep.apex;
  const label = apex.marketLabel || apex.sym;

  if (onLog) {
    onLog(
      `[APEX] ${label} ${apex.dir} · score ${apex.confidenceScore} · ` +
      `S1=${apex.strategy1?.score ?? 0} S2=${apex.strategy2?.score ?? 0} S3=${apex.strategy3?.score ?? 0}`
    );
  }

  try {
    const payload = buildApexBuyPayload(apex, stake, currency);
    const res = await derivWS.send(payload);
    armApexOrderInFlight();
    return { success: true, apex, response: res, sweep };
  } catch (err) {
    setApexOrderInFlight(false);
    return { success: false, error: err, apex };
  }
}

// ─── Fast-Pass Recovery (no 15-market matrix after a loss) ───────────────────

export const FAST_PASS_RECOVERY_MULT = 2.2;
export const FAST_PASS_MIN_TICKS = 5;

/** @type {{ wasLoss: boolean, failedMarket: string|null, failedDir: string|null, currentStep: number, strategy: string|null }} */
export const lastTradeStatus = {
  wasLoss: false,
  failedMarket: null,
  failedDir: null,
  currentStep: 0,
  strategy: null,
};

export function getFastPassRecoveryState() {
  return { ...lastTradeStatus };
}

export function resetGlobalRiskMatrix() {
  for (const sym of MARKETS) {
    assetRiskMatrix[sym] = {
      consecutiveLosses: 0,
      currentMartingaleLevel: 0,
      lockedStrategyGroup: null,
    };
    delete globalMarketRiskScores[sym];
  }
  resetMeanReversionLedgers();
  lastTradeStatus.wasLoss = false;
  lastTradeStatus.failedMarket = null;
  lastTradeStatus.failedDir = null;
  lastTradeStatus.currentStep = 0;
  setApexOrderInFlight(false);
}

export function getAssetTracker(symbol) {
  if (!symbol) return { consecutiveLosses: 0, currentMartingaleLevel: 0, lockedStrategyGroup: null };
  if (!assetRiskMatrix[symbol]) {
    assetRiskMatrix[symbol] = {
      consecutiveLosses: 0,
      currentMartingaleLevel: 0,
      lockedStrategyGroup: null,
    };
  }
  return assetRiskMatrix[symbol];
}

/** Matrix 2.0: circuit breaker after 4 global losses; legacy modes never hard-lock. */
export function isAssetCircuitBroken(symbol, opts = {}) {
  if (usesMatrix20Engine(opts.strategy)) {
    return isAssetBlacklisted(symbol);
  }
  return false;
}

/**
 * Martingale stake for one symbol; resets that symbol's level if stake breaches safety ceiling.
 */
export function getIsolatedStakeForSymbol(symbol, baseStake, opts = {}) {
  if (!symbol) return null;
  const tracker = getAssetTracker(symbol);
  const base = Math.max(0.35, Number(baseStake) || 0.35);
  const mult = Number(opts.martMultiplier) || ENGINE_CONFIG.MARTINGALE_MULTIPLIER || 2;
  const holdAfter = Math.max(0, Math.floor(Number(opts.martingaleHoldAfterStep) || 0));
  let level = Math.max(0, tracker.currentMartingaleLevel || 0);
  if (holdAfter > 0) level = Math.min(holdAfter, level);

  let calculated = base * Math.pow(mult, level);
  // Removed safety ceiling reset so martingale is continuous and doesn't reset/stale

  const userCap = opts.maxStakeCap;
  if (userCap != null && Number(userCap) > 0) {
    calculated = Math.min(calculated, Number(userCap));
  }
  return parseFloat(calculated.toFixed(2));
}

export function getAssetRiskSnapshot() {
  const out = {};
  for (const sym of MARKETS) {
    const t = getAssetTracker(sym);
    const risk = globalMarketRiskScores[sym];
    out[sym] = { ...t, atCeiling: false, ...risk };
  }
  return out;
}

// ─── Dynamic volatility & 3-tick momentum filter ─────────────────────────────

/** Chaos metric from recent tick deltas — lower = cleaner trend, higher = chop. */
export function computeMarketChaosScore(ticks) {
  const len = ticks?.length || 0;
  if (len < 6) {
    return { riskPercent: 50, status: 'STABLE', variance: 0 };
  }
  let variance = 0;
  for (let j = len - 4; j < len; j++) {
    variance += Math.abs(Number(ticks[j]) - Number(ticks[j - 1]));
  }
  const riskPercent = Math.min(Math.max(Math.round((variance / 45) * 100), 10), 100);
  const status = riskPercent > ENGINE_CONFIG.CHOP_SKIP_THRESHOLD
    ? 'HIGH CHOP'
    : riskPercent < ENGINE_CONFIG.PREMIUM_SNIPE_THRESHOLD
      ? 'PREMIUM SNIPE'
      : 'STABLE';
  return { riskPercent, status, variance };
}

export function updateGlobalMarketRiskScore(symbol, ticks) {
  if (!symbol) return null;
  const chaos = computeMarketChaosScore(ticks);
  globalMarketRiskScores[symbol] = {
    riskPercent: chaos.riskPercent,
    status: chaos.status,
    updatedAt: Date.now(),
  };
  return chaos;
}

/**
 * Last 3 ticks must accelerate into an extreme (not just a flat 4-run).
 * @param {'high'|'low'|'center'} mode
 */
export function passesThreeTickMomentum(t0, t1, t2, mode) {
  const a = Number(t0);
  const b = Number(t1);
  const c = Number(t2);
  if ([a, b, c].some(n => Number.isNaN(n))) return false;
  if (mode === 'high') return a >= b && b >= c && a > c;
  if (mode === 'low') return a <= b && b <= c && a < c;
  const d0 = Math.abs(a - 5);
  const d1 = Math.abs(b - 5);
  const d2 = Math.abs(c - 5);
  return d0 >= d1 && d1 >= d2 && d0 > d1;
}

function exhaustionScore(base, chaos) {
  if (!chaos) return base;
  if (chaos.riskPercent < ENGINE_CONFIG.PREMIUM_SNIPE_THRESHOLD) return Math.max(base, 130);
  if (chaos.riskPercent > ENGINE_CONFIG.CHOP_SKIP_THRESHOLD) return Math.min(base, 95);
  return base;
}

function scanEOExhaustion(t0, t1, t2, t3, t4, opts = {}) {
  const { chaos, requireMomentum = true } = opts;
  let best = null;
  const evenStreak = t0 % 2 === 0 && t1 % 2 === 0 && t2 % 2 === 0 && t3 % 2 === 0;
  const oddStreak = t0 % 2 !== 0 && t1 % 2 !== 0 && t2 % 2 !== 0 && t3 % 2 !== 0;

  if (evenStreak && (!requireMomentum || passesThreeTickMomentum(t0, t1, t2, 'center'))) {
    const base = t4 % 2 === 0 ? 120 : 110;
    const score = exhaustionScore(base, chaos);
    best = { contractType: 'DIGITODD', dir: 'ODD', score, strategyGroup: 'EVEN_ODD' };
  }
  if (oddStreak && (!requireMomentum || passesThreeTickMomentum(t0, t1, t2, 'center'))) {
    const base = t4 % 2 !== 0 ? 120 : 110;
    const score = exhaustionScore(base, chaos);
    if (!best || score > best.score) {
      best = { contractType: 'DIGITEVEN', dir: 'EVEN', score, strategyGroup: 'EVEN_ODD' };
    }
  }
  return best;
}

function scanOUExhaustion(t0, t1, t2, t3, opts = {}) {
  const { chaos, requireMomentum = true } = opts;
  let best = null;
  const under4 = t0 < 5 && t1 < 5 && t2 < 5 && t3 < 5;
  if (under4 && t0 !== 0 && t1 !== 1
    && (!requireMomentum || passesThreeTickMomentum(t0, t1, t2, 'low'))) {
    const score = exhaustionScore(110, chaos);
    best = { contractType: 'DIGITOVER', dir: 'OVER5', barrier: '5', score, strategyGroup: 'OVER_UNDER' };
  }
  const over4 = t0 > 5 && t1 > 5 && t2 > 5 && t3 > 5;
  if (over4 && t0 !== 9 && t1 !== 8
    && (!requireMomentum || passesThreeTickMomentum(t0, t1, t2, 'high'))) {
    const score = exhaustionScore(110, chaos);
    if (!best || score >= best.score) {
      best = { contractType: 'DIGITUNDER', dir: 'UNDER5', barrier: '5', score, strategyGroup: 'OVER_UNDER' };
    }
  }
  return best;
}

/**
 * Randomly pick among the top N scored entries (stealth — avoids always firing #1).
 */
export function pickStealthTopEntry(candidates, minScore = ENGINE_CONFIG.SUPER_MIN_SCORE, poolSize = 3) {
  const scoreOf = (c) => c.score ?? c.confidenceScore ?? 0;
  const eligible = (candidates || [])
    .filter(c => scoreOf(c) >= minScore)
    .sort((a, b) => scoreOf(b) - scoreOf(a));
  if (!eligible.length) return null;

  const pool = eligible.slice(0, Math.max(1, poolSize));
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const rank = pool.indexOf(pick) + 1;

  return {
    entry: pick,
    rank,
    poolSize: pool.length,
    topScore: scoreOf(eligible[0]),
    pickedScore: scoreOf(pick),
  };
}

/**
 * Call from settlement handlers — arms instant same-market recovery on next tick.
 */
export function updateRecoveryState(isWin, marketSymbol, opts = {}) {
  if (marketSymbol) {
    registerEngineTransaction(isWin, marketSymbol, opts);
  } else if (isWin) {
    lastTradeStatus.wasLoss = false;
    lastTradeStatus.failedMarket = null;
    lastTradeStatus.failedDir = null;
    lastTradeStatus.currentStep = 0;
  } else if (marketSymbol === null && !isWin) {
    /* no-op */
  }
  if (opts.strategy) lastTradeStatus.strategy = opts.strategy;
}

export function shouldUseFastPassRecovery() {
  return false;
}

function isOverUnderStrategy(strategy) {
  return strategy === 'BOTH5' || strategy === 'OU_WINNING';
}

/** Mean-reversion direction from last 3 digits on the failing market. */
export function resolveFastPassDirection(ticks, strategy) {
  const recent = (ticks || [])
    .slice(-3)
    .map(d => parseInt(d, 10))
    .filter(n => !Number.isNaN(n));
  if (recent.length < 2) return null;

  if (isOverUnderStrategy(strategy)) {
    const highCount = recent.filter(d => d > 5).length;
    return highCount >= 2 ? 'UNDER5' : 'OVER5';
  }
  const oddCount = recent.filter(d => d % 2 !== 0).length;
  return oddCount >= 2 ? 'EVEN' : 'ODD';
}

export function computeFastPassStake(baseStake, step, martMultiplier = FAST_PASS_RECOVERY_MULT) {
  const base = Math.max(0.35, Number(baseStake) || 0.35);
  const mult = Number(martMultiplier) || FAST_PASS_RECOVERY_MULT;
  const s = Math.max(0, Number(step) || 0);
  return parseFloat((base * Math.pow(mult, s)).toFixed(2));
}

/**
 * Build instant recovery order on the loss market — skips full matrix sweep.
 */
export function buildFastPassRecoveryOrder(marketBuffers, strategy, baseStake, opts = {}) {
  if (!shouldUseFastPassRecovery()) return null;

  if (usesMatrix20Engine(strategy)) {
    return null;
  }

  const sym = lastTradeStatus.failedMarket;
  const ticks = capTickBuffer(marketBuffers[sym] || []);
  if (ticks.length < FAST_PASS_MIN_TICKS) return null;

  const strat = strategy || lastTradeStatus.strategy || 'BOTH5';
  const dir = resolveFastPassDirection(ticks, strat);
  if (!dir) return null;

  const stake = computeFastPassStake(
    baseStake,
    lastTradeStatus.currentStep,
    opts.martMultiplier ?? FAST_PASS_RECOVERY_MULT
  );
  const maxStep = opts.maxStep ?? 8;
  if (lastTradeStatus.currentStep > maxStep) return null;

  return {
    sym,
    dir,
    stake,
    step: lastTradeStatus.currentStep,
    contractType: DIR_TO_CONTRACT[dir],
    marketLabel: MARKET_LABELS[sym] || sym,
    fastPass: true,
    algorithm: 'fast_pass_recovery',
  };
}

/**
 * Route: fast-pass recovery pool OR standard matrix cherry-pick.
 * @returns {{ mode: 'fast_pass'|'matrix', order?: object, sweep?: object }}
 */
export function runOptimizedApexDecision(marketBuffers, strategy, baseStake, opts = {}) {
  if (shouldUseFastPassRecovery()) {
    const order = buildFastPassRecoveryOrder(marketBuffers, strategy, baseStake, opts);
    if (order) return { mode: 'fast_pass', order };
  }
  const sweep = runMatrixSweep(marketBuffers, strategy);
  return { mode: 'matrix', sweep, order: sweep.apex || null };
}

function contractToDir(contractType, barrier) {
  if (contractType === 'DIGITOVER') return 'OVER5';
  if (contractType === 'DIGITUNDER') return 'UNDER5';
  if (contractType === 'DIGITEVEN') return 'EVEN';
  if (contractType === 'DIGITODD') return 'ODD';
  return barrier === '5' ? 'OVER5' : 'EVEN';
}

/**
 * Apex Matrix 2.0 — triple-gate, top-5 jitter, cross-asset pivot (BOTH / BOTH5).
 */
export function processSuperMatrixSweep(marketDataMap, config = {}) {
  const now = config.now ?? Date.now();
  const strategy = config.strategy || 'BOTH5';
  const baseStake = Math.max(0.35, Number(config.baseStake) || 0.35);

  computeVirtualWinTrendFromMap(marketDataMap);

  if (usesMatrix20Engine(strategy)) {
    return runApexMatrix20Sweep(marketDataMap, strategy, {
      now,
      baseStake,
      maxStakeCap: config.maxStakeCap,
      stakeSafetyCeiling: config.stakeSafetyCeiling ?? ENGINE_CONFIG.STAKE_SAFETY_CEILING,
      martMultiplier: config.martMultiplier ?? ENGINE_CONFIG.MARTINGALE_MULTIPLIER ?? 2,
      maxMartingaleStep: config.maxMartingaleStep,
      martingaleHoldAfterStep: config.martingaleHoldAfterStep ?? 0,
    });
  }

  buildMeanReversionLeaderboard(marketDataMap, strategy);
  return runMomentumFallbackSweep(marketDataMap, config, {
    stakeOpts: {
      maxStakeCap: config.maxStakeCap,
      stakeSafetyCeiling: config.stakeSafetyCeiling ?? ENGINE_CONFIG.STAKE_SAFETY_CEILING,
    },
    baseStake,
    now,
    strategy,
  });
}

/** Momentum + exhaustion fallback for EO_WINNING / OU_WINNING single-leg paths. */
function runMomentumFallbackSweep(marketDataMap, config, ctx) {
  const { stakeOpts, baseStake, now, strategy } = ctx;
  const scanEO = strategy === 'EO_WINNING' || strategy === 'OU_WINNING';
  const scanOU = strategy === 'OU_WINNING';
  const allCandidates = [];
  const minScore = Number(config.minScore) || ENGINE_CONFIG.SUPER_MIN_SCORE;

  for (const symbol of Object.keys(marketDataMap)) {
    const stream = marketDataMap[symbol];
    const ticks = stream?.history;
    if (!ticks || ticks.length < ENGINE_CONFIG.MOMENTUM_MIN_TICKS) continue;
    if (now - (stream.lastTickTimestamp || now) > 750) continue;

    const chaos = updateGlobalMarketRiskScore(symbol, ticks);
    const tracker = getAssetTracker(symbol);
    if (chaos.riskPercent > ENGINE_CONFIG.CHOP_SKIP_THRESHOLD && tracker.currentMartingaleLevel === 0) continue;

    const safeStake = getIsolatedStakeForSymbol(symbol, baseStake, stakeOpts);
    if (!safeStake) continue;

    const len = ticks.length;
    const t0 = ticks[len - 1];
    const t1 = ticks[len - 2];
    const t2 = ticks[len - 3];
    const t3 = ticks[len - 4];
    const t4 = ticks[len - 5];
    const scanOpts = { chaos, requireMomentum: true };
    const local = [];
    if (scanEO) {
      const eo = scanEOExhaustion(t0, t1, t2, t3, t4, scanOpts);
      if (eo) local.push(eo);
    }
    if (scanOU) {
      const ou = scanOUExhaustion(t0, t1, t2, t3, scanOpts);
      if (ou) local.push(ou);
    }
    for (const c of local) {
      allCandidates.push({
        symbol, sym: symbol, contractType: c.contractType, dir: c.dir,
        barrier: c.barrier, amount: safeStake, score: c.score,
      });
    }
  }

  const stealth = pickStealthTopEntry(allCandidates, minScore, 3);
  if (!stealth?.entry) {
    return { action: 'none', reason: 'no_candidate', topScore: 0, minScore };
  }
  const apexCandidate = stealth.entry;
  const targetStream = marketDataMap[apexCandidate.symbol];
  if (now - (targetStream?.lastTickTimestamp || now) > 750) {
    return { action: 'none', reason: 'commit_stream_lag', sym: apexCandidate.symbol };
  }
  return {
    action: 'matrix',
    ...apexCandidate,
    sym: apexCandidate.symbol,
    score: stealth.pickedScore,
    stealthRank: stealth.rank,
    stealthPool: stealth.poolSize,
  };
}

/**
 * Settlement — Matrix 2.0 uses global martingale + pivot blacklist; legacy modes per-asset.
 */
export function registerEngineTransaction(isWin, targetSymbol, opts = {}) {
  setApexOrderInFlight(false);
  if (!targetSymbol) return;

  if (usesMatrix20Engine(opts.strategy)) {
    const result = registerMatrix20Outcome(isWin, targetSymbol, opts);
    if (isWin) {
      lastTradeStatus.wasLoss = false;
      lastTradeStatus.failedMarket = null;
      lastTradeStatus.failedDir = null;
      lastTradeStatus.currentStep = 0;
    } else {
      lastTradeStatus.wasLoss = true;
      lastTradeStatus.failedMarket = targetSymbol;
      lastTradeStatus.failedDir = opts.dir ?? lastTradeStatus.failedDir;
      lastTradeStatus.currentStep = globalMatrixState.currentMartingaleLevel;
    }
    if (opts.strategy) lastTradeStatus.strategy = opts.strategy;
    return result;
  }

  const tracker = getAssetTracker(targetSymbol);

  if (isWin) {
    tracker.consecutiveLosses = 0;
    tracker.currentMartingaleLevel = 0;
    tracker.lockedStrategyGroup = null;
    if (lastTradeStatus.failedMarket === targetSymbol) {
      const winDir = opts.dir ?? null;
      const failedDir = lastTradeStatus.failedDir;
      const clearsFastPass = !failedDir || !winDir || failedDir === winDir;
      if (clearsFastPass) {
        lastTradeStatus.wasLoss = false;
        lastTradeStatus.failedMarket = null;
        lastTradeStatus.failedDir = null;
        lastTradeStatus.currentStep = 0;
      }
    }
  } else {
    tracker.consecutiveLosses += 1;
    tracker.currentMartingaleLevel += 1;
    const locked = opts.contractType || dirToContractType(opts.dir) || tracker.lockedStrategyGroup;
    if (locked) tracker.lockedStrategyGroup = locked;
    lastTradeStatus.wasLoss = true;
    lastTradeStatus.failedMarket = targetSymbol;
    lastTradeStatus.failedDir = opts.dir ?? lastTradeStatus.failedDir;
    lastTradeStatus.currentStep = tracker.currentMartingaleLevel;
  }
  if (opts.strategy) lastTradeStatus.strategy = opts.strategy;
}

/** @deprecated alias */
export function registerEngineFeedback(wasSuccessful, symbol, opts = {}) {
  registerEngineTransaction(wasSuccessful, symbol, opts);
}

export { isApexOrderInFlight, tryAcquireApexLock, armApexOrderInFlight, setApexOrderInFlight };
