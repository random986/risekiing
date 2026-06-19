/* ═══ Preloader — Disclaimer (first visit) + market warmup (every load) ═══ */
import { useState, useEffect, useRef } from 'react';
import useAccountStore from '../store/useAccountStore';
import useConnectionStore from '../store/useConnectionStore';
import { connectAndWarmMarkets } from '../lib/marketWarmup';
import { MARKET_LABELS } from '../lib/marketScanner';

const DISCLAIMER_KEY = 'derivprinter_disclaimer_accepted';

const RISK_ITEMS = [
  { icon: '⚠️', title: 'Capital at risk', text: 'Never stake money you cannot afford to lose. Synthetic indices can wipe balances quickly.' },
  { icon: '📉', title: 'Martingale escalation', text: 'Recovery stakes multiply after losses. Circuit breakers limit steps — set stop-loss in Settings.' },
  { icon: '🎲', title: 'RNG digits', text: 'Outcomes are hardware-random. Short streaks can cluster; long-run edge is limited by the ~5% spread.' },
  { icon: '🛡️', title: 'Session guards', text: 'Rolling win-rate pause, cascade freeze, and recovery gates protect against tilt trading.' },
];

function phaseLabel(phase, status, warmed, total) {
  if (phase === 'connect') {
    if (status === 'connecting') return 'Connecting to Deriv…';
    if (status === 'connected') return 'Authenticating session…';
    if (status === 'authorized') return 'Session authorized';
    return 'Establishing secure connection…';
  }
  if (phase === 'history') return `Prefetching tick history · ${warmed}/${total} markets`;
  if (phase === 'analysis') return `Running digit counter & distribution analysis · ${warmed}/${total} ready`;
  if (phase === 'skip') return 'No saved account — connect after login to warm markets';
  return 'Initializing risk engine…';
}

export default function Preloader({ onAccept }) {
  const [fadeOut, setFadeOut] = useState(false);
  const [visible, setVisible] = useState(true);
  const [screen, setScreen] = useState('disclaimer'); // disclaimer | warmup
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('Initializing…');
  const [currentMarket, setCurrentMarket] = useState('');
  const warmupStarted = useRef(false);

  const accounts = useAccountStore(s => s.accounts);
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const setStatus = useConnectionStore(s => s.setStatus);

  useEffect(() => {
    const accepted = localStorage.getItem(DISCLAIMER_KEY);
    if (accepted === 'true') {
      setScreen('warmup');
    }
  }, []);

  useEffect(() => {
    if (screen !== 'warmup' || warmupStarted.current) return;
    warmupStarted.current = true;

    const activeAcc = accounts.find(a => a.id === activeAccountId)
      || accounts.find(a => a.is_virtual || a.loginid?.startsWith('VR'))
      || accounts[0];

    const finish = () => {
      setProgress(100);
      setStatusText('Analysis ready — opening terminal…');
      setFadeOut(true);
      setTimeout(() => {
        setVisible(false);
        onAccept();
      }, 600);
    };

    if (!activeAcc?.token) {
      setProgress(100);
      setStatusText('Ready — log in to prefetch live market data');
      setTimeout(finish, 1200);
      return;
    }

    connectAndWarmMarkets(activeAcc, {
      timeoutMs: 40000,
      onStatusChange: setStatus,
      onProgress: (p) => {
        if (p.phase === 'connect') {
          const base = p.status === 'authorized' ? 15 : p.status === 'connected' ? 8 : 4;
          setProgress(base);
          setStatusText(phaseLabel('connect', p.status));
        } else if (p.phase === 'history') {
          const histPct = 15 + Math.round((p.done || p.warmed || 0) / (p.total || 15) * 55);
          setProgress(Math.min(70, histPct));
          if (p.symbol) setCurrentMarket(MARKET_LABELS[p.symbol] || p.symbol);
          setStatusText(phaseLabel('history', null, p.warmed, p.total));
        } else if (p.phase === 'analysis') {
          const anaPct = 70 + Math.round((p.tickPct || 0) * 0.28);
          setProgress(Math.min(98, anaPct));
          setStatusText(phaseLabel('analysis', null, p.warmed, p.total));
        } else if (p.phase === 'skip') {
          setProgress(100);
          setStatusText(p.message);
        }
      },
    }).then((result) => {
      if (result.ok || result.skipped || result.timedOut) finish();
      else {
        setStatusText('Connection issue — opening with partial data…');
        setTimeout(finish, 800);
      }
    });
  }, [screen, accounts, activeAccountId, onAccept, setStatus]);

  const handleAccept = () => {
    localStorage.setItem(DISCLAIMER_KEY, 'true');
    setScreen('warmup');
  };

  if (!visible) return null;

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'linear-gradient(145deg, #0a0a0a 0%, #141428 50%, #0a0a0a 100%)',
      zIndex: 99999,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '32px 24px',
      overflowY: 'auto',
      opacity: fadeOut ? 0 : 1,
      transition: 'opacity 0.5s ease-out'
    }}>
      <style>{`
        @keyframes preloaderPulse {
          0%, 100% { transform: scale(1); opacity: 0.9; }
          50% { transform: scale(1.05); opacity: 1; }
        }
        @keyframes barShimmer {
          0% { background-position: -200% center; }
          100% { background-position: 200% center; }
        }
      `}</style>

      {/* Logo */}
      <div style={{
        width: 88, height: 88, borderRadius: 20,
        overflow: 'hidden', marginBottom: 16,
        animation: 'preloaderPulse 2s ease-in-out infinite',
        boxShadow: '0 0 48px rgba(255, 68, 79, 0.25)'
      }}>
        <img src="./logo.png" alt="Derivprinter Logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      </div>

      <h1 style={{
        fontSize: 28, fontWeight: 800, color: '#fff',
        fontFamily: "'Syne', sans-serif",
        marginBottom: 4, letterSpacing: '-0.5px'
      }}>
        Derivprinter
      </h1>
      <p style={{
        fontSize: 11, color: 'rgba(255,255,255,0.45)',
        marginBottom: 24, letterSpacing: '2px', textTransform: 'uppercase'
      }}>
        {screen === 'disclaimer' ? 'Risk Acknowledgement Required' : 'Market Analysis Preloader'}
      </p>

      {screen === 'disclaimer' ? (
        <>
          <div style={{
            maxWidth: 480, width: '100%',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 16, padding: '24px 22px',
            backdropFilter: 'blur(12px)'
          }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, color: '#ff444f', marginBottom: 14 }}>
              ⚠️ Risk Disclaimer
            </h2>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.7 }}>
              <p style={{ marginBottom: 10 }}>
                <strong style={{ color: '#fff' }}>Trading involves significant risk of loss.</strong> Synthetic indices carry high risk and can result in the loss of all funds.
              </p>
              <p style={{ marginBottom: 10 }}>
                Automated strategies including Martingale can amplify losses. This software is provided &quot;as is&quot; without warranty.
              </p>
              <p style={{ marginBottom: 0 }}>
                By proceeding you confirm legal age, understand the risks, and accept full responsibility for your trading activity.
              </p>
            </div>
          </div>
          <button
            onClick={handleAccept}
            style={{
              marginTop: 20, background: 'linear-gradient(135deg, #ff444f 0%, #ff6b74 100%)',
              color: '#fff', border: 'none', borderRadius: 12,
              padding: '14px 40px', fontSize: 14, fontWeight: 700, cursor: 'pointer',
              boxShadow: '0 8px 32px rgba(255, 68, 79, 0.3)',
            }}
          >
            I UNDERSTAND & AGREE
          </button>
        </>
      ) : (
        <>
          {/* Risk management panel */}
          <div style={{
            maxWidth: 520, width: '100%',
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: 14, padding: '18px 20px', marginBottom: 20,
          }}>
            <h2 style={{ fontSize: 13, fontWeight: 700, color: '#00e5ff', marginBottom: 14, letterSpacing: '0.5px' }}>
              🛡️ Risk Management Active
            </h2>
            <div style={{ display: 'grid', gap: 10 }}>
              {RISK_ITEMS.map(item => (
                <div key={item.title} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <span style={{ fontSize: 16, lineHeight: 1.4 }}>{item.icon}</span>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', marginBottom: 2 }}>{item.title}</div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', lineHeight: 1.5 }}>{item.text}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Loading bar */}
          <div style={{ maxWidth: 520, width: '100%', marginBottom: 12 }}>
            <div style={{
              height: 6, borderRadius: 3,
              background: 'rgba(255,255,255,0.08)',
              overflow: 'hidden'
            }}>
              <div style={{
                height: '100%', width: `${progress}%`,
                borderRadius: 3,
                background: 'linear-gradient(90deg, #ff444f, #00e5ff, #ff444f)',
                backgroundSize: '200% 100%',
                animation: progress < 100 ? 'barShimmer 1.5s linear infinite' : 'none',
                transition: 'width 0.4s ease-out',
              }} />
            </div>
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              marginTop: 8, fontSize: 11, color: 'rgba(255,255,255,0.45)'
            }}>
              <span>{statusText}</span>
              <span>{progress}%</span>
            </div>
            {currentMarket && progress < 100 && (
              <div style={{ fontSize: 10, color: 'rgba(0,229,255,0.6)', marginTop: 4 }}>
                Last: {currentMarket}
              </div>
            )}
          </div>

          <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginTop: 8, textAlign: 'center', maxWidth: 400 }}>
            Prefetching 15 synthetic indices · digit buffers · distribution bias · convergence scores
          </p>
        </>
      )}

      <p style={{ marginTop: 'auto', paddingTop: 16, fontSize: 10, color: 'rgba(255,255,255,0.25)' }}>
        © {new Date().getFullYear()} Derivprinter
      </p>
    </div>
  );
}
