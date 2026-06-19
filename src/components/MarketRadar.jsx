/* ═══ MarketRadar — Ranked market bars ═══ */
import { useState, useEffect } from 'react';
import scanner, { MARKET_LABELS } from '../lib/marketScanner';
import useConfigStore from '../store/useConfigStore';
import useConnectionStore from '../store/useConnectionStore';

export default function MarketRadar() {
  const [ranked, setRanked] = useState([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const strategy = useConfigStore(s => s.strategy);
  const activeMarket = useConnectionStore(s => s.activeMarket);

  useEffect(() => {
    // Auto-expand on larger screens
    if (window.innerWidth >= 768) {
      setIsExpanded(true);
    }
    
    const unsub = scanner.onUpdate((sym, scores) => {
      setRanked(scanner.getRanked(strategy));
    });
    return () => unsub();
  }, [strategy]);

  const isOU = strategy === 'BOTH5';

  return (
    <div className="glass" style={{ padding: '14px 16px' }}>
      <div 
        onClick={() => setIsExpanded(!isExpanded)}
        style={{ 
          fontSize: 11, color: 'var(--text-muted)', marginBottom: isExpanded ? 10 : 0, 
          textTransform: 'uppercase', letterSpacing: '0.5px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          cursor: 'pointer'
        }}
      >
        <span>Market Radar — {isOU ? 'Over/Under 5' : 'Even/Odd'}</span>
        <span className="md:hidden">{isExpanded ? '▼' : '▲'}</span>
      </div>
      
      {isExpanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {ranked.map((m, i) => {
          const score = isOU ? m.overUnderScore : m.evenOddScore;
          const isActive = m.symbol === activeMarket;
          const barColor = score > 60 ? 'var(--emerald)' : score > 40 ? 'var(--amber)' : 'var(--crimson)';

          return (
            <div key={m.symbol} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '4px 0',
              opacity: isActive ? 1 : 0.7,
            }}>
              <span className="font-data" style={{
                width: 32, fontSize: 11, fontWeight: 600,
                color: isActive ? 'var(--cyan)' : 'var(--text-muted)',
              }}>
                {m.label}
              </span>
              <div style={{
                flex: 1, height: 6, borderRadius: 3,
                background: 'rgba(255,255,255,0.05)',
                overflow: 'hidden',
              }}>
                <div style={{
                  width: `${Math.min(score, 100)}%`,
                  height: '100%',
                  borderRadius: 3,
                  background: barColor,
                  boxShadow: isActive ? `0 0 8px ${barColor}` : 'none',
                  transition: 'width 0.3s ease',
                }} />
              </div>
              <span className="font-data" style={{
                width: 28, fontSize: 10, textAlign: 'right',
                color: barColor,
              }}>
                {score}
              </span>
            </div>
          );
        })}
        </div>
      )}
    </div>
  );
}
