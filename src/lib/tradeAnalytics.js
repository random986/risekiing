/**
 * Trade analytics — rolling win rate, breakdowns, entry metadata for logging.
 */
import { usesMatrix20Engine, globalMatrixState } from './apexMeanReversionLeaderboard.js';

export const BINARY_BREAKEVEN_WR = 52.6;

export function rollingWinRate(trades, window = 50) {
  const settled = (trades || []).filter(t => !t.pending);
  if (settled.length < 1) return null;
  const slice = settled.slice(-window);
  if (!slice.length) return null;
  return (slice.filter(t => t.won).length / slice.length) * 100;
}

export function computeExpectancy(trades) {
  const settled = (trades || []).filter(t => !t.pending);
  if (!settled.length) return { expectancy: 0, avgWin: 0, avgLoss: 0, winRate: 0 };
  const wins = settled.filter(t => t.won);
  const losses = settled.filter(t => !t.won);
  const winRate = wins.length / settled.length;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.profit, 0) / wins.length : 0;
  const avgLoss = losses.length
    ? losses.reduce((s, t) => s + Math.abs(t.profit), 0) / losses.length
    : 0;
  return {
    expectancy: winRate * avgWin - (1 - winRate) * avgLoss,
    avgWin,
    avgLoss,
    winRate: winRate * 100,
  };
}

function bucketKey(trade, field) {
  if (field === 'direction') return trade.direction || 'unknown';
  if (field === 'market') return trade.market || 'unknown';
  return 'all';
}

function summarizeBucket(rows) {
  const settled = rows.filter(t => !t.pending);
  const n = settled.length;
  if (!n) return { trades: 0, wins: 0, losses: 0, winRate: 0, pnl: 0 };
  const wins = settled.filter(t => t.won).length;
  const pnl = settled.reduce((s, t) => s + (t.profit || 0), 0);
  return {
    trades: n,
    wins,
    losses: n - wins,
    winRate: (wins / n) * 100,
    pnl,
  };
}

export function computePerformanceBreakdown(trades) {
  const settled = (trades || []).filter(t => !t.pending);
  const byDirection = {};
  const byMarket = {};

  for (const t of settled) {
    const d = bucketKey(t, 'direction');
    const m = bucketKey(t, 'market');
    if (!byDirection[d]) byDirection[d] = [];
    if (!byMarket[m]) byMarket[m] = [];
    byDirection[d].push(t);
    byMarket[m].push(t);
  }

  const directionRows = Object.entries(byDirection)
    .map(([key, rows]) => ({ key, ...summarizeBucket(rows) }))
    .sort((a, b) => b.trades - a.trades);

  const marketRows = Object.entries(byMarket)
    .map(([key, rows]) => ({ key, ...summarizeBucket(rows) }))
    .sort((a, b) => b.trades - a.trades);

  return {
    overall: summarizeBucket(settled),
    byDirection: directionRows,
    byMarket: marketRows,
    rolling10: rollingWinRate(settled, 10),
    rolling50: rollingWinRate(settled, 50),
    expectancy: computeExpectancy(settled),
    belowBreakeven: summarizeBucket(settled).winRate > 0
      && summarizeBucket(settled).winRate < BINARY_BREAKEVEN_WR,
  };
}

export function buildEntryMetadata(engine, market, direction, extra = {}) {
  const entry = engine?._lastTournamentEntry || {};
  const matrix = usesMatrix20Engine(engine?.strategy);
  const martLevel = matrix
    ? globalMatrixState.currentMartingaleLevel
    : (engine?._sessionMartingaleStep ?? 0);

  const settled = (engine?.sessionTrades || []).filter(t => !t.pending);

  return {
    strategy: engine?.strategy || extra.strategy,
    market: market || entry.sym,
    direction: direction || entry.dir,
    entryAlgorithm: extra.algorithm || entry.algorithm || engine?._activeEntryAlgorithm,
    score: extra.score ?? entry.score ?? entry.sniperScore,
    sniperScore: extra.sniperScore ?? entry.sniperScore,
    virtualWinRate: extra.virtualWinRate ?? entry.rate,
    streak: entry.streak ?? extra.streak ?? 0,
    martingaleLevel: extra.martingaleLevel ?? martLevel,
    binaryWinPct: entry.binaryWinPct,
    binaryEdge: entry.binaryEdge,
    sessionLossStreak: engine?.sessionConsecutiveLosses ?? 0,
    rollingWinRate10: rollingWinRate(settled, 10),
    rollingWinRate50: rollingWinRate(settled, 50),
    pivotRecovery: extra.pivotRecovery ?? entry.pivotRecovery ?? false,
    at: Date.now(),
    ...extra,
  };
}

export function getConservativeEngineOverrides(config) {
  if (!config?.conservativeMode) return {};
  return {
    maxMartingaleStep: Math.min(Number(config.maxMartingaleStep) || 4, 2),
    maxSteps: Math.min(Number(config.maxSteps) || 4, 2),
    martingaleHoldAfterStep: Math.min(Number(config.martingaleHoldAfterStep) || 0, 2),
    cascadeFreezeAt: Math.min(Number(config.cascadeFreezeAt) || 3, 2),
    cascadePauseAt: Math.min(Number(config.cascadePauseAt) || 4, 3),
    entryGateMinWin: Math.max(Number(config.entryGateMinWin) || 49, 52),
    entryGateTightenPerLoss: Math.max(Number(config.entryGateTightenPerLoss) || 2, 3),
    rollingWinRateKillEnabled: true,
    rollingWinRateFloor: Math.max(Number(config.rollingWinRateFloor) || 48, 50),
    rollingWinRateWindow: Math.min(Number(config.rollingWinRateWindow) || 50, 30),
    rollingWinRateMinTrades: Math.min(Number(config.rollingWinRateMinTrades) || 20, 15),
    sessionDrawdownStopPct: Math.min(Number(config.sessionDrawdownStopPct) || 28, 20),
  };
}
