/* ═══ Trade Store ═══ */
import { create } from 'zustand';
import useConfigStore from './useConfigStore';
import { num } from '../lib/format';

const ANALYTICS_LOG_KEY = 'derivprinter_analytics_log';
const ANALYTICS_LOG_CAP = 2000;

function loadPersistedLog() {
  try {
    const raw = localStorage.getItem(ANALYTICS_LOG_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

let currentSessionId = Date.now().toString(36);

function persistTradeRow(trade) {
  if (trade?.pending) return;
  if (useConfigStore.getState().persistTradeLog === false) return;
  try {
    const log = loadPersistedLog();
    log.unshift({ ...trade, persistedAt: Date.now(), sessionId: currentSessionId });
    localStorage.setItem(ANALYTICS_LOG_KEY, JSON.stringify(log.slice(0, ANALYTICS_LOG_CAP)));
  } catch {}
}

const useTradeStore = create((set, get) => ({
  history: [],
  activeTrades: 0,
  botRunning: false,
  botPaused: false,
  botStatus: '',
  stopReason: null,
  sessionStats: { wins: 0, losses: 0, pnl: 0, trades: 0 },
  liveAnalysisBoard: null,

  addOrUpdateTrade: (trade) => set((s) => {
    let stats = { ...s.sessionStats };
    const existingIndex = s.history.findIndex(t => t.id === trade.id);
    let newHistory = [...s.history];
    
    if (existingIndex >= 0) {
      // Update existing trade (settling a pending trade)
      const existing = newHistory[existingIndex];
      newHistory[existingIndex] = { ...existing, ...trade };
      
      // If it transitioned from pending to settled, update stats
      if (existing.pending && !trade.pending) {
        stats.trades += 1;
        stats.pnl += num(trade.profit);
        if (trade.won) stats.wins += 1;
        else stats.losses += 1;
        persistTradeRow(newHistory[existingIndex]);
      }
    } else {
      // Add new trade
      newHistory = [trade, ...newHistory].slice(0, 200);
      // If it's fully settled immediately (rare but possible), update stats
      if (!trade.pending) {
        stats.trades += 1;
        stats.pnl += num(trade.profit);
        if (trade.won) stats.wins += 1;
        else stats.losses += 1;
        persistTradeRow(trade);
      }
    }
    
    return { history: newHistory, sessionStats: stats };
  }),

  setActiveTrades: (n) => set({ activeTrades: n }),
  setBotRunning: (running) => set({ botRunning: running, botPaused: false, stopReason: running ? null : get().stopReason }),
  setBotPaused: (paused) => set({ botPaused: paused }),
  setStopReason: (reason) => set({ stopReason: reason, botRunning: false, botPaused: false }),
  setBotStatus: (botStatus) => set({ botStatus }),
  setLiveAnalysisBoard: (liveAnalysisBoard) => set({ liveAnalysisBoard }),

  resetSession: () => {
    currentSessionId = Date.now().toString(36);
    set({
      history: [],
      activeTrades: 0,
      sessionStats: { wins: 0, losses: 0, pnl: 0, trades: 0 },
      stopReason: null,
      botStatus: '',
      liveAnalysisBoard: null,
    });
  },

  getPersistedLog: () => loadPersistedLog(),

  clearPersistedLog: () => {
    try {
      localStorage.removeItem(ANALYTICS_LOG_KEY);
    } catch {}
  },
}));

export default useTradeStore;
