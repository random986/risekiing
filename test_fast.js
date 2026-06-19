import enhancedTradeEngine from './src/lib/enhancedTradeEngine.js';
import derivWS from './src/lib/derivWS.js';
import scanner, { MARKETS, MARKET_LABELS } from './src/lib/marketScanner.js';
import fs from 'fs';

console.log("=== RUNNING DETAILED SIMULATOR DIAGNOSTIC ===");

derivWS.status = 'authorized';
derivWS.accountInfo = { balance: 10000.00, currency: 'USD' };
derivWS.ws = { readyState: 1 };
globalThis.WebSocket = { OPEN: 1 };

let pocCallback = null;
derivWS.on = (event, callback) => {
  console.log(`[derivWS.on] Registered handler for: ${event}`);
  if (event === 'proposal_open_contract') {
    pocCallback = callback;
  }
  return () => {
    console.log(`[derivWS.on] Unsubscribe called for: ${event}`);
  };
};

function generatePriceWithDigit(digit) {
  return (Math.random() * 1000).toFixed(4).slice(0, -1) + digit;
}

let tickCount = 0;
derivWS.send = async (payload) => {
  console.log(`[derivWS.send] Received payload:`, JSON.stringify(payload));
  if (payload.buy) {
    const cid = 'mock_contract_' + Math.random();
    const stake = payload.price;
    const contractType = payload.parameters.contract_type;
    let direction = 'UNDER5';
    if (contractType === 'DIGITOVER') direction = 'OVER5';
    else if (contractType === 'DIGITUNDER') direction = 'UNDER5';
    else if (contractType === 'DIGITEVEN') direction = 'EVEN';
    else if (contractType === 'DIGITODD') direction = 'ODD';

    const symbol = payload.parameters.symbol;

    const nextDigit = 8; // force OVER so OVER5 wins, UNDER5 loses
    const price = generatePriceWithDigit(nextDigit);
    scanner.addTick(symbol, price);

    let won = false;
    if (direction === 'OVER5') won = nextDigit > 5;
    else if (direction === 'UNDER5') won = nextDigit < 5;
    else if (direction === 'EVEN') won = nextDigit % 2 === 0;
    else if (direction === 'ODD') won = nextDigit % 2 !== 0;

    let profitRate = 0.8857;
    if (direction === 'OVER5') profitRate = 1.3714;
    else if (direction === 'UNDER5') profitRate = 0.8857;
    else if (direction === 'EVEN' || direction === 'ODD') profitRate = 0.96;

    const profit = won ? stake * profitRate : -stake;

    const msg = {
      proposal_open_contract: {
        contract_id: cid,
        is_sold: 1,
        status: won ? 'won' : 'lost',
        profit: won ? parseFloat(profit.toFixed(2)) : -stake,
        buy_price: stake,
        underlying: symbol,
        exit_tick: parseFloat(price),
        exit_tick_display_value: String(nextDigit),
        barrier: '5'
      }
    };

    console.log(`[derivWS.send] Scheduling pocCallback in process.nextTick for cid: ${cid}, won: ${won}`);
    process.nextTick(() => {
      console.log(`[process.nextTick] Triggering pocCallback now...`);
      if (pocCallback) {
        pocCallback(msg);
      } else {
        console.log(`[process.nextTick] WARNING: pocCallback is null!`);
      }
    });

    return { buy: { contract_id: cid } };
  }
  return {};
};

derivWS.sendRaw = (payload) => {
  console.log(`[derivWS.sendRaw] Sent:`, JSON.stringify(payload));
};

let simulatedTime = Date.now();
Date.now = () => simulatedTime;

enhancedTradeEngine._scheduleNext = (delayMs) => {
  console.log(`[_scheduleNext] Delay requested: ${delayMs}ms. Advancing simulated time...`);
  simulatedTime += delayMs;
  
  setImmediate(() => {
    if (enhancedTradeEngine.running) {
      console.log(`[setImmediate] Running next evaluation cycle...`);
      const sym = MARKETS[Math.floor(Math.random() * MARKETS.length)];
      scanner.addTick(sym, generatePriceWithDigit(4));
      enhancedTradeEngine._executeCycle();
    }
  });
};

enhancedTradeEngine.onTradeUpdate = (trade) => {
  console.log(`[onTradeUpdate] Trade recorded! won: ${trade.won}, P&L: $${trade.profit}`);
};

// Prepopulate
console.log("Prepopulating...");
for (const sym of MARKETS) {
  for (let i = 0; i < 100; i++) {
    scanner.addTick(sym, generatePriceWithDigit(8)); // Dominance OVER
  }
}

console.log("Starting engine...");
enhancedTradeEngine.start({
  strategy: 'BOTH5',
  baseStake: 0.35,
  minConfidence: 65,
  cooldownMs: 0,
});
