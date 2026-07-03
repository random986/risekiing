import { create } from 'zustand';

const ALL_MARKETS = [
  'frxEURUSD', 'frxGBPUSD', 'frxAUDJPY', 'frxUSDJPY', 'frxUSDCHF',
  'frxXAUUSD', 'frxXAGUSD', 'OTC_DJI', 'OTC_NDX100', 'OTC_FTSE'
];

const MARKET_LABELS = {
  frxEURUSD: 'EUR/USD', frxGBPUSD: 'GBP/USD', frxAUDJPY: 'AUD/JPY',
  frxUSDJPY: 'USD/JPY', frxUSDCHF: 'USD/CHF', frxXAUUSD: 'Gold',
  frxXAGUSD: 'Silver', OTC_DJI: 'US 30', OTC_NDX100: 'US 100', OTC_FTSE: 'UK 100'
};

const mkMarket = (sym) => ({
  symbol: sym, name: MARKET_LABELS[sym] || sym,
  bid: 0, ask: 0, spread: 0, er: 0, svc: 0,
  routing: 'INITIALIZING', statusBadge: 'LOADING', sessionQuality: 'LOW',
  alpha: 0, alphaMu: 0, alphaSigma: 0, tii: 0, bbProx: 0,
  signal: 'INITIALIZING', confidence: 0,
  t50: 5, vixScaled: 0.5, kMax: 0, tickCount: 0,
  isClosed: false, lastTickTime: 0,
  mcs: { trend: 0, volume: 0, spread: 0, total: 0 },
  lastPrice: 0, ema9: 0,
});

export const useRealMarketStore = create((set, get) => ({
  markets: ALL_MARKETS.reduce((a, s) => { a[s] = mkMarket(s); return a; }, {}),

  // Controls
  selectedMarket: ALL_MARKETS[0],
  autoSelect: false,
  contractType: 'AUTO',   // RISE_FALL | ACCUMULATOR | AUTO
  expiry: 'AUTO',          // 1m | 2m | 5m | AUTO
  mcsFilter: 0.40,        // 0.40 | 0.60 | 0.80
  sessionFilter: 'ALL',   // ALL | PRIME | ACTIVE
  baseStake: 5.00,
  autoTrade: false,
  tiiThreshold: 0.75,
  bbProxThreshold: 0.0005,
  maxConcurrentTrades: 2,

  // Engine
  engineStatus: 'IDLE',    // IDLE | INITIALIZING | SCANNING | SIGNAL_FOUND | BLOCKED | TRADING | PAUSED
  engineAnalysis: '',
  /** Live analyzed entries across all markets — updates every tick */
  tradeOpportunities: [],
  /** Queued for execution when bot is live */
  executionQueue: [],
  /** Active open contracts (up to maxConcurrentTrades) */
  openTrades: [],
  currentTrade: null,      // latest / primary open trade for legacy UI

  // Virtual Win Tracking
  virtualRise: { wins: 0, total: 0 },
  virtualFall: { wins: 0, total: 0 },

  // Tick Feed
  tickFeed: [],            // [{ time, text, color }]

  // Stats
  accountBalance: 0,
  sessionStartBalance: 0,
  dailyPnL: 0,
  sessionWins: 0,
  sessionLosses: 0,
  killSwitchActive: false,
  consecutiveLosses: 0,
  pauseUntil: 0,
  dailyLossStop: 0,
  dailyProfitTarget: 0,

  // News
  newsEvents: [],
  newsBlocked: [],         // symbols currently in news window

  // Trade History
  tradeHistory: [],        // [{ time, market, type, duration, stake, won, pnl }]

  // Actions
  setSelectedMarket: (sym) => set({ selectedMarket: sym, autoSelect: false }),
  setContractType: (t) => set({ contractType: t }),
  setExpiry: (e) => set({ expiry: e }),
  setBaseStake: (s) => set({ baseStake: s }),
  setMcsFilter: (f) => set({ mcsFilter: f }),
  setSessionFilter: (f) => set({ sessionFilter: f }),
  setAutoTrade: (v) => set({ autoTrade: v }),
  setEngineStatus: (s) => set({ engineStatus: s }),
  setEngineAnalysis: (a) => set({ engineAnalysis: a }),
  setTradeOpportunities: (ops) => set({ tradeOpportunities: ops }),
  setExecutionQueue: (q) => set({ executionQueue: q }),
  setOpenTrades: (t) => set({ openTrades: t, currentTrade: t[0] || null }),
  setCurrentTrade: (t) => set({ currentTrade: t }),
  toggleKillSwitch: () => set(s => ({ killSwitchActive: !s.killSwitchActive })),
  setKillSwitchActive: (v) => set({ killSwitchActive: v }),

  setMarketData: (sym, data) => set(s => ({
    markets: { ...s.markets, [sym]: { ...s.markets[sym], ...data } }
  })),

  addVirtualWin: (direction) => set(s => {
    if (direction === 'RISE') return { virtualRise: { wins: s.virtualRise.wins + 1, total: s.virtualRise.total + 1 } };
    return { virtualFall: { wins: s.virtualFall.wins + 1, total: s.virtualFall.total + 1 } };
  }),
  addVirtualLoss: (direction) => set(s => {
    if (direction === 'RISE') return { virtualRise: { ...s.virtualRise, total: s.virtualRise.total + 1 } };
    return { virtualFall: { ...s.virtualFall, total: s.virtualFall.total + 1 } };
  }),

  pushTickFeed: (text, color = 'var(--text-muted)') => set(s => ({
    tickFeed: [...s.tickFeed.slice(-7), { time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), text, color }]
  })),

  setNewsEvents: (events) => set({ newsEvents: events }),
  setNewsBlocked: (syms) => set({ newsBlocked: syms }),
  updateBalance: (bal) => set(s => {
    // Set start balance on first balance update if it's 0
    const startBal = s.sessionStartBalance === 0 ? bal : s.sessionStartBalance;
    return { accountBalance: bal, sessionStartBalance: startBal };
  }),

  recordTradeResult: (trade) => set(s => {
    // Reset streak helper call
    if (trade.type === 'RESET') {
      return { consecutiveLosses: 0, pauseUntil: 0 };
    }

    const won = trade.won;
    const pnl = trade.pnl;
    const losses = won ? 0 : s.consecutiveLosses + 1;
    const newPnL = s.dailyPnL + pnl;
    
    const startBal = s.sessionStartBalance || s.accountBalance || 100;
    
    // Drawdown limit (5%)
    const drawdownLimitReached = startBal > 0 && newPnL <= -(startBal * 0.05);
    
    // No long time-based pause here.
    // Loss cooldown is handled by the engine as strict tick-based cooldown.
    let pauseTime = 0;
    
    const kill = s.killSwitchActive || drawdownLimitReached;
    
    return {
      tradeHistory: [trade, ...s.tradeHistory].slice(0, 100),
      dailyPnL: newPnL,
      sessionWins: s.sessionWins + (won ? 1 : 0),
      sessionLosses: s.sessionLosses + (won ? 0 : 1),
      consecutiveLosses: losses,
      sessionStartBalance: startBal,
      pauseUntil: pauseTime,
      killSwitchActive: kill,
      currentTrade: null,
      openTrades: [],
      engineStatus: kill ? 'PAUSED' : 'SCANNING',
    };
  }),

  resetSession: () => set(s => ({
    dailyPnL: 0, sessionWins: 0, sessionLosses: 0, consecutiveLosses: 0,
    tradeHistory: [], killSwitchActive: false, pauseUntil: 0,
    sessionStartBalance: s.accountBalance,
    virtualRise: { wins: 0, total: 0 }, virtualFall: { wins: 0, total: 0 },
  })),
}));

export { ALL_MARKETS, MARKET_LABELS };
