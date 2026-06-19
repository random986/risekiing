import React from 'react';
import { Target, TrendingUp, TrendingDown, Layers, Clock, Zap } from 'lucide-react';
import { fmt, num } from '../lib/format';

const STATUS_STYLE = {
  READY: { bg: 'rgba(0,255,136,0.12)', color: 'var(--success)', label: 'READY' },
  ARMED: { bg: 'rgba(255,193,7,0.12)', color: 'var(--amber)', label: 'ARMED' },
  EXECUTING: { bg: 'rgba(0,229,255,0.15)', color: 'var(--cyan)', label: 'EXECUTING' },
  WATCHING: { bg: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)', label: 'WATCHING' },
  WARMING: { bg: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)', label: 'WARMING' },
  BLOCKED: { bg: 'rgba(255,68,68,0.1)', color: 'var(--crimson)', label: 'BLOCKED' },
};

const TYPE_STYLE = {
  RISE: { color: 'var(--success)', Icon: TrendingUp },
  FALL: { color: 'var(--cyan)', Icon: TrendingDown },
  ACCUMULATOR: { color: 'var(--amber)', Icon: Layers },
};

function TypeBadge({ type }) {
  const cfg = TYPE_STYLE[type] || { color: 'var(--text-muted)', Icon: Target };
  const Icon = cfg.Icon;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 10, fontWeight: 700, color: cfg.color,
      background: `${cfg.color}18`, padding: '2px 7px', borderRadius: 4,
    }}>
      <Icon size={11} /> {type || '—'}
    </span>
  );
}

function StatusBadge({ status }) {
  const cfg = STATUS_STYLE[status] || STATUS_STYLE.WATCHING;
  return (
    <span style={{
      fontSize: 9, fontWeight: 800, letterSpacing: '0.5px',
      color: cfg.color, background: cfg.bg, padding: '2px 6px', borderRadius: 4,
    }}>
      {cfg.label}
    </span>
  );
}

function AccumulatorBars({ ea }) {
  const tiiPct = Math.max(0, Math.min(100, ((ea.tiiThreshold - ea.tii) / ea.tiiThreshold) * 100));
  const bbPct = ea.bbThreshold > 0
    ? Math.max(0, Math.min(100, ((ea.bbThreshold - ea.bbProx) / ea.bbThreshold) * 100))
    : 0;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-muted)', marginBottom: 3 }}>
          <span>TII exhaustion</span>
          <span className="font-data">{fmt(ea.tii, 3)} / {ea.tiiThreshold}</span>
        </div>
        <div style={{ height: 5, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${tiiPct}%`, background: 'var(--cyan)', opacity: ea.tiiOk ? 1 : 0.5, transition: 'width 0.3s' }} />
        </div>
      </div>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-muted)', marginBottom: 3 }}>
          <span>BB squeeze</span>
          <span className="font-data">{fmt(ea.bbProx, 6)} / {ea.bbThreshold}</span>
        </div>
        <div style={{ height: 5, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${bbPct}%`, background: 'var(--amber)', opacity: ea.bbOk ? 1 : 0.5, transition: 'width 0.3s' }} />
        </div>
      </div>
    </div>
  );
}

function OpportunityRow({ opp, autoTrade, inQueue, rank }) {
  const ea = opp.entryAnalysis || {};
  const isReady = ea.status === 'READY' || ea.status === 'ARMED' || ea.status === 'EXECUTING';

  return (
    <div style={{
      padding: '12px 14px', borderRadius: 8,
      background: isReady ? 'rgba(0,255,136,0.04)' : 'var(--bg-primary)',
      border: `1px solid ${isReady ? 'rgba(0,255,136,0.2)' : 'var(--border)'}`,
      transition: 'border-color 0.2s',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="font-data" style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 700 }}>#{rank}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{opp.name || opp.symbol}</span>
          <TypeBadge type={ea.tradeType} />
          <StatusBadge status={ea.status} />
          {inQueue && autoTrade && (
            <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--cyan)', display: 'flex', alignItems: 'center', gap: 3 }}>
              <Zap size={10} /> QUEUED
            </span>
          )}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="font-data" style={{ fontSize: 13, fontWeight: 700, color: 'var(--success)' }}>
            {opp.entryChance ?? '—'}%
          </div>
          <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>entry chance</div>
        </div>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 10, marginTop: 10, fontSize: 11,
      }}>
        <div>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600, marginBottom: 2 }}>Current spot</div>
          <div className="font-data" style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
            {ea.currentSpotFmt || '—'}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600, marginBottom: 2 }}>Target entry</div>
          <div className="font-data" style={{ fontSize: 14, fontWeight: 700, color: isReady ? 'var(--success)' : 'var(--cyan)' }}>
            {ea.status === 'READY' || ea.status === 'EXECUTING' ? 'SPOTTED' : (ea.targetSpotFmt || '—')}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
            {(ea.status === 'READY' || ea.status === 'EXECUTING') ? null : ea.targetCondition}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600, marginBottom: 2 }}>Routing</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
            {(ea.status === 'WATCHING' || ea.status === 'ARMED' || (ea.status === 'WARMING' && (!opp.routing || opp.routing === 'WAIT' || opp.routing === 'INITIALIZING')))
              ? <span style={{ fontWeight: 800, color: 'var(--cyan)' }}>{opp.routing && opp.routing !== 'WAIT' ? opp.routing : 'LOADING…'}</span>
              : <span>{opp.routing || '—'}</span>
            }
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>MCS {fmt(ea.mcsVal, 2)} · ER {fmt(opp.er, 2)}</div>
          {ea.status === 'EXECUTING' && typeof ea.livePnl === 'number' && Number.isFinite(ea.livePnl) && (
            <div style={{
              marginTop: 4,
              fontSize: 10,
              color: ea.livePnl >= 0 ? 'var(--emerald)' : 'var(--crimson)',
              fontWeight: 900,
            }}>
              Live P&L: {ea.livePnl >= 0 ? '+' : ''}${fmt(ea.livePnl, 2)}
            </div>
          )}
        </div>
      </div>

      {ea.tradeType === 'ACCUMULATOR' && ea.status !== 'WARMING' && (
        <AccumulatorBars ea={ea} />
      )}

      {(ea.status === 'WATCHING' || ea.status === 'WARMING') && ea.tradeType !== 'ACCUMULATOR' && (
        <div style={{ marginTop: 8 }}>
          <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${num(ea.progressPct, 0)}%`,
              background: ea.tradeType === 'RISE' ? 'var(--success)' : 'var(--cyan)',
              transition: 'width 0.4s ease',
            }} />
          </div>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 3 }}>
            {fmt(ea.progressPct, 0)}% toward entry trigger
          </div>
        </div>
      )}
    </div>
  );
}

export default function RealMarketTradeBoard({ opportunities, executionQueue, autoTrade, contractType, openMarketCount }) {
  const readyCount = opportunities.filter(o => o.entryAnalysis?.status === 'READY').length;
  const armedCount = opportunities.filter(o => o.entryAnalysis?.status === 'ARMED').length;
  const watchCount = opportunities.filter(o => o.entryAnalysis?.status === 'WATCHING').length;
  const warmingCount = opportunities.filter(o => o.entryAnalysis?.status === 'WARMING').length;
  const queueSyms = new Set((executionQueue || []).map(q => q.sym));

  const filterLabel = contractType === 'AUTO' ? 'Rise · Fall · Accumulators'
    : contractType === 'RISE/FALL' ? 'Rise / Fall'
    : 'Accumulators';

  return (
    <div className="glass" style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', minHeight: 280 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Live Trade Analysis Board
          </h4>
          <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--text-muted)' }}>
            {filterLabel} · {openMarketCount ?? opportunities.length} open markets · {readyCount} ready · {armedCount} armed · {watchCount} watching · {warmingCount} warming
          </p>
        </div>
        {autoTrade && executionQueue?.length > 0 && (
          <div style={{
            fontSize: 10, fontWeight: 700, color: 'var(--cyan)',
            background: 'rgba(0,229,255,0.1)', padding: '4px 10px', borderRadius: 6,
            display: 'flex', alignItems: 'center', gap: 5,
          }}>
            <Clock size={12} /> {executionQueue.length} queued · up to 2 concurrent
          </div>
        )}
      </div>

      {!autoTrade && readyCount > 0 && (
        <div style={{
          marginBottom: 10, padding: '8px 12px', borderRadius: 6,
          background: 'rgba(0,229,255,0.08)', border: '1px solid rgba(0,229,255,0.2)',
          fontSize: 11, color: 'var(--cyan)',
        }}>
          <strong>{readyCount} setup{readyCount !== 1 ? 's' : ''} at entry point</strong> — press START TRADING to lock in and execute (max 2 at once).
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 420 }}>
        {opportunities.length === 0 && (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>
            <div style={{ marginBottom: 8 }}>No open markets with live data yet.</div>
            <div style={{ fontSize: 11 }}>Closed markets are excluded. Tick streams populate Rise, Fall &amp; Accumulator chances as data arrives.</div>
          </div>
        )}
        {opportunities.map((opp, i) => (
          <OpportunityRow
            key={opp.symbol || opp.sym}
            opp={opp}
            rank={i + 1}
            autoTrade={autoTrade}
            inQueue={queueSyms.has(opp.sym || opp.symbol)}
          />
        ))}
      </div>
    </div>
  );
}
