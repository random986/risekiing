import sys
import re

file_path = 'src/lib/enhancedTradeEngine.js'
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add paused state and methods
if 'pause() {' not in content:
    content = content.replace(
        '  constructor() {',
        '  constructor() {\n    this.paused = false;'
    )
    content = content.replace(
        '  start(config, market = null) {',
        '  pause() {\n    if (!this.running) return;\n    this.paused = true;\n    this.updateStatus(\'Bot Paused...\');\n  }\n\n  resume() {\n    if (!this.running) return;\n    this.paused = false;\n    this.updateStatus(\'Bot Resumed. Waiting for ticks...\');\n  }\n\n  start(config, market = null) {'
    )

# 2. Modify _executeCycle()
if 'if (this.paused)' not in content:
    content = content.replace(
        '  _executeCycle() {',
        '  _executeCycle() {\n    if (this.paused) {\n      this._scheduleNext(100);\n      return;\n    }'
    )

# 3. Modify _isRecoveryTickFavorable
content = re.sub(
    r'  _isRecoveryTickFavorable\(market, direction\) \{[\s\S]*?return win1 \|\| win2;\n  \}',
    '  _isRecoveryTickFavorable(market, direction) {\n    return true;\n  }',
    content
)

# 4. Modify _getFlowBasedRecoveryDirection
content = re.sub(
    r'  _getFlowBasedRecoveryDirection\(marketSym\) \{[\s\S]*?return overCount > underCount \? \'OVER5\' : \'UNDER4\';\n  \}',
    '''  _getFlowBasedRecoveryDirection(marketSym) {
    if (this.strategy === 'OVER_3_V1' || this.strategy === 'OVER_3_V2' || this.strategy === 'OVER_3_V3') return 'OVER3';
    if (this.strategy === 'OVER_5_V1') return 'OVER5';
    if (this.strategy === 'OVER_6' || this.strategy === 'OVER_6_V2') return 'OVER6';
    if (this.strategy === 'OVER_0_V1') return 'OVER0';
    if (this.strategy === 'UNDER_8_V1') return 'UNDER8';
    if (this.strategy === 'UNDER_7_V1') return 'UNDER7';
    if (this.strategy === 'UNDER_3_V1') return 'UNDER3';
    if (this.strategy === 'UNDER_9_V1') return 'UNDER9';
    if (this.strategy === 'EVEN_V1') return 'EVEN';
    if (this.strategy === 'ODD_V1') return 'ODD';
    return 'OVER3';
  }''',
    content
)

# 5. Modify OVER 3 V3 Entry wait
content = re.sub(
    r'    if \(this.over3v3Phase === \'WAITING_ENTRY\'\) \{[\s\S]*?      \}\n    \}',
    '''      this.sendLog("OVER 3 V3: Rapid firing enabled. Instantly entering OVER 3.");
      this.over3v3Phase = 'TRADING';''',
    content
)

# 6. Modify OVER 3 V3 Recovery (strict lock + 5 step chunked)
target_recovery = r"    if \(this\.over3v3Phase === 'RECOVERY' \|\| this\.over3v3Phase === 'DEBT_RECOVERY'\) \{[\s\S]*?return;\n    \}"
replacement_recovery = '''    if (this.over3v3Phase === 'RECOVERY' || this.over3v3Phase === 'DEBT_RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(50);
        return;
      }
      
      if (!this.lockedRecoveryMarket || !this.lockedRecoveryDirection) {
        this.lockedRecoveryMarket = this.over3v3TargetMarket;
        this.lockedRecoveryDirection = 'OVER3';
        this.sendLog(OVER 3 V3: Locked strictly into   for blind recovery firing.);
      }

      const recMarket = this.lockedRecoveryMarket;
      const recDir = this.lockedRecoveryDirection;

      const multi = 1.5;
      const cappedLosses = Math.min(this.over3v3CurrentLosses, 5);
      const stake = this.config.baseStake * Math.pow(multi, cappedLosses);

      this.updateStatus(OVER 3 V3: Combined Recovery () on  Stake: {stake.toFixed(2)} (Step )...);
      this._placeTrade('SINGLE', recDir, stake);
      this._scheduleNext(50);
      return;
    }'''
content = re.sub(target_recovery, replacement_recovery, content)

# 7. Modify OVER 3 V3 win/loss state machine logic to keep chunking debt
win_loss_logic = r"    \} else if \(this\.strategy === 'OVER_3_V3'\) \{[\s\S]*?riskManager\.recordResult\(direction, won, profit\);"
win_loss_repl = '''    } else if (this.strategy === 'OVER_3_V3') {
      if (won) {
        if (this.over3v3Phase === 'DEBT_RECOVERY' || this.over3v3Phase === 'RECOVERY') {
          this.over3v3Debt -= profit;
          if (this.over3v3Debt <= 0) {
            this.over3v3Debt = 0;
            this.sendLog(? OVER 3 V3: Debt fully recovered! Returning to OVER 3.);
            this.over3v3Phase = 'TRADING';
            this.sessionConsecutiveLosses = 0;
            this.over3v3CurrentLosses = 0;
            this.lockedRecoveryDirection = null;
            this.lockedRecoveryMarket = null;
          } else {
            this.sendLog(?? OVER 3 V3: Partial chunk win. Remaining Debt: {this.over3v3Debt.toFixed(2)}. Keeping 1.5x capped martingale level and maintaining locked market.);
          }
        } else {
          this._onSessionWin('OVER_3_V3');
          this.over3v3CurrentLosses = 0;
        }
        this.over3v3CurrentWins++;
      } else {
        this.over3v3Debt = (this.over3v3Debt || 0) + Math.abs(profit);
        
        if (this.over3v3Phase !== 'RECOVERY' && this.over3v3Phase !== 'DEBT_RECOVERY') {
          this.over3v3Phase = 'RECOVERY';
          this.lockedRecoveryDirection = null;
          this.lockedRecoveryMarket = null;
        }

        this.sendLog(?? OVER 3 V3: Loss detected. Fixed 1.5x Chunked Recovery Active. Debt: {this.over3v3Debt.toFixed(2)});
        
        this._onSessionLoss('OVER_3_V3');
        this.over3v3CurrentLosses++;
        
        if (this.over3v3CurrentLosses >= 5) {
          this.sendLog(?? OVER 3 V3: Hit max martingale step 5. Resetting step to 0 while keeping debt to prevent crippling loss.);
          this.over3v3CurrentLosses = 0;
        }

        this._evaluateCircuitBreaker(this.over3v3CurrentLosses);
        this.over3v3CurrentWins = 0;
      }
      riskManager.recordResult(direction, won, profit);'''

if 'this.over3v3Debt' not in content:
    content = re.sub(win_loss_logic, win_loss_repl, content)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)
print('Patched successfully')
