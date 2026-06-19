/* ═══ TradeHistory — Expanded History Table ═══ */
import { useEffect, useState } from 'react';
import useTradeStore from '../store/useTradeStore';
import { useRealMarketStore } from '../stores/useRealMarketStore';
import { MARKET_LABELS } from '../lib/marketScanner';
import { Trash2, Timer } from 'lucide-react';
import enhancedTradeEngine from '../lib/enhancedTradeEngine';

function formatTimeElapsed(ms) {
  if (ms < 1000) return 'Just now';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

const LEG_DISPLAY_ORDER = { EVEN: 0, ODD: 1, OVER5: 0, UNDER5: 1 };

function fmtMoney(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

function sortTradesForDisplay(rows) {
  return [...rows].sort((a, b) => {
    if (b.time !== a.time) return b.time - a.time;
    const ma = MARKET_LABELS[a.market] || a.market;
    const mb = MARKET_LABELS[b.market] || b.market;
    if (ma !== mb) return String(ma).localeCompare(String(mb));
    const ao = a.legOrder ?? LEG_DISPLAY_ORDER[a.direction] ?? 5;
    const bo = b.legOrder ?? LEG_DISPLAY_ORDER[b.direction] ?? 5;
    return ao - bo;
  });
}

export default function TradeHistory({ limit = 10, fullHeight = false, usePersistentLog = false }) {
  const sessionHistory = useTradeStore(s => s.history) || [];
  const stats = useTradeStore(s => s.sessionStats);
  
  const [persistentLog, setPersistentLog] = useState([]);

  useEffect(() => {
    if (usePersistentLog) {
      setPersistentLog(useTradeStore.getState().getPersistedLog());
    }
  }, [usePersistentLog, sessionHistory.length]);

  const sourceHistory = usePersistentLog ? persistentLog : sessionHistory;

  const trades = limit
    ? sortTradesForDisplay(sourceHistory).slice(0, limit)
    : sortTradesForDisplay(sourceHistory);
  const [now, setNow] = useState(Date.now());

  // Update time elapsed every second
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Calculate session max stats dynamically (only for sessionHistory)
  let maxStake = 0;
  let maxCashout = 0;
  sessionHistory.forEach(t => {
    const stake = Number(t.stake) || 0;
    const profit = Number(t.profit) || 0;
    if (stake > maxStake) maxStake = stake;
    const payout = t.won ? (stake + profit) : 0;
    if (payout > maxCashout) maxCashout = payout;
  });

  const renderRows = [];
  let lastSessionId = null;
  trades.forEach(t => {
    if (usePersistentLog && t.sessionId !== lastSessionId) {
      renderRows.push({ type: 'session-splitter', id: `split-${t.sessionId || t.time}`, time: t.time });
      lastSessionId = t.sessionId;
    }
    renderRows.push({ type: 'trade', data: t });
  });

  return (
    <div className="glass flex flex-col h-full" style={{ padding: '14px 20px', overflow: 'hidden' }}>
      
      {/* Removed Uptime Timer Card */}

      {/* Header & Stats Summary */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Trade History
        </div>
        <div className="flex gap-6 items-center">
          <div className="flex flex-col items-end">
            <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Trades</span>
            <span className="font-data" style={{ fontSize: 14, color: 'var(--text-primary)', fontWeight: 700 }}>
              {stats.trades}
            </span>
          </div>
          <div className="flex flex-col items-end">
            <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Session P&L</span>
            <span className="font-data" style={{ fontSize: 14, color: stats.pnl >= 0 ? 'var(--success)' : 'var(--crimson)', fontWeight: 700 }}>
              {Number(stats.pnl) >= 0 ? '+' : ''}${fmtMoney(stats.pnl)}
            </span>
          </div>
          <div className="flex flex-col items-end">
            <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Max Stake</span>
            <span className="font-data" style={{ fontSize: 14, color: 'var(--amber)', fontWeight: 700 }}>${maxStake.toFixed(2)}</span>
          </div>
          <div className="flex flex-col items-end">
            <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Max Payout</span>
            <span className="font-data" style={{ fontSize: 14, color: 'var(--success)', fontWeight: 700 }}>${maxCashout.toFixed(2)}</span>
          </div>
          {enhancedTradeEngine.sessionStartedAt > 0 && (
            <div className="flex flex-col items-end">
              <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Uptime</span>
              <span className="font-data" style={{ fontSize: 14, color: 'var(--cyan)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                {(() => {
                  const endTime = enhancedTradeEngine.sessionEndedAt > 0 ? enhancedTradeEngine.sessionEndedAt : now;
                  const elapsed = Math.max(0, Math.floor((endTime - enhancedTradeEngine.sessionStartedAt) / 1000));
                  const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
                  const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
                  const s = String(elapsed % 60).padStart(2, '0');
                  return `${h}:${m}:${s}`;
                })()}
              </span>
            </div>
          )}
          <button 
            onClick={() => { 
              useTradeStore.getState().resetSession(); 
              useTradeStore.getState().clearPersistedLog();
              useRealMarketStore.getState().resetSession(); 
              setPersistentLog([]);
            }}
            style={{
              background: 'rgba(255, 68, 79, 0.1)', border: '1px solid var(--crimson)',
              color: 'var(--crimson)', padding: '6px', borderRadius: 6, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}
            title="Reset History"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      {trades.length === 0 ? (
        <div className="flex-1 flex items-center justify-center" style={{ fontSize: 14, color: 'var(--text-muted)' }}>
          No trades yet in this session.
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto" style={{ margin: '0 -12px', padding: '0 12px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-card)', zIndex: 10 }}>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Time', 'Market', 'Type', 'Stake', 'Score', 'P&L'].map((h, i) => (
                  <th key={h} style={{
                    padding: '12px 6px', textAlign: i >= 3 ? 'right' : 'left',
                    color: 'var(--text-muted)', fontWeight: 600, fontSize: 11,
                    textTransform: 'uppercase', letterSpacing: '0.5px',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {renderRows.map((row, idx) => {
                if (row.type === 'session-splitter') {
                  return (
                    <tr key={row.id} style={{ background: 'rgba(255,255,255,0.02)' }}>
                      <td colSpan="6" style={{ padding: '8px', textAlign: 'center', fontSize: 11, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
                        Session • {new Date(row.time).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                      </td>
                    </tr>
                  );
                }
                const t = row.data;
                return (
                  <tr key={t.id} style={{
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                  }} className="hover:bg-white/5 transition-colors">
                    <td className="font-data" style={{ padding: '12px 6px', color: 'var(--text-secondary)' }}>
                      <div className="flex flex-col">
                        <span style={{ fontSize: 13 }}>{new Date(t.time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'})}</span>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{formatTimeElapsed(now - t.time)}</span>
                      </div>
                    </td>
                    <td className="font-data" style={{ padding: '12px 6px', color: 'var(--amber)', fontWeight: 600 }}>
                      {MARKET_LABELS[t.market] || t.market}
                    </td>
                    <td className="font-data" style={{ padding: '12px 6px', color: 'var(--text-primary)' }}>
                      <span style={{
                        padding: '2px 6px', borderRadius: 4, fontSize: 11,
                        background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)'
                      }}>
                        {t.direction}
                      </span>
                    </td>
                    <td className="font-data text-right" style={{ padding: '12px 6px', color: 'var(--text-primary)' }}>
                      ${fmtMoney(t.stake)}
                    </td>
                    <td className="font-data text-right" style={{ padding: '12px 6px', color: 'var(--text-muted)', fontSize: 11 }}>
                      {t.score != null || t.sniperScore != null
                        ? (t.sniperScore ?? t.score)
                        : '—'}
                    </td>
                    <td className="font-data text-right" style={{
                      padding: '12px 6px', fontSize: 13, fontWeight: 700,
                      color: t.pending ? 'var(--text-muted)' : (t.won ? 'var(--success)' : 'var(--crimson)'),
                    }}>
                      {t.pending ? '...' : `${t.won ? '+' : ''}${fmtMoney(t.profit)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
