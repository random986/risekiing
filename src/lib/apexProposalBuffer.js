/**
 * Pre-approved proposal token buffer — instant buy without waiting for proposal round-trip.
 */

import derivWS from './derivWS.js';

const TTL_MS = 2800;
const cache = new Map();
const inflight = new Set();

function cacheKey(sym, contractType, amount, barrier) {
  return `${sym}:${contractType}:${amount}:${barrier ?? ''}`;
}

export function getBufferedProposal(sym, contractType, amount, barrier) {
  const key = cacheKey(sym, contractType, amount, barrier);
  const row = cache.get(key);
  if (!row) return null;
  if (Date.now() - row.at > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return row;
}

export function consumeBufferedProposal(sym, contractType, amount, barrier) {
  const key = cacheKey(sym, contractType, amount, barrier);
  const row = getBufferedProposal(sym, contractType, amount, barrier);
  if (!row) return null;
  cache.delete(key);
  return row;
}

/**
 * Warm proposal tokens for a symbol (fire-and-forget, non-blocking).
 */
export async function prefetchProposalToken({
  symbol,
  contractType,
  amount,
  barrier,
  currency = 'USD',
}) {
  const key = cacheKey(symbol, contractType, amount, barrier);
  if (inflight.has(key)) return;
  const existing = getBufferedProposal(symbol, contractType, amount, barrier);
  if (existing) return;

  inflight.add(key);
  try {
    if (!derivWS.isReady) return;
    const payload = {
      proposal: 1,
      amount,
      basis: 'stake',
      contract_type: contractType,
      currency,
      duration: 1,
      duration_unit: 't',
      underlying_symbol: symbol,
      priority: 1,
    };
    if (barrier != null && barrier !== undefined) payload.barrier = String(barrier);

    const res = await derivWS.send(payload, { priority: true });
    if (res?.proposal?.id) {
      cache.set(key, {
        id: res.proposal.id,
        price: res.proposal.ask_price,
        at: Date.now(),
      });
    }
  } catch {
    /* ignore prefetch errors */
  } finally {
    inflight.delete(key);
  }
}

/** Prime both EO legs on the loss market during recovery. */
export function warmRecoveryProposals(symbol, baseStake, strategy, currency) {
  const stake = Math.max(0.35, Number(baseStake) || 0.35);
  const isOu = strategy === 'BOTH5' || strategy === 'OU_WINNING';
  if (isOu) {
    void prefetchProposalToken({ symbol, contractType: 'DIGITOVER', amount: stake, barrier: '5', currency });
    void prefetchProposalToken({ symbol, contractType: 'DIGITUNDER', amount: stake, barrier: '5', currency });
  } else {
    void prefetchProposalToken({ symbol, contractType: 'DIGITEVEN', amount: stake, currency });
    void prefetchProposalToken({ symbol, contractType: 'DIGITODD', amount: stake, currency });
  }
}

export function clearProposalBuffer() {
  cache.clear();
}
