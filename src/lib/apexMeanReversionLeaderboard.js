/**
 * Apex Matrix 2.0 — Sniper scoring, 60-vector leaderboard, cross-asset pivot.
 */
import { MARKETS, MARKET_LABELS } from './marketScanner.js';
import { isVirtualLossTick } from './convergenceCalculator.js';

export const MEAN_REVERSION_CONFIG = {
  VIRTUAL_LEDGER_DEPTH: 40,
  WIN_RATE_BAR: 58,
  LIVE_WR_MIN_TICKS: 12,
  SCORE_THRESHOLD: 6,
  SCORE_EXHAUSTION_5: 6,
  SCORE_EXHAUSTION_4: 6,
  SCORE_VOLATILITY: 2,
  SCORE_TOP10: 2,
  VOLATILITY_WINDOW: 100,
  VOLATILITY_MIN_STREAK: 5,
  EXHAUSTION_TICKS: 5,
  LEDGER_MIN_SAMPLES: 4,
  BLACKLIST_MS: 2000,
  MARTINGALE_RESET_LOSSES: 8,
  TOP_LEADERBOARD_SIZE: 10,
  STREAM_LAG_MS: 1200,
  /** @deprecated use MARTINGALE_RESET_LOSSES */
  CIRCUIT_BREAKER_LOSSES: 8,
  MIN_REQUIRED_WIN_RATE: 58,
};

export const SNIPER_CONFIG = MEAN_REVERSION_CONFIG;
export const APEX_MATRIX_20_CONFIG = MEAN_REVERSION_CONFIG;

const CONTRACT_TYPES = ['DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER'];

/** @type {Record<string, Record<string, boolean[]>>} */
const marketVirtualLedgers = {};

/** @type {Record<string, number>} */
const assetBlacklist = {};

export const globalMatrixState = {
  currentMartingaleLevel: 0,
  globalConsecutiveLosses: 0,
  lastLossSymbol: null,
  circuitBreakerTripped: false,
};

export const globalStrategyFocus = {
  activeTargetMarket: 'INITIALIZING SNIPER MATRIX...',
  readyPoolSize: 0,
  activeRecoveries: 0,
  blacklistedCount: 0,
  martingaleLevel: 0,
  globalLossStreak: 0,
  bestSniperScore: 0,
  currentMode: 'INITIALIZING...',
  leaderboardDisplay: [],
  topVectors: [],
};

function emptyLedger() {
  return { DIGITEVEN: [], DIGITODD: [], DIGITOVER: [], DIGITUNDER: [] };
}

function ensureLedger(symbol) {
  if (!marketVirtualLedgers[symbol]) marketVirtualLedgers[symbol] = emptyLedger();
  return marketVirtualLedgers[symbol];
}

function trimLedger(ledger) {
  const depth = MEAN_REVERSION_CONFIG.VIRTUAL_LEDGER_DEPTH;
  for (const type of CONTRACT_TYPES) {
    if (ledger[type].length > depth) ledger[type] = ledger[type].slice(-depth);
  }
}

function maxConsecutiveRun(ticks, predicate) {
  let max = 0;
  let cur = 0;
  for (const d of ticks) {
    const n = Number(d);
    if (Number.isNaN(n)) {
      cur = 0;
      continue;
    }
    if (predicate(n)) {
      cur += 1;
      max = Math.max(max, cur);
    } else {
      cur = 0;
    }
  }
  return max;
}

/**
 * High volatility: 5+ streak of even / odd / over / under in lookback window (default 100 ticks).
 */
export function isHighVolatility(ticks, windowSize = MEAN_REVERSION_CONFIG.VOLATILITY_WINDOW) {
  const w = (ticks || []).slice(-windowSize);
  if (w.length < MEAN_REVERSION_CONFIG.VOLATILITY_MIN_STREAK) return false;
  const min = MEAN_REVERSION_CONFIG.VOLATILITY_MIN_STREAK;
  return (
    maxConsecutiveRun(w, d => d % 2 === 0) >= min
    || maxConsecutiveRun(w, d => d % 2 !== 0) >= min
    || maxConsecutiveRun(w, d => d > 5) >= min
    || maxConsecutiveRun(w, d => d < 5) >= min
  );
}

export function isAssetBlacklisted(symbol, now = Date.now()) {
  const until = assetBlacklist[symbol];
  if (!until) return false;
  if (now >= until) {
    delete assetBlacklist[symbol];
    return false;
  }
  return true;
}

export function blacklistAsset(symbol, now = Date.now()) {
  if (!symbol) return;
  assetBlacklist[symbol] = now + MEAN_REVERSION_CONFIG.BLACKLIST_MS;
}

export function getBlacklistedCount(now = Date.now()) {
  let n = 0;
  for (const sym of Object.keys(assetBlacklist)) {
    if (isAssetBlacklisted(sym, now)) n += 1;
  }
  return n;
}

export function ingestMeanReversionTick(symbol, ticks) {
  if (!ticks || ticks.length < 6) return;
  const ledger = ensureLedger(symbol);
  const len = ticks.length;
  const t0 = ticks[len - 1];
  const t1 = ticks[len - 2];
  const t2 = ticks[len - 3];
  const t3 = ticks[len - 4];
  const t4 = ticks[len - 5];

  if (t1 % 2 === 0 && t2 % 2 === 0 && t3 % 2 === 0 && t4 % 2 === 0) {
    ledger.DIGITODD.push(t0 % 2 !== 0);
  }
  if (t1 % 2 !== 0 && t2 % 2 !== 0 && t3 % 2 !== 0 && t4 % 2 !== 0) {
    ledger.DIGITEVEN.push(t0 % 2 === 0);
  }
  if (t1 > 4 && t2 > 4 && t3 > 4 && t4 > 4) {
    ledger.DIGITUNDER.push(t0 < 5);
  }
  if (t1 < 5 && t2 < 5 && t3 < 5 && t4 < 5 && t1 !== 0 && t2 !== 1) {
    ledger.DIGITOVER.push(t0 > 5);
  }

  trimLedger(ledger);
}

export function getVirtualWinRate(symbol, contractType) {
  const ledger = marketVirtualLedgers[symbol];
  if (!ledger) return 0;
  const history = ledger[contractType] || [];
  if (history.length < MEAN_REVERSION_CONFIG.LEDGER_MIN_SAMPLES) return 0;
  return Math.round((history.filter(Boolean).length / history.length) * 100);
}

/**
 * Walk recent ticks: after each 4-tick exhaustion, did the next tick mean-revert?
 * (Matches ledger logic — NOT raw even%, which stays ~50% on RNG and blocked everything.)
 */
export function computeMicroReversionWinRate(ticks, contractType) {
  const w = (ticks || []).slice(-50);
  if (w.length < 6) return 0;

  let trials = 0;
  let wins = 0;

  for (let end = 5; end < w.length; end++) {
    const t0 = w[end];
    const t1 = w[end - 1];
    const t2 = w[end - 2];
    const t3 = w[end - 3];
    const t4 = w[end - 4];

    if (contractType === 'DIGITODD') {
      if (t1 % 2 === 0 && t2 % 2 === 0 && t3 % 2 === 0 && t4 % 2 === 0) {
        trials += 1;
        if (t0 % 2 !== 0) wins += 1;
      }
    } else if (contractType === 'DIGITEVEN') {
      if (t1 % 2 !== 0 && t2 % 2 !== 0 && t3 % 2 !== 0 && t4 % 2 !== 0) {
        trials += 1;
        if (t0 % 2 === 0) wins += 1;
      }
    } else if (contractType === 'DIGITUNDER') {
      if (t1 > 4 && t2 > 4 && t3 > 4 && t4 > 4) {
        trials += 1;
        if (t0 < 5) wins += 1;
      }
    } else if (contractType === 'DIGITOVER') {
      if (t1 < 5 && t2 < 5 && t3 < 5 && t4 < 5 && t1 !== 0 && t2 !== 1) {
        trials += 1;
        if (t0 > 5) wins += 1;
      }
    }
  }

  if (trials < 2) {
    if (passesFourTickExhaustionGate(ticks, contractType)
      || passesFiveTickExhaustionGate(ticks, contractType)) {
      return 62;
    }
    return 0;
  }
  return Math.round((wins / trials) * 100);
}

/** Immediate WR from recent ticks (direction win % — diagnostic only). */
export function computeLiveVirtualWinRate(ticks, contractType) {
  const dir = contractToDir(contractType);
  if (!dir || !ticks?.length) return 0;
  const w = ticks.slice(-25);
  if (w.length < MEAN_REVERSION_CONFIG.LIVE_WR_MIN_TICKS) return 0;
  let wins = 0;
  for (const d of w) {
    const n = Number(d);
    if (!Number.isNaN(n) && !isVirtualLossTick(n, dir)) wins += 1;
  }
  return Math.round((wins / w.length) * 100);
}

/** Ledger WR when mature; else micro reversion WR from tick buffer. */
export function getEffectiveWinRate(symbol, contractType, ticks) {
  const ledger = getVirtualWinRate(symbol, contractType);
  const micro = computeMicroReversionWinRate(ticks, contractType);
  return Math.max(ledger, micro);
}

export function contractTypeLabel(type) {
  if (type === 'DIGITEVEN') return 'E';
  if (type === 'DIGITODD') return 'O';
  if (type === 'DIGITOVER') return 'H';
  if (type === 'DIGITUNDER') return 'L';
  return '?';
}

export function contractToDir(contractType) {
  if (contractType === 'DIGITOVER') return 'OVER5';
  if (contractType === 'DIGITUNDER') return 'UNDER5';
  if (contractType === 'DIGITEVEN') return 'EVEN';
  if (contractType === 'DIGITODD') return 'ODD';
  return null;
}

export function dirToContractType(dir) {
  if (dir === 'OVER5') return 'DIGITOVER';
  if (dir === 'UNDER5') return 'DIGITUNDER';
  if (dir === 'EVEN') return 'DIGITEVEN';
  if (dir === 'ODD') return 'DIGITODD';
  return null;
}

export function passesFiveTickRecoveryGate(ticks, contractType) {
  return passesFiveTickExhaustionGate(ticks, contractType);
}

/** 4-tick mean-reversion trigger (more frequent than 5-tick). */
export function passesFourTickExhaustionGate(ticks, contractType) {
  if (!ticks?.length || ticks.length < 4 || !contractType) return false;
  const len = ticks.length;
  const t0 = ticks[len - 1];
  const t1 = ticks[len - 2];
  const t2 = ticks[len - 3];
  const t3 = ticks[len - 4];

  if (contractType === 'DIGITODD') {
    return t0 % 2 === 0 && t1 % 2 === 0 && t2 % 2 === 0 && t3 % 2 === 0;
  }
  if (contractType === 'DIGITEVEN') {
    return t0 % 2 !== 0 && t1 % 2 !== 0 && t2 % 2 !== 0 && t3 % 2 !== 0;
  }
  if (contractType === 'DIGITUNDER') {
    return t0 > 4 && t1 > 4 && t2 > 4 && t3 > 4;
  }
  if (contractType === 'DIGITOVER') {
    return t0 < 5 && t1 < 5 && t2 < 5 && t3 < 5 && t0 !== 0 && t1 !== 1;
  }
  return false;
}

export function passesFiveTickExhaustionGate(ticks, contractType) {
  if (!ticks?.length || ticks.length < 5 || !contractType) return false;
  const len = ticks.length;
  const t0 = ticks[len - 1];
  const t1 = ticks[len - 2];
  const t2 = ticks[len - 3];
  const t3 = ticks[len - 4];
  const t4 = ticks[len - 5];

  if (contractType === 'DIGITODD') {
    return t0 % 2 === 0 && t1 % 2 === 0 && t2 % 2 === 0 && t3 % 2 === 0 && t4 % 2 === 0;
  }
  if (contractType === 'DIGITEVEN') {
    return t0 % 2 !== 0 && t1 % 2 !== 0 && t2 % 2 !== 0 && t3 % 2 !== 0 && t4 % 2 !== 0;
  }
  if (contractType === 'DIGITUNDER') {
    return t0 > 4 && t1 > 4 && t2 > 4 && t3 > 4 && t4 > 4;
  }
  if (contractType === 'DIGITOVER') {
    return t0 < 5 && t1 < 5 && t2 < 5 && t3 < 5 && t4 < 5 && t0 !== 0 && t1 !== 1;
  }
  return false;
}

function strategyAllowsVector(strategy, contractType) {
  const mode = (strategy || 'BOTH5').toUpperCase();
  const isEO = contractType === 'DIGITEVEN' || contractType === 'DIGITODD';
  const isOU = contractType === 'DIGITOVER' || contractType === 'DIGITUNDER';
  if (mode === 'BOTH') return isEO;
  if (mode === 'BOTH5') return isOU;
  if (mode === 'EO_WINNING') return isEO;
  if (mode === 'OU_WINNING') return isOU;
  return isEO || isOU;
}

function vectorKey(symbol, contractType) {
  return `${symbol}:${contractType}`;
}

export function buildMeanReversionLeaderboard(marketDataMap, strategy) {
  const rows = [];

  for (const symbol of MARKETS) {
    const ticks = marketDataMap[symbol]?.history || marketDataMap[symbol];
    if (!ticks?.length || ticks.length < 7) continue;
    ingestMeanReversionTick(symbol, ticks);

    for (const contractType of CONTRACT_TYPES) {
      if (!strategyAllowsVector(strategy, contractType)) continue;
      const rate = getEffectiveWinRate(symbol, contractType, ticks);
      rows.push({
        symbol,
        sym: symbol,
        contractType,
        type: contractType,
        rate,
        marketLabel: MARKET_LABELS[symbol] || symbol,
        dir: contractToDir(contractType),
        barrier: contractType === 'DIGITOVER' || contractType === 'DIGITUNDER' ? '5' : undefined,
      });
    }
  }

  rows.sort((a, b) => b.rate - a.rate || a.symbol.localeCompare(b.symbol));
  return rows;
}

export function getTop10(leaderboard) {
  return [...leaderboard]
    .sort((a, b) => b.rate - a.rate)
    .filter(v => v.rate >= MEAN_REVERSION_CONFIG.WIN_RATE_BAR)
    .slice(0, MEAN_REVERSION_CONFIG.TOP_LEADERBOARD_SIZE);
}

/** @deprecated use getTop10 */
export function getTop5(leaderboard) {
  return getTop10(leaderboard).slice(0, 5);
}

export function isTop10Vector(symbol, contractType, leaderboard) {
  const top10 = getTop10(leaderboard);
  return top10.some(v => v.symbol === symbol && v.contractType === contractType);
}

/**
 * Sniper score: WR bar (58%+) then exhaustion (6), volatility (+2), top10 (+2). Fire if total >= 6.
 */
export function evaluateSniperScore(symbol, contractType, ticks, currentWinRate, leaderboard) {
  const cfg = MEAN_REVERSION_CONFIG;
  const rate = currentWinRate ?? getEffectiveWinRate(symbol, contractType, ticks);
  if (rate < cfg.WIN_RATE_BAR) {
    return { score: 0, breakdown: {}, qualifies: false, rate };
  }

  let score = 0;
  const breakdown = {};

  if (passesFiveTickExhaustionGate(ticks, contractType)) {
    score += cfg.SCORE_EXHAUSTION_5;
    breakdown.exhaustion5 = cfg.SCORE_EXHAUSTION_5;
  } else if (passesFourTickExhaustionGate(ticks, contractType)) {
    score += cfg.SCORE_EXHAUSTION_4;
    breakdown.exhaustion4 = cfg.SCORE_EXHAUSTION_4;
  }
  if (isHighVolatility(ticks, cfg.VOLATILITY_WINDOW)) {
    score += cfg.SCORE_VOLATILITY;
    breakdown.volatility = cfg.SCORE_VOLATILITY;
  }
  if (isTop10Vector(symbol, contractType, leaderboard)) {
    score += cfg.SCORE_TOP10;
    breakdown.top10 = cfg.SCORE_TOP10;
  }

  return {
    score,
    breakdown,
    qualifies: score >= cfg.SCORE_THRESHOLD,
    rate,
  };
}

/**
 * Build sniper pool — score >= 6 and WR >= 58%. Cross-asset pivot on recovery.
 */
export function buildSniperPool(marketDataMap, strategy, leaderboard, now = Date.now()) {
  const top10 = getTop10(leaderboard);
  const readyPool = [];
  const inRecovery = globalMatrixState.currentMartingaleLevel > 0;
  const pivotAway = globalMatrixState.lastLossSymbol;
  let bestSniperScore = 0;

  for (const symbol of MARKETS) {
    if (isAssetBlacklisted(symbol, now)) continue;
    if (inRecovery && symbol === pivotAway) continue;

    const ticks = marketDataMap[symbol]?.history;
    if (!ticks?.length || ticks.length < 5) continue;

    for (const contractType of CONTRACT_TYPES) {
      if (!strategyAllowsVector(strategy, contractType)) continue;

      const rate = getEffectiveWinRate(symbol, contractType, ticks);
      const sniper = evaluateSniperScore(symbol, contractType, ticks, rate, leaderboard);
      if (!sniper.qualifies) continue;

      bestSniperScore = Math.max(bestSniperScore, sniper.score);
      readyPool.push({
        symbol,
        sym: symbol,
        contract_type: contractType,
        contractType,
        dir: contractToDir(contractType),
        barrier: contractType === 'DIGITOVER' || contractType === 'DIGITUNDER' ? '5' : undefined,
        rate,
        sniperScore: sniper.score,
        scoreBreakdown: sniper.breakdown,
        pivotRecovery: inRecovery,
      });
    }
  }

  readyPool.sort((a, b) => b.sniperScore - a.sniperScore || b.rate - a.rate);
  return {
    readyPool,
    top10,
    inRecovery,
    bestSniperScore,
    vectorsScanned: CONTRACT_TYPES.length * MARKETS.length,
  };
}

/** @deprecated alias — triple-gate replaced by sniper scoring */
export function buildTripleGateReadyPool(marketDataMap, strategy, leaderboard, now) {
  return buildSniperPool(marketDataMap, strategy, leaderboard, now);
}

export function pickCherryFromLeaderboard(readyPool, { preferTop = false } = {}) {
  if (!readyPool?.length) return null;
  const pick = preferTop
    ? readyPool[0]
    : readyPool[Math.floor(Math.random() * readyPool.length)];
  return {
    entry: pick,
    rank: readyPool.indexOf(pick) + 1,
    poolSize: readyPool.length,
    recovery: !!pick.pivotRecovery,
  };
}

export function getGlobalMartingaleStake(baseStake, opts = {}) {
  const base = Math.max(0.35, Number(baseStake) || 0.35);
  const mult = Number(opts.martMultiplier) || 2;
  const holdAfter = Math.max(0, Math.floor(Number(opts.martingaleHoldAfterStep) || 0));
  let level = Math.max(0, globalMatrixState.currentMartingaleLevel || 0);
  if (holdAfter > 0) level = Math.min(holdAfter, level);

  let stake = base * Math.pow(mult, level);
  const ceiling = Number(opts.stakeSafetyCeiling);
  if (Number.isFinite(ceiling) && ceiling > 0) stake = Math.min(stake, ceiling);
  const cap = opts.maxStakeCap;
  if (cap != null && Number(cap) > 0) stake = Math.min(stake, Number(cap));
  return Math.max(0.35, parseFloat(stake.toFixed(2)));
}

/** Win resets martingale step; loss increments (optional hold freezes step). */
export function registerMatrix20Outcome(isWin, symbol, opts = {}) {
  if (isWin) {
    globalMatrixState.currentMartingaleLevel = 0;
    globalMatrixState.globalConsecutiveLosses = 0;
    globalMatrixState.lastLossSymbol = null;
    globalMatrixState.circuitBreakerTripped = false;
    return { reset: true, circuitBreaker: false, martingaleReset: true };
  }

  if (symbol) blacklistAsset(symbol);
  globalMatrixState.lastLossSymbol = symbol || globalMatrixState.lastLossSymbol;
  globalMatrixState.globalConsecutiveLosses += 1;

  const holdAfter = Math.max(0, Math.floor(Number(opts.martingaleHoldAfterStep) || 0));
  const explicit = Number(opts.martingaleStep);
  if (Number.isFinite(explicit)) {
    globalMatrixState.currentMartingaleLevel = Math.max(0, explicit);
    if (holdAfter > 0) {
      globalMatrixState.currentMartingaleLevel = Math.min(holdAfter, globalMatrixState.currentMartingaleLevel);
    }
  } else if (holdAfter > 0) {
    if (globalMatrixState.currentMartingaleLevel < holdAfter) {
      globalMatrixState.currentMartingaleLevel += 1;
    }
  } else {
    globalMatrixState.currentMartingaleLevel += 1;
  }

  return {
    reset: false,
    circuitBreaker: false,
    martingaleReset: false,
    blacklisted: symbol,
  };
}

export function usesMatrix20Engine(strategy) {
  const mode = (strategy || '').toUpperCase();
  return mode === 'BOTH' || mode === 'BOTH5';
}

export function updateStrategyFocusDisplay(strategy, leaderboard, poolResult, candidate, now = Date.now()) {
  const mode = (strategy || 'BOTH5').toUpperCase();
  globalStrategyFocus.currentMode = mode;
  globalStrategyFocus.readyPoolSize = poolResult?.readyPool?.length ?? 0;
  globalStrategyFocus.activeRecoveries = poolResult?.inRecovery ? 1 : 0;
  globalStrategyFocus.blacklistedCount = getBlacklistedCount(now);
  globalStrategyFocus.martingaleLevel = globalMatrixState.currentMartingaleLevel;
  globalStrategyFocus.globalLossStreak = globalMatrixState.globalConsecutiveLosses;
  globalStrategyFocus.bestSniperScore = poolResult?.bestSniperScore ?? 0;
  globalStrategyFocus.topVectors = (poolResult?.top10 || getTop10(leaderboard)).slice(0, 5);
  globalStrategyFocus.leaderboardDisplay = globalStrategyFocus.topVectors.map(
    m => `${m.marketLabel || MARKET_LABELS[m.symbol]}[${contractTypeLabel(m.contractType)}]: ${m.rate}%`
  );

  if (candidate) {
    const label = MARKET_LABELS[candidate.symbol] || candidate.symbol;
    const sc = candidate.sniperScore ?? '?';
    const tag = candidate.pivotRecovery ? 'SNIPER PIVOT' : 'SNIPER STRIKE';
    globalStrategyFocus.activeTargetMarket =
      `${tag}: ${label} ${candidate.contractType} · score ${sc} · WR ${candidate.rate}%`;
  } else if (poolResult?.inRecovery) {
    globalStrategyFocus.activeTargetMarket =
      `SNIPER HUNT · L${globalMatrixState.currentMartingaleLevel} · ${globalStrategyFocus.readyPoolSize} in pool`;
  } else if (globalStrategyFocus.readyPoolSize > 0) {
    globalStrategyFocus.activeTargetMarket =
      `SNIPER POOL ${globalStrategyFocus.readyPoolSize} · best score ${globalStrategyFocus.bestSniperScore}`;
  } else {
    globalStrategyFocus.activeTargetMarket = 'HUNTING 60 VECTORS · need score ≥6 & WR ≥58%';
  }
}

export function resetMeanReversionLedgers() {
  for (const sym of MARKETS) {
    marketVirtualLedgers[sym] = emptyLedger();
  }
  for (const key of Object.keys(assetBlacklist)) delete assetBlacklist[key];
  globalMatrixState.currentMartingaleLevel = 0;
  globalMatrixState.globalConsecutiveLosses = 0;
  globalMatrixState.lastLossSymbol = null;
  globalMatrixState.circuitBreakerTripped = false;
  globalStrategyFocus.activeTargetMarket = 'INITIALIZING SNIPER MATRIX...';
  globalStrategyFocus.readyPoolSize = 0;
  globalStrategyFocus.activeRecoveries = 0;
  globalStrategyFocus.blacklistedCount = 0;
  globalStrategyFocus.martingaleLevel = 0;
  globalStrategyFocus.globalLossStreak = 0;
  globalStrategyFocus.bestSniperScore = 0;
  globalStrategyFocus.currentMode = 'INITIALIZING...';
  globalStrategyFocus.leaderboardDisplay = [];
  globalStrategyFocus.topVectors = [];
}

export function getMeanReversionLedgerSnapshot() {
  return { ...marketVirtualLedgers };
}

export function runApexMatrix20Sweep(marketDataMap, strategy, config = {}) {
  const now = config.now ?? Date.now();
  const leaderboard = buildMeanReversionLeaderboard(marketDataMap, strategy);
  const poolResult = buildSniperPool(marketDataMap, strategy, leaderboard, now);
  let cherry = pickCherryFromLeaderboard(poolResult.readyPool, {
    preferTop: poolResult.inRecovery,
  });

  // Recovery: if sniper pool is empty, pivot to best leaderboard WR (skip blacklisted / loss market).
  if (!cherry?.entry && poolResult.inRecovery && leaderboard.length) {
    const pivotAway = globalMatrixState.lastLossSymbol;
    const candidates = getTop10(leaderboard).length ? getTop10(leaderboard) : leaderboard.slice(0, 8);
    for (const row of candidates) {
      const sym = row.symbol || row.sym;
      if (!sym || isAssetBlacklisted(sym, now)) continue;
      if (sym === pivotAway) continue;
      const stream = marketDataMap[sym];
      if (!stream?.history?.length) continue;
      cherry = {
        entry: {
          symbol: sym,
          sym,
          contractType: row.contractType,
          dir: row.dir,
          barrier: row.barrier,
          rate: row.rate,
          sniperScore: row.rate,
          pivotRecovery: true,
        },
        rank: 1,
        poolSize: 1,
        recovery: true,
      };
      break;
    }
  }

  updateStrategyFocusDisplay(strategy, leaderboard, poolResult, cherry?.entry, now);

  if (!cherry?.entry) {
    return {
      action: 'none',
      reason: poolResult.readyPool.length ? 'lag' : 'sniper_hunting',
      topScore: leaderboard[0]?.rate || 0,
      readyPool: poolResult.readyPool.length,
      bestSniperScore: poolResult.bestSniperScore,
      top10: poolResult.top10,
    };
  }

  const entry = cherry.entry;
  const sym = entry.symbol || entry.sym;
  const stream = marketDataMap[sym];
  const lastTs = stream?.lastTickTimestamp > 0 ? stream.lastTickTimestamp : now;
  if (!stream?.history?.length || now - lastTs > MEAN_REVERSION_CONFIG.STREAM_LAG_MS) {
    return { action: 'none', reason: 'commit_stream_lag', sym, lag: now - lastTs };
  }

  const stake = getGlobalMartingaleStake(config.baseStake, {
    martMultiplier: config.martMultiplier ?? 2,
    stakeSafetyCeiling: config.stakeSafetyCeiling,
    maxStakeCap: config.maxStakeCap,
    maxMartingaleStep: config.maxMartingaleStep,
    martingaleHoldAfterStep: config.martingaleHoldAfterStep ?? 0,
    martingaleStep: globalMatrixState.currentMartingaleLevel,
  });
  if (!stake) return { action: 'none', reason: 'stake_cap', sym };

  return {
    action: poolResult.inRecovery ? 'recovery' : 'matrix',
    sym,
    symbol: sym,
    dir: entry.dir,
    contractType: entry.contractType,
    barrier: entry.barrier,
    amount: stake,
    score: entry.sniperScore,
    sniperScore: entry.sniperScore,
    stealthRank: cherry.rank,
    stealthPool: cherry.poolSize,
    matrix20: true,
    sniper: true,
    pivotRecovery: poolResult.inRecovery,
    virtualWinRate: entry.rate,
    scoreBreakdown: entry.scoreBreakdown,
  };
}
