/**
 * Session safety — drawdown, loss streak, and cascade stops.
 */
import { rollingWinRate } from './tradeAnalytics.js';

export function evaluateRollingWinRateKill(config, trades) {
  if (config?.rollingWinRateKillEnabled === false) return null;
  const floor = Number(config?.rollingWinRateFloor) || 48;
  const window = Number(config?.rollingWinRateWindow) || 50;
  const minTrades = Number(config?.rollingWinRateMinTrades) || 20;
  const settled = (trades || []).filter(t => !t.pending);
  if (settled.length < minTrades) return null;
  const wr = rollingWinRate(settled, window);
  if (wr == null || wr * 100 >= floor) return null;
  return `Rolling win rate ${(wr * 100).toFixed(1)}% below floor ${floor}% (${settled.length} trades)`;
}

export function evaluateDrawdownKill(config, sessionOpeningBalance, balance) {
  const pct = Number(config?.sessionDrawdownStopPct) || 0;
  if (pct <= 0 || !sessionOpeningBalance || sessionOpeningBalance <= 0) return null;
  const lossPct = ((sessionOpeningBalance - balance) / sessionOpeningBalance) * 100;
  if (lossPct < pct) return null;
  return `Session drawdown ${lossPct.toFixed(1)}% (limit ${pct}%) · opening $${sessionOpeningBalance.toFixed(2)} → $${balance.toFixed(2)}`;
}

export function evaluateCascadeStop(config, sessionConsecutiveLosses) {
  const at = Number(config?.cascadeStopAt) || 0;
  if (at <= 0 || sessionConsecutiveLosses < at) return null;
  return `Cascade stop: ${sessionConsecutiveLosses} consecutive losses (limit ${at})`;
}

export function onConsecutiveLoss(config, consecutiveLosses, now = Date.now()) {
  const pauseAt = Number(config?.cascadePauseAt) || 0;
  const freezeAt = Number(config?.cascadeFreezeAt) || 0;
  const pauseMs = Number(config?.lossStreakPauseMs) || Number(config?.cascadePauseMs) || 8000;

  let cascadePausedUntil = 0;
  let freezeMartingale = false;

  if (freezeAt > 0 && consecutiveLosses >= freezeAt) {
    freezeMartingale = true;
  }

  if (pauseAt > 0 && consecutiveLosses >= pauseAt) {
    cascadePausedUntil = now + pauseMs;
  }

  return { cascadePausedUntil, freezeMartingale };
}

export function isCascadePauseActive(pausedUntil, now = Date.now()) {
  return (pausedUntil || 0) > now;
}

export function evaluateSessionSafety(ctx) {
  const {
    config = {},
    sessionTrades = [],
    sessionOpeningBalance = 0,
    balance = 0,
    sessionConsecutiveLosses = 0,
    cascadePausedUntil = 0,
    now = Date.now(),
  } = ctx;

  const wrKill = evaluateRollingWinRateKill(config, sessionTrades);
  if (wrKill) return { shouldStop: true, reason: wrKill, isPaused: false, freezeMartingale: false };

  const ddKill = evaluateDrawdownKill(config, sessionOpeningBalance, balance);
  if (ddKill) return { shouldStop: true, reason: ddKill, isPaused: false, freezeMartingale: false };

  const cascadeKill = evaluateCascadeStop(config, sessionConsecutiveLosses);
  if (cascadeKill) return { shouldStop: true, reason: cascadeKill, isPaused: false, freezeMartingale: false };

  const maxStreak = Number(config?.maxLossStreak) || 0;
  if (config?.maxLossStreakStopEnabled === true && maxStreak > 0 && sessionConsecutiveLosses >= maxStreak) {
    return {
      shouldStop: true,
      reason: `${sessionConsecutiveLosses} consecutive losses (limit ${maxStreak})`,
      isPaused: false,
      freezeMartingale: false,
    };
  }

  return {
    shouldStop: false,
    isPaused: isCascadePauseActive(cascadePausedUntil, now),
    freezeMartingale:
      (Number(config?.cascadeFreezeAt) || 0) > 0
      && sessionConsecutiveLosses >= Number(config.cascadeFreezeAt),
  };
}

export function getRollingWinRateSnapshot(config, trades) {
  const window = Number(config?.rollingWinRateWindow) || 50;
  const settled = (trades || []).filter(t => !t.pending);
  if (settled.length < 3) return null;
  return rollingWinRate(settled, window);
}
