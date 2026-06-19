/* ═══ Config Store (persisted to localStorage) ═══ */
import { create } from 'zustand';
import enhancedTradeEngine from '../lib/enhancedTradeEngine';

const STORAGE_KEY = 'derivprinter_config';

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Number(parsed.freezeMartingaleAfterLosses) > 0) parsed.freezeMartingaleAfterLosses = 0;
      if (Number(parsed.maxMartingaleStepWhenLosing) > 0) parsed.maxMartingaleStepWhenLosing = 0;
      if (parsed.entryGateMinWin == null) parsed.entryGateMinWin = 49;
      if (Number(parsed.minConfidence) === 55 || Number(parsed.minConfidence) === 65) {
        parsed.minConfidence = 60;
      }
      if (Number(parsed.entryConfirmMs) >= 60000) {
        parsed.entryConfirmMs = 0;
        parsed.entryConfirmRandom = true;
        parsed.entryConfirmMinSec = 20;
        parsed.entryConfirmMaxSec = 25;
      }
      if (Number(parsed.entryConfirmMinSec) > 25 || Number(parsed.entryConfirmMinSec) < 10) parsed.entryConfirmMinSec = 20;
      if (Number(parsed.entryConfirmMaxSec) > 30 || Number(parsed.entryConfirmMaxSec) < 20) parsed.entryConfirmMaxSec = 25;
      if (parsed.resetMartingaleOnWin === false && Number(parsed.takeProfit) > 0) {
        parsed.resetMartingaleOnWin = true;
      }
      // Unlimited martingale by default — clear legacy caps that halved stakes (44→22→11…)
      parsed.maxStakeCap = 0;
      parsed.maxStakeMultiplier = 0;
      parsed.maxMartingaleStep = 0;
      parsed.maxSteps = 0;
      if (Number(parsed.martingaleHoldAfterStep) > 0) parsed.martingaleHoldAfterStep = 0;
      return parsed;
    }
  } catch {}
  return null;
}

const defaults = {
  strategy: 'MATCH_DIFF',      // 'MATCH_DIFF' | 'MATCHES' | 'DIFF'
  baseStake: 0.35,
  maxSteps: 0,
  maxMartingaleStep: 0,
  freezeMartingaleAfterLosses: 0,
  maxMartingaleStepWhenLosing: 0,
  recoveryPayoutRate: 0.92,
  martMultiplier: 2.0,
  /** 0 = unlimited martingale steps; N = cap stake at base × mult^N */
  martingaleHoldAfterStep: 0,
  maxStakeCap: 0,
  maxStakeMultiplier: 0,
  maxTradesPerMinute: 0,
  recoveryEnabled: true,
  resetMartingaleOnWin: true,
  antiMartEnabled: false,     // Anti-martingale (increase on WIN, reset on LOSS)
  antiMartMultiplier: 2.0,    // Multiplier for anti-martingale
  stopLoss: 0,
  takeProfit: 0,
  takeProfitType: 'currency', // 'currency' or 'wins'
  timeStopMs: 0,            // 0 = disabled; ms after start to auto-stop

  maxLossStreak: 0,
  maxLossStreakStopEnabled: false,
  lossStreakPauseMs: 12000,
  cascadePauseAt: 0,
  cascadeFreezeAt: 0,
  cascadeStopAt: 0,
  cascadeWarnAt: 0,
  cascadePauseMs: 8000,
  entryGateMinWin: 49,
  entryGateTightenPerLoss: 2,
  entryGateMinConv: 45,
  entryGateMinEdge: 102,
  entryGateMinOppEnd: 4,
  entryGateMinOppStreak: 4,
  cascadeMinNetWin: 0.08,
  sessionDrawdownStopPct: 0,   // 0 = unlimited
  rollingWinRateKillEnabled: false,
  rollingWinRateFloor: 48,
  rollingWinRateWindow: 50,
  rollingWinRateMinTrades: 20,
  persistTradeLog: true,
  conservativeMode: false,
  minStakeOnly: false,
  recoveryLossTarget: 4,     // Legacy — no longer used (classic martingale only)
  cooldownMs: 500,
  entryConfirmEnabled: true,
  entryConfirmRandom: true,
  entryConfirmMinSec: 20,
  entryConfirmMaxSec: 25,
  entryConfirmMs: 0,
  minConfidence: 60,
  theme: 'dark',               // 'light' or 'dark'
  maxTradesPerMarket: 3,       // Rotate before overstaying one index
  maxMsOnMarket: 120000,       // Max 2 min on same market per session
  virtualLossesToWait: 3,      // Base VL bars after first 2 session trades
  requireExhaustionGate: true, // BOTH/BOTH5: 4-tick mean-reversion pattern required to fire
  invertTradeDirection: false, // Always flip OVER↔UNDER and EVEN↔ODD at fire
  adaptiveInvertDirection: true, // Flip when session rolling WR < 44% (after 8+ trades)

};

const useConfigStore = create((set, get) => ({
  ...defaults,
  ...loadConfig(),

  update: (patch) => {
    set(patch);
    if (enhancedTradeEngine.config) {
      enhancedTradeEngine.config = { ...enhancedTradeEngine.config, ...patch };
    }
    try {
      const state = get();
      const toSave = {};
      Object.keys(defaults).forEach(k => { toSave[k] = state[k]; });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    } catch {}
  },

  // Alias so UI components that call config.updateConfig() keep working
  updateConfig: (patch) => {
    const prev = get();
    set(patch);
    if (enhancedTradeEngine.config) {
      enhancedTradeEngine.config = { ...enhancedTradeEngine.config, ...patch };
    }
    if (patch.strategy && patch.strategy !== prev.strategy) {
      enhancedTradeEngine.onStrategySwitch(patch.strategy);
    }
    try {
      const state = get();
      const toSave = {};
      Object.keys(defaults).forEach(k => { toSave[k] = state[k]; });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    } catch {}
  },

  reset: () => {
    set(defaults);
    localStorage.removeItem(STORAGE_KEY);
  },
}));

export default useConfigStore;
