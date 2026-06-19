import React from 'react';

const BANNER_HEIGHT = 36;

export const DEV_BANNER_HEIGHT = BANNER_HEIGHT;

export default function DevBanner() {
  return (
    <div style={bannerStyle}>
      <div style={marqueeContainerStyle}>
        <div style={marqueeTextStyle}>
          ⚠️ <span style={highlightText}>PRODUCT UNDER DEVELOPMENT:</span> PLEASE TRY WITH A DEMO ACCOUNT BEFORE ADDING IN YOUR REAL MONEY. LEAVE FEEDBACK ON OUR TIKTOK APP.
          {' '}
          🛑 <span style={riskText}>RISK DISCLAIMER:</span> OVER-TRADING LEADS TO SEVERE LOSSES. TRADE AT YOUR OWN RISK.
          {' '}
          ⚡ <span style={infoText}>OPERATION:</span> THE TERMINAL SIMULTANEOUSLY SCANS 15 MARKETS ACROSS ALL STRATEGIES TO CHERRY-PICK THE HIGHEST PROBABILITY ANOMALY EVERY SECOND.
        </div>
      </div>

      <style>{`
        @keyframes derivprinter-marquee {
          0% { transform: translate3d(100%, 0, 0); }
          100% { transform: translate3d(-100%, 0, 0); }
        }
      `}</style>
    </div>
  );
}

const bannerStyle = {
  background: '#1a1f2c',
  borderBottom: '1px solid #ff444f',
  padding: '8px 0',
  overflow: 'hidden',
  position: 'fixed',
  top: 0,
  left: 0,
  width: '100%',
  zIndex: 9999,
  height: BANNER_HEIGHT,
  boxSizing: 'border-box',
};

const marqueeContainerStyle = {
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  display: 'flex',
  height: '100%',
  alignItems: 'center',
};

const marqueeTextStyle = {
  display: 'inline-block',
  paddingLeft: '100%',
  animation: 'derivprinter-marquee 25s linear infinite',
  fontSize: '13px',
  fontFamily: "'JetBrains Mono', monospace",
  color: '#e2e8f0',
  fontWeight: '500',
  letterSpacing: '0.5px',
};

const highlightText = { color: '#ffbd2e', fontWeight: 'bold' };
const riskText = { color: '#ff444f', fontWeight: 'bold' };
const infoText = { color: '#00dc82', fontWeight: 'bold' };
