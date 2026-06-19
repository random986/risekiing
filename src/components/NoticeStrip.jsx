import React from 'react';
import { useLocation } from 'react-router-dom';

const STRIP_HEIGHT = 44;

export const NOTICE_STRIP_HEIGHT = STRIP_HEIGHT;

const SYNTHETIC_MESSAGE =
  '🛑 RISK WARNING (SYNTHETIC MARKETS): SYNTHETIC DIGIT OVER-TRADING LEADS TO RAPID LOSSES. TRADE AT YOUR OWN RISK. ' +
  '💻 ENGINE STATUS: VL TOURNAMENT ON SYNTHETIC VOLATILITY · MARTINGALE STAKE LADDER · POST-LOSS = SAME ENTRY RULES + PAUSE. ' +
  '🌐 DERIVPRINTER TERMINAL: MULTI-MARKET ALGORITHMIC EXECUTION FOR SYNTHETIC AND REAL PORTFOLIOS. ';

const REAL_MESSAGE =
  '🛑 RISK WARNING (REAL MARKETS): TRADING REAL FINANCIAL ASSETS (FOREX & OTC INDEX OPTIONS) INVOLVES SIGNIFICANT MARKET VOLATILITY AND LEVERAGE RISKS. ' +
  '💻 ENGINE STATUS: REAL-TIME INDEPENDENT SIFTING ENGINE ACTIVE ON 10 MAJOR FOREX pairs & OTC MARKETS · MCS FILTER APPLIED · 30-MIN STREAK GATES ACTIVE. ' +
  '🌐 DERIVPRINTER TERMINAL: DYNAMIC REGIME-SWITCHING MULTI-FLIGHT SYSTEM FOR END-TO-END TRADING LOOP. ';

export default function NoticeStrip() {
  const location = useLocation();
  const isReal = location.pathname === '/real-markets';
  
  const MESSAGE = isReal ? REAL_MESSAGE : SYNTHETIC_MESSAGE;
  const shellColor = isReal ? '#00c853' : '#ff444f'; // Green for Real, Red for Synthetic

  return (
    <div style={{ ...shellStyle, background: shellColor }}>
      <div style={trackStyle}>
        <span style={textStyle}>{MESSAGE}</span>
        <span style={textStyle} aria-hidden="true">{MESSAGE}</span>
      </div>

      <style>{`
        @keyframes linearMarquee {
          0% { transform: translate3d(0, 0, 0); }
          100% { transform: translate3d(-50%, 0, 0); }
        }
      `}</style>
    </div>
  );
}

const shellStyle = {
  padding: '12px 0',
  position: 'fixed',
  top: 0,
  left: 0,
  width: '100%',
  height: STRIP_HEIGHT,
  boxSizing: 'border-box',
  zIndex: 9999,
  overflow: 'hidden',
  display: 'flex',
  alignItems: 'center',
};

const trackStyle = {
  display: 'flex',
  width: 'max-content',
  animation: 'linearMarquee 32s linear infinite',
};

const textStyle = {
  display: 'inline-block',
  whiteSpace: 'nowrap',
  fontSize: '11px',
  fontFamily: "'JetBrains Mono', monospace",
  color: '#ffffff',
  fontWeight: '700',
  letterSpacing: '0.5px',
  paddingRight: '60px',
};
