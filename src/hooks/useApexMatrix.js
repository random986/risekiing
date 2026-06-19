/**
 * React hook — 15-market apex matrix leaderboard on every scanner tick.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import scanner, { MARKETS } from '../lib/marketScanner.js';
import { runMatrixSweep, isApexOrderInFlight } from '../lib/apexMatrixEngine.js';

function buffersFromScanner() {
  const out = {};
  for (const sym of MARKETS) {
    out[sym] = scanner.buffers[sym] || [];
  }
  return out;
}

/**
 * @param {string} strategy BOTH5 | BOTH | OU_WINNING | EO_WINNING
 * @param {boolean} enabled
 */
export function useApexMatrix(strategy = 'BOTH5', enabled = true) {
  const [leaderboard, setLeaderboard] = useState([]);
  const [apex, setApex] = useState(null);
  const [orderInFlight, setOrderInFlight] = useState(false);
  const strategyRef = useRef(strategy);

  strategyRef.current = strategy;

  const refresh = useCallback(() => {
    const sweep = runMatrixSweep(buffersFromScanner(), strategyRef.current);
    setLeaderboard(sweep.leaderboard);
    setApex(sweep.apex);
    setOrderInFlight(isApexOrderInFlight());
    return sweep;
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;

    const unsub = scanner.onUpdate(() => {
      refresh();
    });

    refresh();
    const id = setInterval(() => setOrderInFlight(isApexOrderInFlight()), 400);

    return () => {
      unsub();
      clearInterval(id);
    };
  }, [enabled, refresh]);

  return {
    leaderboard,
    apex,
    orderInFlight,
    refresh,
    candidateCount: leaderboard.length,
  };
}
