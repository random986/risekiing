/* Performance analytics — breakdown by direction & market */
import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import useTradeStore from '../store/useTradeStore';
import { MARKET_LABELS } from '../lib/marketScanner';
import {
  computePerformanceBreakdown,
  BINARY_BREAKEVEN_WR,
} from '../lib/tradeAnalytics';

function fmtNum(v, digits = 2) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : '0.00';
}

function fmtPct(v, digits = 1) {
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(digits)}%` : '—';
}

function StatCell({ label, value, color }) {
  return (
    <div style={{ textAlign: 'center', flex: 1, minWidth: 72 }}>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 2 }}>
        {label}
      </div>
      <div className="font-data" style={{ fontSize: 14, fontWeight: 700, color: color || 'var(--text-primary)' }}>
        {value}
      </div>
    </div>
  );
}

function MiniTable({ title, rows, labelFn }) {
  if (!rows?.length) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 8, fontWeight: 600 }}>
        {title}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            {['Name', 'Trades', 'WR%', 'P&L'].map(h => (
              <th key={h} style={{
                padding: '6px 4px', textAlign: h === 'Name' ? 'left' : 'right',
                color: 'var(--text-muted)', fontWeight: 600, fontSize: 10,
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.key} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <td style={{ padding: '6px 4px', color: 'var(--amber)', fontWeight: 600 }}>
                {labelFn ? labelFn(r.key) : r.key}
              </td>
              <td className="font-data" style={{ padding: '6px 4px', textAlign: 'right' }}>{r.trades}</td>
              <td className="font-data" style={{
                padding: '6px 4px', textAlign: 'right',
                color: r.winRate >= BINARY_BREAKEVEN_WR ? 'var(--emerald)' : 'var(--crimson)',
              }}>
                {r.trades ? fmtPct(r.winRate) : '—'}
              </td>
              <td className="font-data" style={{
                padding: '6px 4px', textAlign: 'right', fontWeight: 600,
                color: r.pnl >= 0 ? 'var(--emerald)' : 'var(--crimson)',
              }}>
                {r.pnl >= 0 ? '+' : ''}${fmtNum(r.pnl)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PerformanceBreakdown() {
  const [collapsed, setCollapsed] = useState(true);
  const history = useTradeStore(s => s.history);
  const stats = useTradeStore(s => s.sessionStats);
  const breakdown = computePerformanceBreakdown(history);
  const { overall, expectancy, rolling10, rolling50, belowBreakeven } = breakdown;

  const winRate = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : '0.0';

  return (
    <div className="glass" style={{ padding: collapsed ? '10px 16px' : '16px 20px' }}>
      <button
        type="button"
        onClick={() => setCollapsed(c => !c)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          marginBottom: collapsed ? 0 : 12,
          textAlign: 'left',
        }}
      >
        <div>
          <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>
            Performance Analytics
          </h2>
          {!collapsed && (
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>
              Break-even on digits ≈ {BINARY_BREAKEVEN_WR}% · export CSV from History for full logs
            </p>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {collapsed && stats.trades > 0 && (
            <span className="font-data" style={{ fontSize: 11, color: 'var(--cyan)', fontWeight: 600 }}>
              WR {winRate}%
            </span>
          )}
          {belowBreakeven && stats.trades >= 10 && (
            <span style={{
              fontSize: 10, padding: '4px 10px', borderRadius: 6,
              background: 'rgba(255, 68, 79, 0.15)', color: 'var(--crimson)', fontWeight: 600,
            }}>
              Below break-even
            </span>
          )}
          {collapsed
            ? <ChevronDown size={16} color="var(--text-muted)" />
            : <ChevronUp size={16} color="var(--text-muted)" />}
        </div>
      </button>

      {collapsed && stats.trades > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
          <span>Trades <strong className="font-data" style={{ color: 'var(--text-primary)' }}>{stats.trades}</strong></span>
          <span>P&L <strong className="font-data" style={{ color: Number(stats.pnl) >= 0 ? 'var(--emerald)' : 'var(--crimson)' }}>${fmtNum(stats.pnl)}</strong></span>
          {rolling10 != null && <span>WR10 <strong className="font-data" style={{ color: 'var(--text-primary)' }}>{fmtPct(rolling10)}</strong></span>}
        </div>
      )}

      {!collapsed && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            <StatCell label="Session WR" value={`${winRate}%`} color="var(--cyan)" />
            <StatCell label="WR (10)" value={rolling10 != null ? fmtPct(rolling10) : '—'} />
            <StatCell label="WR (50)" value={rolling50 != null ? fmtPct(rolling50) : '—'} />
            <StatCell
              label="Expectancy"
              value={`$${fmtNum(expectancy.expectancy, 3)}`}
              color={Number(expectancy.expectancy) >= 0 ? 'var(--emerald)' : 'var(--crimson)'}
            />
            <StatCell label="Avg win" value={`$${fmtNum(expectancy.avgWin)}`} color="var(--emerald)" />
            <StatCell label="Avg loss" value={`$${fmtNum(expectancy.avgLoss)}`} color="var(--crimson)" />
          </div>

          <MiniTable title="By contract type" rows={breakdown.byDirection} />
          <MiniTable
            title="By market"
            rows={breakdown.byMarket.slice(0, 8)}
            labelFn={k => MARKET_LABELS[k] || k}
          />

          {overall.trades === 0 && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12, marginBottom: 0 }}>
              No settled trades yet. Analytics populate after each completed contract.
            </p>
          )}
        </>
      )}
    </div>
  );
}
