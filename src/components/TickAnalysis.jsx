import React, { useState, useEffect, useMemo } from 'react';
import enhancedTradeEngine from '../lib/enhancedTradeEngine';
import scanner from '../lib/marketScanner';
import { Activity } from 'lucide-react';

export default function TickAnalysis() {
  const [ticks, setTicks] = useState([]);
  const [windowSize, setWindowSize] = useState(1000);
  const [activeMarket, setActiveMarket] = useState(enhancedTradeEngine.activeMarket);
  const [strategy, setStrategy] = useState(enhancedTradeEngine.strategy);

  useEffect(() => {
    // Poll for active market and strategy changes
    const interval = setInterval(() => {
      if (enhancedTradeEngine.activeMarket !== activeMarket) {
        setActiveMarket(enhancedTradeEngine.activeMarket);
      }
      if (enhancedTradeEngine.strategy !== strategy) {
        setStrategy(enhancedTradeEngine.strategy);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [activeMarket, strategy]);

  useEffect(() => {
    const handleUpdate = (symbol) => {
      if (symbol === activeMarket) {
        setTicks(scanner.getTicks(symbol));
      }
    };
    
    if (activeMarket) {
      setTicks(scanner.getTicks(activeMarket));
    }

    const unsub = scanner.onUpdate(handleUpdate);
    return () => unsub();
  }, [activeMarket]);

  const isEO = strategy === 'EO_WINNING';
  const isOU = strategy === 'OU_WINNING' || strategy === 'BOTH5';

  const sideStats = useMemo(() => {
    if (!ticks.length || (!isEO && !isOU)) return null;
    const slice = ticks.slice(-windowSize);
    let left = 0, right = 0;
    
    if (isEO) {
      slice.forEach(d => { if (d % 2 === 0) left++; else right++; });
    } else {
      slice.forEach(d => { 
        if (d > 5) left++; 
        else if (d < 5) right++; 
      });
    }
    
    const total = left + right;
    if (total === 0) return { leftPct: 50, rightPct: 50 };
    return {
      leftPct: (left / total) * 100,
      rightPct: (right / total) * 100
    };
  }, [ticks, windowSize, isEO, isOU]);

  const stats = useMemo(() => {
    const slice = ticks.slice(-windowSize);
    const counts = Array(10).fill(0);
    slice.forEach(d => counts[d]++);
    
    const total = slice.length || 1;
    const percentages = counts.map(c => Number(((c / total) * 100).toFixed(1)));
    
    const uniqueSorted = [...new Set(percentages)].sort((a, b) => b - a);
    const max1 = uniqueSorted[0];
    const max2 = uniqueSorted.length > 1 ? uniqueSorted[1] : -1;
    const min1 = uniqueSorted[uniqueSorted.length - 1];
    const min2 = uniqueSorted.length > 1 ? uniqueSorted[uniqueSorted.length - 2] : -1;

    return percentages.map(p => {
      let borderColor = 'var(--border)';
      if (slice.length > 0) {
        if (p === max1) borderColor = 'var(--success)'; // Green
        else if (p === min1) borderColor = 'var(--crimson)'; // Red
        else if (p === max2 && max2 !== min1) borderColor = '#0091f7'; // Blue
        else if (p === min2 && min2 !== max1) borderColor = '#f7d100'; // Yellow
      }
      return { p, borderColor };
    });
  }, [ticks, windowSize]);

  return (
    <div className="glass" style={{ padding: '12px 14px', marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Activity size={16} color="var(--cyan)" />
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Tick Analysis</span>
        </div>
        <select
          value={windowSize}
          onChange={(e) => setWindowSize(Number(e.target.value))}
          style={{
            background: 'var(--bg-primary)', border: '1px solid var(--border)',
            color: 'var(--text-primary)', fontSize: 11, padding: '4px 8px', borderRadius: 4, outline: 'none',
            cursor: 'pointer'
          }}
        >
          {[10, 30, 50, 100, 500, 1000].map(v => (
            <option key={v} value={v}>{v} ticks</option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-5 md:flex md:justify-between items-start gap-y-4 w-full">
        {stats.map((s, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div style={{
              width: 34, height: 34, borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `2px solid ${s.borderColor}`,
              fontSize: 14, fontWeight: 800, 
              color: 'var(--text-primary)',
              background: ticks.length > 0 && ticks[ticks.length - 1] === i ? 'rgba(255, 255, 255, 0.15)' : 'var(--bg-primary)',
              boxShadow: ticks.length > 0 && ticks[ticks.length - 1] === i ? '0 0 12px rgba(255, 255, 255, 0.15)' : 'none',
              transition: 'all 0.15s ease'
            }}>
              {i}
            </div>
            <div className="font-data" style={{ fontSize: 10, color: 'var(--text-secondary)', fontWeight: 600 }}>
              {ticks.length > 0 ? s.p.toFixed(1) + '%' : '0.0%'}
            </div>
          </div>
        ))}
      </div>

      {sideStats && (
        <div style={{ marginTop: 24, padding: '0 4px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 800, marginBottom: 8 }}>
            <span style={{ color: '#0091f7' }}>{isEO ? 'EVEN' : 'OVER 5'} ({sideStats.leftPct.toFixed(1)}%)</span>
            <span style={{ color: 'var(--emerald, #10b981)' }}>{isEO ? 'ODD' : 'UNDER 5'} ({sideStats.rightPct.toFixed(1)}%)</span>
          </div>
          <div style={{ height: 8, width: '100%', background: 'var(--emerald, #10b981)', borderRadius: 4, overflow: 'hidden', display: 'flex', boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.2)' }}>
            <div style={{ width: `${sideStats.leftPct}%`, height: '100%', background: '#0091f7', transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)' }} />
          </div>
        </div>
      )}
    </div>
  );
}
