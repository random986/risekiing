import React from 'react';

const STRIP_HEIGHT = 44;

export const DEV_MARQUEE_HEIGHT = STRIP_HEIGHT;

const MESSAGE =
  '🛠️ SYSTEM NOTICE: THE APPLICATION IS CURRENTLY IN DEVELOPMENT MODE. PLEASE TRY AND LEAVE DETAILED FEEDBACK OR USER COMMENTS IN OUR TIKTOK APP. ' +
  '🛑 RISK DISCLAIMER: BINARY DIGIT TRADING INVOLVES EXTREME VOLATILITY. OVER-TRADING LEADS TO RAPID LOSSES. TRADE AT YOUR OWN RISK. ' +
  '⚙️ OPERATIONAL METHODOLOGY: RE-ENGINEERED WITH O(1) LINEAR SCANNERS MATRIX ACROSS 15 SYNTHETIC INDEX FEEDS TO ELIMINATE PROCESSING BACKLOGS AND CHERRY-PICK TRADES INSTANTLY. ';

export default function DevMarqueeStrip() {
  return (
    <div style={stripShellStyle}>
      <div style={trackStyle}>
        <span style={textStyle}>{MESSAGE}</span>
        <span style={textStyle} aria-hidden="true">{MESSAGE}</span>
      </div>

      <style>{`
        @keyframes customMarqueeScroll {
          0% { transform: translate3d(0, 0, 0); }
          100% { transform: translate3d(-50%, 0, 0); }
        }
      `}</style>
    </div>
  );
}

const stripShellStyle = {
  background: '#070a13',
  borderBottom: '1px solid #ff444f',
  padding: '12px 0',
  position: 'fixed',
  top: 0,
  left: 0,
  width: '100%',
  height: STRIP_HEIGHT,
  boxSizing: 'border-box',
  zIndex: 999999,
  overflow: 'hidden',
  display: 'flex',
  alignItems: 'center',
};

const trackStyle = {
  display: 'flex',
  width: 'max-content',
  animation: 'customMarqueeScroll 35s linear infinite',
};

const textStyle = {
  display: 'inline-block',
  whiteSpace: 'nowrap',
  fontSize: '12px',
  fontFamily: "'JetBrains Mono', monospace",
  color: '#e2e8f0',
  fontWeight: '600',
  letterSpacing: '0.5px',
  paddingRight: '60px',
};
