/**
 * Shared market prefetch — connect WS, seed tick history, register live handler.
 * Used by the startup preloader and Header reconnect flow.
 */
import derivWS from './derivWS';
import scanner, { MARKETS, APEX_TICK_CAP } from './marketScanner';

export const WARMUP_MIN_TICKS = 30;
export const WARMUP_TARGET_TICKS = 150; // Massively speeds up loading screen compared to 1000

let tickHandlerRegistered = false;

export function getWarmupProgress(minTicks = WARMUP_MIN_TICKS) {
  const counts = MARKETS.map(s => scanner.buffers[s]?.length || 0);
  const warmed = counts.filter(c => c >= minTicks).length;
  const total = MARKETS.length;
  const tickPct = Math.min(
    100,
    Math.round((counts.reduce((a, b) => a + b, 0) / (total * WARMUP_TARGET_TICKS)) * 100)
  );
  return { warmed, total, tickPct, counts, minTicks };
}

export function isScannerWarmed(minTicks = WARMUP_MIN_TICKS) {
  return MARKETS.every(s => (scanner.buffers[s]?.length || 0) >= minTicks);
}

export function registerMarketTickHandler() {
  if (tickHandlerRegistered) return;
  derivWS.on('tick', (msg) => {
    if (msg.tick) scanner.addTick(msg.tick.symbol, msg.tick.quote, msg.tick.pip_size);
  });
  tickHandlerRegistered = true;
  if (typeof window !== 'undefined') window.__tickHandlerRegistered = true;
}

async function fetchHistoryForSymbol(sym) {
  const res = await derivWS.send({
    ticks_history: sym,
    end: 'latest',
    count: WARMUP_TARGET_TICKS,
    style: 'ticks',
  });
  if (res.history?.prices) {
    const pipSize = res.pip_size;
    const prices = res.history.prices.slice(-WARMUP_TARGET_TICKS);
    prices.forEach(p => scanner.addTick(sym, p, pipSize));
  }
  return sym;
}

/** Seed buffers when WS is already authorized (Header reconnect). */
export async function seedMarketHistory({ onProgress } = {}) {
  registerMarketTickHandler();
  derivWS.subscribeAllMarkets(MARKETS);
  let done = 0;
  await Promise.all(
    MARKETS.map(sym =>
      fetchHistoryForSymbol(sym).then(() => {
        done++;
        onProgress?.({ phase: 'history', ...getWarmupProgress(), symbol: sym, done });
      }).catch(err => {
        console.error(`History fetch error [${sym}]:`, err);
        done++;
        onProgress?.({ phase: 'history', ...getWarmupProgress(), symbol: sym, done, error: true });
      })
    )
  );
  await sweepVLAfterPreload();
  return getWarmupProgress();
}

/** After history seed, warm VL state if tournament bot is already running. */
async function sweepVLAfterPreload() {
  try {
    const mod = await import('./enhancedTradeEngine.js');
    const configMod = await import('../store/useConfigStore.js');
    const engine = mod.default;
    const strategy = configMod.useConfigStore.getState().strategy;
    if (['BOTH', 'BOTH5'].includes(strategy) && engine?.startSyntheticPreview) {
      engine.startSyntheticPreview(strategy);
    } else if (engine?.running && engine._usesTournamentMode?.()) {
      engine._sweepAllMarketsVL();
    }
  } catch {
    /* engine not started yet */
  }
}

/**
 * Connect account, prefetch all 15 markets, wait until analysis-ready.
 * Resolves even on partial warmup (timeout) so the app is never blocked forever.
 */
export function connectAndWarmMarkets(account, {
  onProgress,
  timeoutMs = 15000,
  minTicks = WARMUP_MIN_TICKS,
  onStatusChange,
} = {}) {
  if (!account?.token) {
    onProgress?.({ phase: 'skip', message: 'No account saved — connect in app' });
    return Promise.resolve({ ok: false, skipped: true });
  }

  registerMarketTickHandler();

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (pollTimer) clearInterval(pollTimer);
      resolve(result);
    };

    const hardTimer = setTimeout(() => {
      finish({ ok: isScannerWarmed(Math.max(10, Math.floor(minTicks / 2))), timedOut: true });
    }, timeoutMs);

    derivWS.onStatusChange = (newStatus) => {
      onStatusChange?.(newStatus);
      onProgress?.({ phase: 'connect', status: newStatus });

      if (newStatus === 'authorized') {
        seedMarketHistory({ onProgress }).then(async () => {
          await sweepVLAfterPreload();
          onProgress?.({ phase: 'analysis', message: 'Digit counter & distribution analysis…', ...getWarmupProgress(minTicks) });

          pollTimer = setInterval(() => {
            const prog = getWarmupProgress(minTicks);
            onProgress?.({ phase: 'analysis', ...prog });
            if (isScannerWarmed(minTicks)) finish({ ok: true });
          }, 250);
        });
      }

      if (newStatus === 'error') {
        finish({ ok: false, error: true });
      }
    };

    derivWS.connect(account.token, account.loginid);
  });
}
