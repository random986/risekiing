const fs = require('fs');
const file = 'src/lib/enhancedTradeEngine.js';
let content = fs.readFileSync(file, 'utf8');

const regex = /const tradeKey = this\._getFlowBasedRecoveryDirection\(this\.([a-zA-Z0-9_]+TargetMarket)\);/g;

content = content.replace(regex, (match, targetMarketVar) => {
  return `const tradeKey = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.${targetMarketVar});`;
});

fs.writeFileSync(file, content);
console.log('Fixed tradeKey instances.');
