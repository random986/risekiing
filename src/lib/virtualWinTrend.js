/**
 * Session-wide virtual win rates — Even/Odd vs Over/Under families across all 15 feeds.
 */
import { MARKETS } from './marketScanner.js';
import { isVirtualLossTick } from './convergenceCalculator.js';

const DEFAULT_WINDOW = 30;

/** @type {{ evenOdd: { winPct: number, wins: number, samples: number }, overUnder: { winPct: number, wins: number, samples: number }, leader: 'evenOdd'|'overUnder'|'tie', margin: number, updatedAt: number }} */
export const globalVirtualWinTrend = {
  evenOdd: { winPct: 50, wins: 0, samples: 0 },
  overUnder: { winPct: 50, wins: 0, samples: 0 },
  leader: 'tie',
  margin: 0,
  updatedAt: 0,
};

function simulateMeanReversion(ticks, lookback) {
  let eoWins = 0, eoLosses = 0;
  let ouWins = 0, ouLosses = 0;
  
  if (ticks.length <= lookback) return { eoWins, eoLosses, ouWins, ouLosses };

  for (let i = lookback; i < ticks.length; i++) {
    // Look back window
    let evens = 0, odds = 0;
    let overs = 0, unders = 0;
    
    for (let j = i - lookback; j < i; j++) {
      const d = Number(ticks[j]);
      if (Number.isNaN(d)) continue;
      if (d % 2 === 0) evens++; else odds++;
      if (d >= 5) overs++; else unders++;
    }
    
    const curr = Number(ticks[i]);
    if (Number.isNaN(curr)) continue;
    
    // EO Prediction (Mean Reversion)
    if (evens > odds) {
      // Predict ODD
      if (curr % 2 !== 0) eoWins++; else eoLosses++;
    } else if (odds > evens) {
      // Predict EVEN
      if (curr % 2 === 0) eoWins++; else eoLosses++;
    }
    
    // OU Prediction (Mean Reversion)
    if (overs > unders) {
      // Predict UNDER5
      if (curr < 5) ouWins++; else ouLosses++;
    } else if (unders > overs) {
      // Predict OVER5
      if (curr >= 5) ouWins++; else ouLosses++;
    }
  }
  
  return { eoWins, eoLosses, ouWins, ouLosses };
}

export function computeVirtualWinTrend(marketBuffers, windowSize = 30) {
  let totalEoWins = 0, totalEoLosses = 0;
  let totalOuWins = 0, totalOuLosses = 0;

  for (const sym of MARKETS) {
    const ticks = marketBuffers[sym] || [];
    // We run the simulation on the recent ticks (up to 200 ticks to avoid lag, but get enough data)
    const recentTicks = ticks.slice(-150); 
    const result = simulateMeanReversion(recentTicks, windowSize);
    totalEoWins += result.eoWins;
    totalEoLosses += result.eoLosses;
    totalOuWins += result.ouWins;
    totalOuLosses += result.ouLosses;
  }

  const eoSamples = totalEoWins + totalEoLosses;
  const ouSamples = totalOuWins + totalOuLosses;

  const eoPct = eoSamples > 0 ? Math.round((totalEoWins / eoSamples) * 1000) / 10 : 50;
  const ouPct = ouSamples > 0 ? Math.round((totalOuWins / ouSamples) * 1000) / 10 : 50;
  const margin = Math.abs(eoPct - ouPct);
  
  let leader = 'tie';
  if (eoPct > ouPct + 0.1) leader = 'evenOdd';
  else if (ouPct > eoPct + 0.1) leader = 'overUnder';

  globalVirtualWinTrend.evenOdd = { winPct: eoPct, wins: totalEoWins, samples: eoSamples };
  globalVirtualWinTrend.overUnder = { winPct: ouPct, wins: totalOuWins, samples: ouSamples };
  globalVirtualWinTrend.leader = leader;
  globalVirtualWinTrend.margin = margin;
  globalVirtualWinTrend.updatedAt = Date.now();

  return globalVirtualWinTrend;
}

export function computeVirtualWinTrendFromMap(marketDataMap, windowSize = 30) {
  const buffers = {};
  for (const sym of Object.keys(marketDataMap || {})) {
    buffers[sym] = marketDataMap[sym]?.history || marketDataMap[sym] || [];
  }
  return computeVirtualWinTrend(buffers, windowSize);
}
