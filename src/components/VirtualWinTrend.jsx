/* ═══ Even/Odd vs Over/Under virtual win trend ═══ */
import { useEffect, useState } from 'react';
import { globalVirtualWinTrend, computeVirtualWinTrend } from '../lib/virtualWinTrend';
import { buildMeanReversionLeaderboard } from '../lib/apexMeanReversionLeaderboard';
import scanner from '../lib/marketScanner';
import { Play, Clock, RotateCcw, CheckCircle2 } from 'lucide-react';

export default function VirtualWinTrend() {
  const [trend, setTrend] = useState({ ...globalVirtualWinTrend });
  
  // Test Mode State
  const [testState, setTestState] = useState('idle'); // idle, running, finished
  const [testDuration, setTestDuration] = useState(60);
  const [timeLeft, setTimeLeft] = useState(0);
  const [testResults, setTestResults] = useState(null);

  useEffect(() => {
    const tick = () => {
      const map = Object.fromEntries(
        Object.keys(scanner.buffers).map(sym => [sym, { history: scanner.buffers[sym] || [] }])
      );
      buildMeanReversionLeaderboard(map, 'BOTH5');
      computeVirtualWinTrend(scanner.buffers);
      if (testState !== 'finished') {
        setTrend({ ...globalVirtualWinTrend });
      }
    };
    tick();
    const id = setInterval(tick, 700);
    return () => clearInterval(id);
  }, [testState]);

  useEffect(() => {
    let timerId;
    if (testState === 'running' && timeLeft > 0) {
      timerId = setInterval(() => {
        setTimeLeft(t => {
          if (t <= 1) {
             setTestState('finished');
             setTestResults({ ...globalVirtualWinTrend });
             return 0;
          }
          return t - 1;
        });
      }, 1000);
    }
    return () => clearInterval(timerId);
  }, [testState, timeLeft]);

  const startTest = () => {
    setTestState('running');
    setTimeLeft(testDuration);
    setTestResults(null);
  };

  const resetTest = () => {
    setTestState('idle');
    setTestResults(null);
    setTrend({ ...globalVirtualWinTrend });
  };

  const currentData = testState === 'finished' ? (testResults || trend) : trend;

  const eo = Number(currentData.evenOdd?.winPct ?? 50);
  const ou = Number(currentData.overUnder?.winPct ?? 50);
  const leader = currentData.leader;
  const maxPct = Math.max(eo, ou, 55);
  const eoWidth = `${Math.min(100, (eo / maxPct) * 100)}%`;
  const ouWidth = `${Math.min(100, (ou / maxPct) * 100)}%`;
  const eoLeading = leader === 'evenOdd';
  const ouLeading = leader === 'overUnder';

  return (
    <div className="glass" style={{ padding: '16px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <h4 style={{
          margin: 0,
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--text-primary)',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
        }}>
          Virtual Strategy Tester (EO vs O/U)
        </h4>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Samples: {currentData.evenOdd?.samples || 0} virtual ticks
        </span>
      </div>

      {/* Test Controls */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        {[60, 180, 300].map(sec => (
          <button
            key={sec}
            onClick={() => { if (testState === 'idle') setTestDuration(sec); }}
            style={{
              background: testDuration === sec ? 'var(--cyan)' : 'var(--bg-secondary)',
              color: testDuration === sec ? '#000' : 'var(--text-muted)',
              border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 11, fontWeight: 700, 
              cursor: testState === 'idle' ? 'pointer' : 'not-allowed',
              transition: 'background 0.2s'
            }}
          >
            {sec / 60} MIN
          </button>
        ))}
        <button
          onClick={testState === 'idle' ? startTest : resetTest}
          style={{
            flex: 1, 
            background: testState === 'idle' ? 'var(--cyan)' : testState === 'running' ? 'var(--amber)' : 'var(--bg-secondary)',
            color: testState === 'idle' || testState === 'running' ? '#000' : '#fff',
            border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            transition: 'background 0.2s'
          }}
        >
          {testState === 'idle' && <><Play size={14} /> RUN VIRTUAL TEST</>}
          {testState === 'running' && <><Clock size={14} /> TESTING... {timeLeft}s</>}
          {testState === 'finished' && <><RotateCcw size={14} /> RESET TEST</>}
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, opacity: testState === 'idle' ? 0.6 : 1, transition: 'opacity 0.3s' }}>
        <TrendRow
          label="Even / Odd"
          sub="EVEN + ODD virtual wins"
          pct={eo}
          width={eoWidth}
          leading={eoLeading && testState !== 'idle'}
          color="var(--cyan)"
          samples={currentData.evenOdd?.samples}
        />
        <TrendRow
          label="Over / Under"
          sub="OVER 5 + UNDER 5 virtual wins"
          pct={ou}
          width={ouWidth}
          leading={ouLeading && testState !== 'idle'}
          color="var(--amber)"
          samples={currentData.overUnder?.samples}
        />
      </div>

      {testState === 'finished' ? (
        <div style={{ margin: '14px 0 0', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5, background: 'rgba(0, 229, 255, 0.05)', padding: '10px 14px', borderRadius: 8, border: '1px solid rgba(0, 229, 255, 0.1)' }}>
          <div style={{ color: '#fff', fontWeight: 600, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
            <CheckCircle2 size={14} color="var(--success)" />
            Test Complete ({testDuration / 60} Min)
          </div>
          {eoLeading && (
            <>Even/Odd is running <strong style={{ color: 'var(--cyan)' }}>{Number(currentData.margin ?? 0).toFixed(1)}%</strong> hotter. <strong>Suggestion:</strong> Adjust algorithm to prioritize EO exhaustion entries for maximum profitability in this window.</>
          )}
          {ouLeading && (
            <>Over/Under is running <strong style={{ color: 'var(--amber)' }}>{Number(currentData.margin ?? 0).toFixed(1)}%</strong> hotter. <strong>Suggestion:</strong> Adjust algorithm to prioritize O/U clusters for maximum profitability in this window.</>
          )}
          {leader === 'tie' && <>Both strategies are balanced. <strong>Suggestion:</strong> Deploy a hybrid approach blending momentum and stealth across top 3 families.</>}
        </div>
      ) : (
        <p style={{ margin: '12px 0 0', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {testState === 'running' ? 'Running simulation to determine optimal algorithmic bias...' : 'Select a timeframe and run test to determine profitable bias.'}
        </p>
      )}
    </div>
  );
}

function TrendRow({ label, sub, pct, width, leading, color, samples }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{label}</span>
          {leading && (
            <span style={{
              marginLeft: 8,
              fontSize: 9,
              fontWeight: 700,
              color,
              background: `${color}22`,
              padding: '2px 6px',
              borderRadius: 4,
            }}>
              LEADING
            </span>
          )}
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>
        </div>
        <span className="font-data" style={{ fontSize: 18, fontWeight: 700, color }}>{Number(pct || 0).toFixed(1)}%</span>
      </div>
      <div style={{
        height: 6,
        width: '100%',
        background: 'rgba(255,255,255,0.06)',
        borderRadius: 3,
        overflow: 'hidden',
      }}>
        <div style={{
          height: '100%',
          width,
          background: color,
          borderRadius: 3,
          transition: 'width 0.6s ease',
          boxShadow: leading ? `0 0 12px ${color}55` : 'none',
        }} />
      </div>
    </div>
  );
}
