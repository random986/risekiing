import { useState, useEffect } from 'react';
import { Copy, RefreshCw, StopCircle, PlayCircle, AlertTriangle, ArrowRight, ArrowLeftRight, Zap } from 'lucide-react';
import useAccountStore from '../store/useAccountStore';
import copyTradeEngine from '../lib/copyTradeEngine';
import { useRealMarketStore } from '../stores/useRealMarketStore';

export default function Copytrade() {
  const accounts = useAccountStore(s => s.accounts);
  const activeAccountId = useAccountStore(s => s.activeAccountId);

  const realAccounts = accounts.filter(a => !a.is_virtual);
  const demoAccounts = accounts.filter(a => a.is_virtual);

  const activeAccount = accounts.find(a => a.id === activeAccountId);
  const isCurrentlyReal = activeAccount && !activeAccount.is_virtual;
  const isCurrentlyDemo = activeAccount && activeAccount.is_virtual;

  // Direction: 'demo_to_real' or 'real_to_demo'
  const [direction, setDirection] = useState('demo_to_real');
  const [targetAccountId, setTargetAccountId] = useState('');
  const [engineState, setEngineState] = useState(copyTradeEngine.getState());
  const [logs, setLogs] = useState([]);
  const [scope, setScope] = useState('both'); // 'both' | 'synthetic' | 'real'

  // Real market trade history for mirroring
  const realTradeHistory = useRealMarketStore(s => s.tradeHistory);

  // Set default target based on direction
  useEffect(() => {
    if (direction === 'demo_to_real') {
      setTargetAccountId(realAccounts[0]?.id || '');
    } else {
      setTargetAccountId(demoAccounts[0]?.id || '');
    }
  }, [direction, accounts.length]);

  useEffect(() => {
    const interval = setInterval(() => {
      setEngineState(copyTradeEngine.getState());
    }, 1000);

    copyTradeEngine.onTradeLog = (msg) => {
      setLogs(prev => [...prev, { time: new Date(), msg }].slice(-50));
    };

    return () => {
      clearInterval(interval);
      copyTradeEngine.onTradeLog = null;
    };
  }, []);

  const sourceIsCorrect = direction === 'demo_to_real' ? isCurrentlyDemo : isCurrentlyReal;
  const sourceLabel = direction === 'demo_to_real' ? 'Demo' : 'Real';
  const targetLabel = direction === 'demo_to_real' ? 'Real' : 'Demo';
  const targetList = direction === 'demo_to_real' ? realAccounts : demoAccounts;

  const handleToggle = async () => {
    if (engineState.active) {
      copyTradeEngine.stop();
    } else {
      if (!sourceIsCorrect) {
        alert(`Please switch to a ${sourceLabel} account first to use ${sourceLabel}→${targetLabel} copying.`);
        return;
      }
      if (!targetAccountId) {
        alert(`Please select a target ${targetLabel} account.`);
        return;
      }
      const targetAcc = accounts.find(a => a.id === targetAccountId);
      if (!targetAcc) return;

      copyTradeEngine.configure({
        targetToken: targetAcc.token,
        targetAccountId: targetAcc.loginid,
        sourceAccountId: activeAccount.loginid,
        direction: direction,
        scope: scope
      });
      await copyTradeEngine.start();
    }
    setEngineState(copyTradeEngine.getState());
  };

  const dirBtnStyle = (active) => ({
    flex: 1, padding: '14px 12px', borderRadius: 10, cursor: 'pointer',
    border: active ? '2px solid var(--cyan)' : '1px solid var(--border)',
    background: active ? 'rgba(255, 68, 79, 0.08)' : 'transparent',
    color: active ? 'var(--crimson)' : 'var(--text-secondary)',
    textAlign: 'center', transition: 'all 0.2s',
    opacity: engineState.active ? 0.5 : 1,
    pointerEvents: engineState.active ? 'none' : 'auto',
  });

  const scopeBtnStyle = (active) => ({
    flex: 1, padding: '10px 8px', borderRadius: 8, cursor: 'pointer',
    border: active ? '2px solid var(--amber)' : '1px solid var(--border)',
    background: active ? 'rgba(255, 193, 7, 0.08)' : 'transparent',
    color: active ? 'var(--amber)' : 'var(--text-secondary)',
    textAlign: 'center', transition: 'all 0.2s', fontSize: 12, fontWeight: 600,
    opacity: engineState.active ? 0.5 : 1,
    pointerEvents: engineState.active ? 'none' : 'auto',
  });

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <Copy size={28} color="var(--amber)" />
        <h1 className="font-display" style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Copytrade Engine</h1>
      </div>

      <div style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 12, padding: 24, marginBottom: 32
      }}>
        {/* Direction Selector */}
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <ArrowLeftRight size={18} color="var(--amber)" />
          Copy Direction
        </h2>
        <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
          <button onClick={() => setDirection('demo_to_real')} style={dirBtnStyle(direction === 'demo_to_real')}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Demo → Real</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Copy trades from Demo to Real account</div>
          </button>
          <button onClick={() => setDirection('real_to_demo')} style={dirBtnStyle(direction === 'real_to_demo')}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Real → Demo</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Copy trades from Real to Demo account</div>
          </button>
        </div>

        {/* Scope Selector */}
        <h2 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Zap size={16} color="var(--amber)" />
          Trade Scope
        </h2>
        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          <button onClick={() => setScope('both')} style={scopeBtnStyle(scope === 'both')}>
            Both Markets
          </button>
          <button onClick={() => setScope('synthetic')} style={scopeBtnStyle(scope === 'synthetic')}>
            Synthetic Only
          </button>
          <button onClick={() => setScope('real')} style={scopeBtnStyle(scope === 'real')}>
            Real Only
          </button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 24, lineHeight: 1.5 }}>
          <strong style={{ color: 'var(--amber)' }}>Both Markets</strong>: Copies trades from both Synthetic Indices and Real Markets engines. 
          <strong style={{ color: 'var(--text-secondary)' }}> Synthetic Only</strong>: Only digit (Even/Odd/Over/Under) trades. 
          <strong style={{ color: 'var(--text-secondary)' }}> Real Only</strong>: Only Rise/Fall and Accumulator trades from the Real Market engine.
        </div>

        {/* Source & Target */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 16, alignItems: 'center', marginBottom: 32 }}>
          {/* Source Account */}
          <div style={{ background: 'var(--bg-primary)', padding: 16, borderRadius: 8, border: '1px solid var(--border)' }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', display: 'block', marginBottom: 8, letterSpacing: '0.5px' }}>Source ({sourceLabel})</span>
            {sourceIsCorrect ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--success)' }} />
                <span className="font-data" style={{ fontWeight: 700, fontSize: 14 }}>{activeAccount.loginid}</span>
                <span style={{
                  fontSize: 10, padding: '3px 6px', borderRadius: 4, fontWeight: 600,
                  background: isCurrentlyReal ? 'rgba(0,230,118,0.1)' : 'rgba(0,168,255,0.1)',
                  color: isCurrentlyReal ? 'var(--success)' : 'var(--amber)',
                }}>{sourceLabel}</span>
              </div>
            ) : (
              <div style={{ color: 'var(--crimson)', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                <AlertTriangle size={14} /> Switch to {sourceLabel}
              </div>
            )}
          </div>

          {/* Arrow */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ArrowRight size={24} color="var(--cyan)" />
          </div>

          {/* Target Account */}
          <div style={{ background: 'var(--bg-primary)', padding: 16, borderRadius: 8, border: '1px solid var(--border)' }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', display: 'block', marginBottom: 8, letterSpacing: '0.5px' }}>Target ({targetLabel})</span>
            <select
              value={targetAccountId}
              onChange={(e) => setTargetAccountId(e.target.value)}
              disabled={engineState.active || targetList.length === 0}
              className="font-data"
              style={{
                width: '100%', background: 'var(--bg-card)', border: '1px solid var(--border)',
                borderRadius: 4, padding: '8px 12px', color: 'var(--text-primary)',
                outline: 'none', fontSize: 13
              }}
            >
              {targetList.length === 0 && <option value="">No {targetLabel} accounts</option>}
              {targetList.map(a => (
                <option key={a.id} value={a.id}>{a.loginid} - {a.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Warning for Demo→Real */}
        {direction === 'demo_to_real' && (
          <div style={{
            padding: '12px 16px', borderRadius: 8, marginBottom: 20,
            background: 'rgba(255, 68, 79, 0.06)', border: '1px solid rgba(255, 68, 79, 0.2)',
            display: 'flex', alignItems: 'flex-start', gap: 10,
          }}>
            <AlertTriangle size={16} color="var(--crimson)" style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              <strong style={{ color: 'var(--crimson)' }}>Caution:</strong> Demo→Real will replicate trades onto your real money account. Ensure you understand the risks. Trades will use the same stake amount.
              {scope !== 'synthetic' && (
                <span style={{ color: 'var(--amber)', display: 'block', marginTop: 4 }}>
                  ⚠️ Real Market trades (Rise/Fall, Accumulators) will also be copied to the target account.
                </span>
              )}
            </div>
          </div>
        )}

        {/* Controls */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: 20, flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 10, height: 10, borderRadius: '50%',
              background: engineState.status === 'authorized' ? 'var(--success)' : engineState.status === 'error' ? 'var(--crimson)' : 'var(--text-muted)'
            }} />
            <span style={{ fontSize: 13, fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
              Status: <span style={{ color: engineState.status === 'authorized' ? 'var(--success)' : 'var(--text-primary)' }}>{engineState.status}</span>
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', padding: '2px 8px', borderRadius: 4, background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)' }}>
              {scope === 'both' ? 'SYN + REAL' : scope === 'synthetic' ? 'SYN ONLY' : 'REAL ONLY'}
            </span>
          </div>

          <button
            onClick={handleToggle}
            disabled={!sourceIsCorrect && !engineState.active}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '12px 24px', borderRadius: 8, border: 'none',
              background: engineState.active ? 'var(--crimson)' : 'var(--amber)',
              color: '#000', fontWeight: 700, fontSize: 13, cursor: 'pointer',
              opacity: (!sourceIsCorrect && !engineState.active) ? 0.5 : 1,
              transition: 'all 0.2s',
              boxShadow: engineState.active ? '0 4px 15px rgba(255,68,79,0.3)' : '0 4px 15px rgba(0,168,255,0.3)'
            }}
          >
            {engineState.active ? (
              <><StopCircle size={18} /> STOP COPYING</>
            ) : (
              <><PlayCircle size={18} /> START COPYTRADE</>
            )}
          </button>
        </div>
      </div>

      {/* Copytrade Logs */}
      <div style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 12, padding: 20, minHeight: 250, display: 'flex', flexDirection: 'column'
      }}>
        <h3 style={{
          fontSize: 13, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase',
          marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--border)', paddingBottom: 12
        }}>
          <RefreshCw size={14} style={{ animation: engineState.active ? 'spin 2s linear infinite' : 'none', color: engineState.active ? 'var(--amber)' : 'inherit' }} />
          Replication Logs
        </h3>
        <div className="font-data" style={{ flex: 1, overflowY: 'auto', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {logs.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', marginTop: 40, fontStyle: 'italic' }}>
              Engine idle. Start copying to see logs...
            </div>
          ) : (
            logs.map((log, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>[{log.time.toLocaleTimeString()}]</span>
                <span style={{ color: log.msg.includes('❌') ? 'var(--crimson)' : log.msg.includes('✅') ? 'var(--success)' : 'inherit' }}>
                  {log.msg}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

