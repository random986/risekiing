import enhancedTradeEngine from './src/lib/enhancedTradeEngine.js';
import derivWS from './src/lib/derivWS.js';

console.log("derivWS imported directly:", derivWS);
console.log("derivWS.accountInfo directly:", derivWS.accountInfo);

derivWS.accountInfo = { balance: 10000.00, currency: 'USD' };
derivWS.status = 'authorized';

console.log("derivWS.accountInfo after set:", derivWS.accountInfo);

// Let's import the engine's view of derivWS by checking if we can log it from inside the engine
enhancedTradeEngine.sendLog("Test log from engine");
console.log("Engine running state:", enhancedTradeEngine.running);
