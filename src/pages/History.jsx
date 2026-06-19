/* ═══ History Page ═══ */
import { Download, Trash2, FileSpreadsheet, Database } from 'lucide-react';
import TradeHistory from '../components/TradeHistory';
import PerformanceBreakdown from '../components/PerformanceBreakdown';
import useTradeStore from '../store/useTradeStore';
import { useRealMarketStore } from '../stores/useRealMarketStore';
import useConfigStore from '../store/useConfigStore';
import { downloadTradesCsv, downloadTradesJson } from '../lib/tradeExport';
import { fmtMoney, num } from '../lib/format';

export default function History() {
  const history = useTradeStore(s => s.history) || [];
  const stats = useTradeStore(s => s.sessionStats);
  const stopReason = useTradeStore(s => s.stopReason);
  
  const config = useConfigStore();

  const handleExportJson = () => downloadTradesJson(history);
  const handleExportCsv = () => downloadTradesCsv(history);
  const handleExportPersisted = () => {
    const log = useTradeStore.getState().getPersistedLog();
    downloadTradesCsv(log, 'derivprinter_analytics_log');
  };

  const winRate = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : '0.0';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="font-display" style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>
            Trade History
          </h1>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            {stats.trades} trades • {winRate}% win rate • P&L: ${fmtMoney(stats.pnl)}
            {config.conservativeMode ? ' • conservative' : ''}
            {config.minStakeOnly ? ' • base stake only' : ''}
          </p>
          {stopReason && (
            <p style={{ fontSize: 11, color: 'var(--crimson)', marginTop: 4, marginBottom: 0 }}>
              Last stop: {stopReason}
            </p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => { 
            useTradeStore.getState().resetSession(); 
            useTradeStore.getState().clearPersistedLog();
            useRealMarketStore.getState().resetSession(); 
          }} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 14px', borderRadius: 8, border: '1px solid var(--crimson)',
            background: 'rgba(255, 68, 79, 0.1)', color: 'var(--crimson)',
            fontSize: 12, cursor: 'pointer',
            opacity: history.length > 0 ? 1 : 0.5,
          }} disabled={history.length === 0}>
            <Trash2 size={14} /> Reset sessions
          </button>
          <button onClick={handleExportCsv} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 14px', borderRadius: 8, border: '1px solid var(--cyan)',
            background: 'rgba(0, 229, 255, 0.08)', color: 'var(--cyan)',
            fontSize: 12, cursor: 'pointer',
            opacity: history.length > 0 ? 1 : 0.5,
          }} disabled={history.length === 0}>
            <FileSpreadsheet size={14} /> Export CSV
          </button>
          <button onClick={handleExportJson} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border)',
            background: 'transparent', color: 'var(--text-secondary)',
            fontSize: 12, cursor: 'pointer',
            opacity: history.length > 0 ? 1 : 0.5,
          }} disabled={history.length === 0}>
            <Download size={14} /> JSON
          </button>
          {config.persistTradeLog !== false && (
            <button onClick={handleExportPersisted} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border)',
              background: 'transparent', color: 'var(--text-secondary)',
              fontSize: 12, cursor: 'pointer',
            }}>
              <Database size={14} /> Full log CSV
            </button>
          )}
        </div>
      </div>

      <PerformanceBreakdown />

      <div className="glass" style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        {[
          { label: 'Total Trades', value: stats.trades, color: 'var(--text-primary)' },
          { label: 'Wins', value: stats.wins, color: 'var(--emerald)' },
          { label: 'Losses', value: stats.losses, color: 'var(--crimson)' },
          { label: 'Win Rate', value: `${winRate}%`, color: 'var(--cyan)' },
          { label: 'Net P&L', value: `$${fmtMoney(stats.pnl)}`, color: num(stats.pnl) >= 0 ? 'var(--emerald)' : 'var(--crimson)' },
        ].map(item => (
          <div key={item.label} style={{ textAlign: 'center', flex: 1 }}>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 2 }}>
              {item.label}
            </div>
            <div className="font-data" style={{ fontSize: 16, fontWeight: 700, color: item.color }}>
              {item.value}
            </div>
          </div>
        ))}
      </div>

      <TradeHistory limit={0} usePersistentLog={true} />
    </div>
  );
}
