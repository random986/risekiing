const fs = require('fs');
const file = 'src/lib/enhancedTradeEngine.js';
let content = fs.readFileSync(file, 'utf8');

// 1. Add lockedRecoveryDirection to start()
if (!content.includes('this.lockedRecoveryDirection = null;')) {
  content = content.replace('this.strategy = null;', 'this.strategy = null;\n    this.lockedRecoveryDirection = null;');
}

// 2. Update pocHandler transitions
const pocRegex = /\} else if \(this\.([a-zA-Z0-9_]+Phase) === 'TRADING(_OVER_0)?'\) \{\s*if \(this\.config\.recoveryEnabled === false\) \{\s*this\.[a-zA-Z0-9_]+Phase = 'DEBT_RECOVERY(_OVER_0)?';\s*this\.([a-zA-Z0-9_]+Debt) \+= Math\.abs\(profit\);\s*this\.sendLog\(([^;]+)\);\s*\} else \{\s*this\.[a-zA-Z0-9_]+Phase = 'RECOVERY(_OVER_0)?';\s*this\.sendLog\(([^;]+)\);\s*\}/g;

content = content.replace(pocRegex, (match, phaseVar, phaseSuffix1, phaseSuffix2, debtVar, log1, phaseSuffix3, log2) => {
  let targetMarketVar = phaseVar.replace('Phase', 'TargetMarket');
  if (phaseVar === 'over0v1Phase') targetMarketVar = 'over0v1TargetMarket';
  
  return `} else if (this.${phaseVar} === 'TRADING${phaseSuffix1 || ''}') {
          if (this.config.recoveryEnabled === false) {
            this.${phaseVar} = 'DEBT_RECOVERY${phaseSuffix2 || ''}';
            this.${debtVar} += Math.abs(profit);
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.${targetMarketVar});
            this.sendLog(${log1});
          } else {
            this.${phaseVar} = 'RECOVERY${phaseSuffix3 || ''}';
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.${targetMarketVar});
            this.sendLog(${log2});
          }`;
});

// 3. Update execution cycles
const cycleRegex = /const dir = this\._getFlowBasedRecoveryDirection\(this\.([a-zA-Z0-9_]+TargetMarket)\);/g;

content = content.replace(cycleRegex, (match, targetMarketVar) => {
  return `const dir = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.${targetMarketVar});`;
});

fs.writeFileSync(file, content);
console.log('Update complete.');
