/* ═══ Apex Matrix 2.0 — sniper scoring status + top-10 leaderboard ═══ */
import { useEffect, useState } from 'react';
import { globalStrategyFocus } from '../lib/apexMeanReversionLeaderboard';

export default function StrategyStatusLine() {
  const [data, setData] = useState({
    market: 'SCANNING...',
    poolSize: 0,
    recoveries: 0,
    mode: 'BOTH5',
    leaderboard: [],
    martingaleLevel: 0,
    blacklistedCount: 0,
    globalLossStreak: 0,
    bestSniperScore: 0,
  });

  useEffect(() => {
    const sync = setInterval(() => {
      setData({
        market: globalStrategyFocus.activeTargetMarket,
        poolSize: globalStrategyFocus.readyPoolSize,
        recoveries: globalStrategyFocus.activeRecoveries,
        mode: globalStrategyFocus.currentMode,
        leaderboard: globalStrategyFocus.leaderboardDisplay || [],
        martingaleLevel: globalStrategyFocus.martingaleLevel ?? 0,
        blacklistedCount: globalStrategyFocus.blacklistedCount ?? 0,
        globalLossStreak: globalStrategyFocus.globalLossStreak ?? 0,
        bestSniperScore: globalStrategyFocus.bestSniperScore ?? 0,
      });
    }, 400);
    return () => clearInterval(sync);
  }, []);

  const hasPool = data.poolSize > 0;
  const isRecovering = data.recoveries > 0 || data.martingaleLevel > 0;
  let statusColor = 'var(--cyan)';
  if (hasPool) statusColor = 'var(--success)';
  if (isRecovering) statusColor = 'var(--amber)';
  if (data.globalLossStreak >= 4) statusColor = 'var(--crimson)';

  return (
    <div
      className="glass"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '12px 16px',
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        fontSize: 11,
      }}
    >
      <div
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: statusColor,
          marginTop: 4,
          flexShrink: 0,
          boxShadow: `0 0 10px ${statusColor}`,
        }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', minWidth: 0 }}>
        <span style={{ color: 'var(--text-muted)', letterSpacing: '0.1px', lineHeight: 1.5 }}>
          <strong style={{ color: statusColor }}>APEX SNIPER</strong>
          {' · '}{data.mode}
          {' · '}Pool: <strong style={{ color: 'var(--text-primary)' }}>{data.poolSize}</strong>
          {data.bestSniperScore > 0 && (
            <>
              {' · '}Best score: <strong>{data.bestSniperScore}</strong>/9
            </>
          )}
          {' · '}Martingale L<strong>{data.martingaleLevel}</strong>
          {data.blacklistedCount > 0 && (
            <>
              {' · '}
              <strong style={{ color: 'var(--crimson)' }}>{data.blacklistedCount} blacklisted</strong>
            </>
          )}
          {data.globalLossStreak > 0 && (
            <>
              {' · '}
              Global L-streak: <strong>{data.globalLossStreak}/6</strong>
            </>
          )}
          <br />
          <span style={{ color: 'var(--text-secondary)' }}>{data.market}</span>
        </span>
        <span
          style={{
            color: 'var(--amber)',
            fontSize: 10,
            letterSpacing: '0.2px',
            fontWeight: 600,
            wordBreak: 'break-word',
          }}
        >
          Top-10 vectors (WR ≥58% · sniper score ≥6: exhaustion +5, vol +2, top10 +2):{' '}
          {data.leaderboard.length > 0
            ? data.leaderboard.join(' · ')
            : 'Building 60-vector ledgers…'}
        </span>
      </div>
    </div>
  );
}
