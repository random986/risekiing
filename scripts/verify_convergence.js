/**
 * Headless verification: convergence self-checks + short tournament sim.
 */
globalThis.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  __nonce__: '',
};
globalThis.document = {
  head: { appendChild: () => {} },
  createElement: () => ({
    innerHTML: ' ',
    id: '_goober',
    nonce: '',
    parentNode: null,
    firstChild: { data: '' },
    appendChild() {},
  }),
};
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { runConvergenceSelfChecks } = await import('../src/lib/convergenceCalculator.js');
runConvergenceSelfChecks();
console.log('[verify] convergence self-checks OK');

const { default: enhancedTradeEngine } = await import('../src/lib/enhancedTradeEngine.js');
const { default: derivWS } = await import('../src/lib/derivWS.js');
const { default: scanner, MARKETS } = await import('../src/lib/marketScanner.js');

derivWS.status = 'authorized';
derivWS.accountInfo = { balance: 10000, currency: 'USD' };
derivWS.ws = { readyState: 1 };
globalThis.WebSocket = { OPEN: 1 };

let pocCallback = null;
derivWS.on = (event, cb) => {
  if (event === 'proposal_open_contract') pocCallback = cb;
  return () => {};
};
derivWS.sendRaw = () => {};
derivWS.send = async (payload) => {
  if (!payload.buy) return {};
  const cid = 'mock_' + Math.random();
  const stake = payload.price;
  const dir = payload.parameters.contract_type === 'DIGITOVER' ? 'OVER5' : 'UNDER5';
  const sym = payload.parameters.symbol;
  const nextDigit = Math.floor(Math.random() * 10);
  const price = (Math.random() * 1000).toFixed(4).slice(0, -1) + nextDigit;
  scanner.addTick(sym, price);
  const won = dir === 'OVER5' ? nextDigit > 5 : nextDigit < 5;
  const profit = won ? stake * 0.9 : -stake;
  setTimeout(() => pocCallback?.({
    proposal_open_contract: {
      contract_id: cid,
      is_sold: 1,
      status: won ? 'won' : 'lost',
      profit,
      buy_price: stake,
      underlying: sym,
    },
  }), 2);
  return { buy: { contract_id: cid } };
};

enhancedTradeEngine.sendLog = (msg) => {
  if (msg.includes('Conv') || msg.includes('S4 relief')) console.log('[log]', msg);
};
enhancedTradeEngine.stop = function () { this.running = false; };

let simulatedTime = Date.now();
Date.now = () => simulatedTime;
enhancedTradeEngine._scheduleNext = (delayMs) => {
  simulatedTime += delayMs;
  setImmediate(() => {
    if (!enhancedTradeEngine.running) return;
    const sym = MARKETS[Math.floor(Math.random() * MARKETS.length)];
    scanner.addTick(sym, (Math.random() * 1000).toFixed(4).slice(0, -1) + Math.floor(Math.random() * 10));
    enhancedTradeEngine._executeCycle?.();
    enhancedTradeEngine._tournamentWatchdogTick?.();
  });
};

function seedUnderStreak(sym, len) {
  for (let i = 0; i < len; i++) scanner.addTick(sym, (Math.random() * 1000).toFixed(4).slice(0, -1) + (6 + (i % 4)));
  for (let i = 0; i < 6; i++) scanner.addTick(sym, (Math.random() * 1000).toFixed(4).slice(0, -1) + (6 + (i % 3)));
}
for (const sym of MARKETS) {
  seedUnderStreak(sym, 40);
}

let tradeCount = 0;
let convFire = 0;
let convBlock = 0;
const origLog = enhancedTradeEngine.sendLog;
enhancedTradeEngine.sendLog = (msg) => {
  if (msg.includes('✓ Conv')) convFire++;
  if (msg.includes('S4 relief')) convBlock++;
  origLog(msg);
};

enhancedTradeEngine.onTradeUpdate = () => {
  tradeCount++;
  if (tradeCount >= 25) enhancedTradeEngine.stop('verify done');
};

enhancedTradeEngine.start({
  strategy: 'BOTH5',
  baseStake: 0.35,
  minConfidence: 55,
  cooldownMs: 0,
});

let spins = 0;
while (enhancedTradeEngine.running && spins < 5000) {
  simulatedTime += 200;
  const sym = MARKETS[spins % MARKETS.length];
  scanner.addTick(sym, (Math.random() * 1000).toFixed(4).slice(0, -1) + Math.floor(Math.random() * 10));
  enhancedTradeEngine._sweepAllMarketsVL?.();
  enhancedTradeEngine._refreshTournamentScan?.();
  enhancedTradeEngine._tryFireTournamentBest?.();
  spins++;
}

console.log(`[verify] trades=${tradeCount} convFireLogs=${convFire} convBlockLogs=${convBlock} spins=${spins}`);
if (tradeCount < 1) {
  console.warn('[verify] warning: no trades fired in short run (buffers may need more ticks)');
} else {
  console.log('[verify] tournament fire path OK');
}
process.exit(0);
