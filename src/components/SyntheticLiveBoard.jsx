import React, { useMemo } from 'react';
import { Activity, Zap, TrendingUp } from 'lucide-react';
import useTradeStore from '../store/useTradeStore';
import useConfigStore from '../store/useConfigStore';

const STATUS_STYLE = {
  READY: { bg: 'rgba(0,255,136,0.14)', color: 'var(--success)', label: 'READY' },
  NEAR: { bg: 'rgba(255,193,7,0.14)', color: 'var(--amber)', label: 'NEAR' },
  WATCHING: { bg: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)', label: 'WATCHING' },
  WARMING: { bg: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)', label: 'WARMING' },
};

const SYNTHETIC_STRATEGIES = new Set(['BOTH', 'BOTH5', 'EO_WINNING', 'OU_WINNING', 'OMNISNIPER', 'OVER_6', 'UNDER_8_V1', 'UNDER_8_V2', 'OVER_3_V1', 'OVER_3_V2', 'OVER_3_V3', 'OVER_5_V1', 'OVER_6_V2', 'UNDER_3_V1', 'UNDER_7_V1', 'EVEN_V1', 'ODD_V1', 'OVER_0_V1', 'UNDER_9_V1', 'O0_U9_HYBRID', 'RANDOM_PICKER']);

function StatusBadge({ status }) {
  const cfg = STATUS_STYLE[status] || STATUS_STYLE.WATCHING;
  return (
    <span style={{
      fontSize: 9, fontWeight: 800, letterSpacing: '0.4px',
      color: cfg.color, background: cfg.bg, padding: '2px 6px', borderRadius: 4,
    }}>
      {cfg.label}
    </span>
  );
}

function BoardRow({ row, isBest }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '28px 1fr 72px 52px 44px 44px 44px 48px',
      gap: 6,
      alignItems: 'center',
      padding: '6px 10px',
      borderRadius: 8,
      background: isBest ? 'rgba(0,229,255,0.08)' : 'rgba(255,255,255,0.02)',
      border: isBest ? '1px solid rgba(0,229,255,0.25)' : '1px solid transparent',
      fontSize: 11,
    }}>
      <span className="font-data" style={{ color: 'var(--text-muted)', fontWeight: 700 }}>#{row.rank}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, color: isBest ? 'var(--cyan)' : 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {row.marketLabel}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{row.dir}</div>
      </div>
      <StatusBadge status={row.status} />
      <span className="font-data" style={{ color: row.winChance >= 50 ? 'var(--success)' : 'var(--text-secondary)' }}>
        {row.winChance}%
      </span>
      <span className="font-data" style={{ color: 'var(--text-muted)' }}>{row.lt}%</span>
      <span className="font-data" style={{ color: 'var(--amber)' }}>VL{row.streak}</span>
      <span className="font-data" style={{ color: 'var(--text-secondary)' }}>{row.score}</span>
      <span className="font-data" style={{ color: row.recoveryScore >= 80 ? 'var(--success)' : 'var(--text-muted)', fontSize: 10 }}>
        {row.recoveryScore}
      </span>
    </div>
  );
}

export default function SyntheticLiveBoard() {
  const strategy = useConfigStore(s => s.strategy);
  const board = useTradeStore(s => s.liveAnalysisBoard);
  const botRunning = useTradeStore(s => s.botRunning);

  const isSynthetic = SYNTHETIC_STRATEGIES.has(strategy);
  const rows = board?.rows || [];
  const sideLabel = board?.sideLabel || (strategy === 'BOTH5' || strategy === 'OU_WINNING' ? 'OVER5 / UNDER5' : 'EVEN / ODD');

  const displayRows = useMemo(() => {
    if (strategy === 'OMNISNIPER') return rows.slice(0, 20);
    return rows.slice(0, 30);
  }, [rows, strategy]);

  if (!isSynthetic) return null;

  const best = board?.bestPick;
  const ageSec = board?.updatedAt ? Math.round((Date.now() - board.updatedAt) / 1000) : null;

  return (
    <div className="glass" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Activity size={16} color="var(--cyan)" />
            <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: '0.3px' }}>Live Trade Analysis</span>
            {botRunning && (
              <span style={{ fontSize: 9, fontWeight: 800, color: 'var(--success)', background: 'rgba(0,255,136,0.12)', padding: '2px 6px', borderRadius: 4 }}>
                LIVE
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            All 15 markets · {sideLabel} scanned together · best-sort every 1s
            {board?.previewMode && !botRunning ? ' · pre-trade analysis' : ''}
          </div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 10, color: 'var(--text-muted)' }}>
          <div>{board?.readyCount ?? 0} ready · {board?.nearCount ?? 0} near</div>
          {ageSec != null && ageSec < 120 && <div>updated {ageSec}s ago</div>}
        </div>
      </div>

      {best && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 12px', borderRadius: 10,
          background: 'rgba(0,229,255,0.08)', border: '1px solid rgba(0,229,255,0.2)',
        }}>
          <Zap size={16} color="var(--cyan)" />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--cyan)' }}>
              Best pick: {best.dir} · {best.marketLabel}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
              Edge {best.binaryEdge ?? best.score} · win {best.winChance}% · VL {best.streak}/{best.required}
              {board?.rankedCount != null ? ` · ${board.rankedCount} ranked` : ''}
            </div>
          </div>
          <StatusBadge status={best.status} />
        </div>
      )}

      {!botRunning && !rows.length && (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
          Warming 15 markets… analysis appears as ticks load (before or after START)
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '28px 1fr 72px 52px 44px 44px 44px 48px',
            gap: 6,
            padding: '0 10px 4px',
            fontSize: 9,
            fontWeight: 700,
            color: 'var(--text-muted)',
            letterSpacing: '0.4px',
            textTransform: 'uppercase',
          }}>
            <span>#</span>
            <span>Market / Side</span>
            <span>Status</span>
            <span>Win%</span>
            <span>Bias</span>
            <span>VL</span>
            <span>Score</span>
            <span>Recov</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
            {displayRows.map((row) => (
              <BoardRow key={`${row.sym}:${row.dir}`} row={row} isBest={row.rank === 1} />
            ))}
          </div>
          {rows.length > displayRows.length && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center' }}>
              +{rows.length - displayRows.length} more slots analyzed
            </div>
          )}
        </>
      )}

      {botRunning && rows.length === 0 && (
        <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <TrendingUp size={14} /> Warming up all 15 markets…
        </div>
      )}
    </div>
  );
}

