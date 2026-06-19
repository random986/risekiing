/**
 * Network phase / stream freshness — reject stale ticks before orders fire.
 */

import { isApexOrderInFlight } from './apexFlightLock.js';

export const STREAM_LAG_COMMIT_MS = 700;
export const STREAM_LAG_RECOVERY_MS = 800;
export const NETWORK_THROTTLE_MS = 950;

export const engineState = {
  isLocked: false,
  recoveryMode: false,
  failedAsset: null,
  martingaleLevel: 0,
  lastNetworkEpoch: 0,
};

let recoveryReader = () => ({
  wasLoss: false,
  failedMarket: null,
  currentStep: 0,
});

export function setRecoveryStateReader(reader) {
  recoveryReader = reader;
}

export function syncEngineState() {
  const r = recoveryReader();
  engineState.isLocked = isApexOrderInFlight();
  engineState.recoveryMode = !!(r.wasLoss && r.failedMarket);
  engineState.failedAsset = r.failedMarket;
  engineState.martingaleLevel = r.currentStep || 0;
}

export function buildMarketDataMap(scanner, buffers) {
  const map = {};
  const lastAt = scanner?.lastTickAt || {};
  for (const sym of Object.keys(buffers || {})) {
    map[sym] = {
      history: buffers[sym] || [],
      lastTickTimestamp: lastAt[sym] || 0,
    };
  }
  return map;
}

export function getStreamLagMs(symbol, scanner, now = Date.now()) {
  const ts = scanner?.lastTickAt?.[symbol];
  if (!ts) return 0;
  return now - ts;
}

export function isStreamFresh(symbol, scanner, maxLagMs = STREAM_LAG_COMMIT_MS, now = Date.now()) {
  if (!scanner?.lastTickAt?.[symbol]) return true;
  return getStreamLagMs(symbol, scanner, now) <= maxLagMs;
}

export function canDispatchNetworkPhase(now = Date.now()) {
  syncEngineState();
  if (engineState.isLocked) return false;
  if (now - engineState.lastNetworkEpoch < NETWORK_THROTTLE_MS) return false;
  return true;
}

export function markNetworkDispatch(now = Date.now()) {
  engineState.lastNetworkEpoch = now;
  engineState.isLocked = true;
}

/** Clear network throttle so the next cycle can dispatch immediately after settlement. */
export function resetNetworkThrottle() {
  engineState.lastNetworkEpoch = 0;
  engineState.isLocked = false;
}

export function abortReasonForSymbol(symbol, scanner, recovery = false, now = Date.now()) {
  const maxLag = recovery ? STREAM_LAG_RECOVERY_MS : STREAM_LAG_COMMIT_MS;
  const lag = getStreamLagMs(symbol, scanner, now);
  if (scanner?.lastTickAt?.[symbol] && lag > maxLag) {
    return `stream_lag_${lag}ms`;
  }
  return null;
}
