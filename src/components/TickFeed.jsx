/* ═══ TickFeed — Live digit strip ═══ */
import { useState, useEffect, useRef } from 'react';
import scanner from '../lib/marketScanner';
import useConnectionStore from '../store/useConnectionStore';

export default function TickFeed() {
  const [ticks, setTicks] = useState([]);
  const market = useConnectionStore(s => s.activeMarket);
  const containerRef = useRef(null);

  useEffect(() => {
    const unsub = scanner.onUpdate((sym, scores) => {
      if (sym === market && scores[sym]) {
        const d = scores[sym].lastDigit;
        if (d != null) {
          setTicks(t => [...t.slice(-39), { digit: d, time: Date.now() }]);
        }
      }
    });
    return () => unsub();
  }, [market]);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollLeft = containerRef.current.scrollWidth;
    }
  }, [ticks]);

  return (
    <div className="glass" style={{ padding: '12px 16px' }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        Live Tick Feed
      </div>
      <div ref={containerRef} style={{
        display: 'flex', gap: 4, overflow: 'hidden',
      }}>
        {ticks.length === 0 && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Waiting for ticks...</span>
        )}
        {ticks.map((t, i) => {
          const isEven = t.digit % 2 === 0;
          const isOver5 = t.digit > 5;
          return (
            <div key={t.time + '-' + i} style={{
              width: 28, height: 36,
              borderRadius: 6,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, fontWeight: 700,
              fontFamily: "'JetBrains Mono', monospace",
              background: isEven
                ? 'rgba(0,229,255,0.12)'
                : 'rgba(247,209,0,0.12)', // #f7d100
              color: isEven ? 'var(--cyan)' : '#f7d100',
              border: `1px solid ${isEven ? 'rgba(0,229,255,0.2)' : 'rgba(247,209,0,0.2)'}`,
              position: 'relative',
              flexShrink: 0,
            }}>
              {t.digit}
              {isOver5 && (
                <div style={{
                  position: 'absolute', top: 2, right: 2,
                  width: 4, height: 4, borderRadius: '50%',
                  background: 'var(--emerald)',
                }} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
