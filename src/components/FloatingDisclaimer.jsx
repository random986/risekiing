import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AlertTriangle, X } from 'lucide-react';

export default function FloatingDisclaimer() {
  const [isOpen, setIsOpen] = useState(false);
  const location = useLocation();
  const isReal = location.pathname === '/real-markets';
  
  const themeColor = isReal ? 'var(--amber)' : 'var(--crimson)';
  const title = isReal ? 'Real Markets Risk Disclaimer' : 'Synthetic Markets Risk Disclaimer';
  const desc1 = isReal 
    ? 'Trading real financial markets (Forex, Commodities, OTC) involves a significant level of risk and may not be suitable for all investors. The high degree of leverage can work against you as well as for you. Before deciding to trade, you should carefully consider your investment objectives, level of experience, and risk appetite.'
    : 'Trading synthetic indices involves a significant level of risk and may not be suitable for all investors. The high degree of leverage and automated digit trading can work against you as well as for you. Before deciding to trade, you should carefully consider your investment objectives, level of experience, and risk appetite.';

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        style={{
          position: 'fixed',
          bottom: 24,
          left: 24,
          background: themeColor,
          color: '#fff',
          padding: '8px 12px',
          borderRadius: '6px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          fontWeight: 700,
          border: 'none',
          cursor: 'pointer',
          zIndex: 40,
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)'
        }}
      >
        <AlertTriangle size={14} />
        <span>RISK DISCLAIMER</span>
      </button>

      {isOpen && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.8)',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24
        }}>
          <div style={{
            background: 'var(--bg-card)',
            padding: 32,
            borderRadius: 12,
            maxWidth: 500,
            width: '100%',
            position: 'relative'
          }}>
            <button
              onClick={() => setIsOpen(false)}
              style={{
                position: 'absolute', top: 16, right: 16,
                background: 'transparent', border: 'none',
                color: 'var(--text-primary)', cursor: 'pointer'
              }}
            >
              <X size={24} />
            </button>
            <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 16, color: themeColor }}>{title}</h2>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 16 }}>
              {desc1}
            </p>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 24 }}>
              The possibility exists that you could sustain a loss of some or all of your initial investment and therefore you should not invest 
              money that you cannot afford to lose. You should be aware of all the risks associated with trading, and seek advice from an 
              independent financial advisor if you have any doubts.
            </p>
            <button
              onClick={() => setIsOpen(false)}
              style={{
                background: themeColor,
                color: '#fff',
                padding: '12px 24px',
                borderRadius: 8,
                border: 'none',
                fontWeight: 700,
                cursor: 'pointer',
                width: '100%'
              }}
            >
              I UNDERSTAND
            </button>
          </div>
        </div>
      )}
    </>
  );
}
