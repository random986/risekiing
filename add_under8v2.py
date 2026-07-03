import sys
import re

file_path = 'src/lib/enhancedTradeEngine.js'
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Add _executeUnder8V2Cycle dispatch
content = content.replace(
    "    if (this.strategy === 'UNDER_8_V1') {",
    "    if (this.strategy === 'UNDER_8_V2') {\n      this._executeUnder8V2Cycle();\n      return;\n    }\n    if (this.strategy === 'UNDER_8_V1') {"
)

# Add _executeUnder8V2Cycle function
under8v2_cycle = '''
  // ---------------------------------------------------------------------------
  // UNDER 8 V2 CYCLE
  //  Entry: Scans for a market where Green (max), Blue (2nd), and Yellow (3rd)
  //  frequency digits are strictly >= 3 and < 8. (i.e. 3, 4, 5, 6, 7).
  //  If matched, triggers UNDER 8 trade.
  //  Recovery: Rapid fire blind OVER 3.
  // ---------------------------------------------------------------------------
  _executeUnder8V2Cycle() {
    const channel = this.channels.SINGLE;
    if (channel.active) {
      this._scheduleNext(100);
      return;
    }

    if (!this.under8V2Phase || this.under8V2Phase === 'SEARCHING') {
      this.updateStatus('UNDER 8 V2: Scanning for market (Green, Blue, Yellow all between 3 and 7)...');
      let bestMarket = null;

      for (const sym of MARKETS) {
        if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
        const ticks = scanner.buffers[sym] || [];
        if (ticks.length < 50) continue; 

        const counts = Array(10).fill(0);
        for (const t of ticks) counts[t]++;
        const freqs = counts.map((c, i) => ({ digit: i, pct: (c / ticks.length) * 100 }));
        
        // Sort descending by percentage
        const sorted = [...freqs].sort((a, b) => b.pct - a.pct);
        const greenDigit = sorted[0].digit;  // highest frequency
        const blueDigit  = sorted[1].digit;  // 2nd highest frequency
        const yellowDigit = sorted[2].digit; // 3rd highest frequency

        // Condition: all top 3 digits must be >= 3 and < 8
        const isValid = (d) => d >= 3 && d < 8;
        
        if (isValid(greenDigit) && isValid(blueDigit) && isValid(yellowDigit)) {
          bestMarket = sym;
          this.sendLog(UNDER 8 V2: Market match on . Top 3: , , .);
          break;
        }
      }

      if (!bestMarket) {
        this.stop('UNDER 8 V2: No market found meeting the condition.');
        return;
      }

      this.activeMarket = bestMarket;
      if (this.onMarketSwitch) this.onMarketSwitch(bestMarket);
      this.under8V2TargetMarket = bestMarket;
      this.under8V2Phase = 'TRADING';
    }

    if (this.under8V2Phase === 'TRADING') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(50);
        return;
      }
      const stake = this.channels.SINGLE.stake || this.config.baseStake;
      this._placeTrade('SINGLE', 'UNDER8', stake);
      this._scheduleNext(50);
      return;
    }

    if (this.under8V2Phase === 'RECOVERY' || this.under8V2Phase === 'DEBT_RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(50);
        return;
      }
      
      // Strict lockdown on original market and OVER 3 direction for blind rapid recovery
      if (!this.lockedRecoveryMarket || !this.lockedRecoveryDirection) {
        this.lockedRecoveryMarket = this.under8V2TargetMarket;
        this.lockedRecoveryDirection = 'OVER3'; // Hard lock to the OVER 3 direction
        this.sendLog(UNDER 8 V2: Locked strictly into   for blind recovery firing.);
      }

      const recMarket = this.lockedRecoveryMarket;
      const recDir = this.lockedRecoveryDirection;

      const stake = this._resolveTradeStake('SINGLE', this.under8V2CurrentLosses, 'UNDER_8_V2');

      this.updateStatus(UNDER 8 V2: Rapid Recovery () on  Stake: {stake.toFixed(2)} (Loss )...);
      this._placeTrade('SINGLE', recDir, stake);
      this._scheduleNext(50);
      return;
    }
  }
'''
content = content.replace(
    '  _executeUnder8V1Cycle() {',
    under8v2_cycle + '\n  _executeUnder8V1Cycle() {'
)

# Add UNDER_8_V2 win/loss handling
win_loss_logic = '''    } else if (this.strategy === 'UNDER_8_V2') {
      if (won) {
        if (this.under8V2Phase === 'DEBT_RECOVERY' || this.under8V2Phase === 'RECOVERY') {
          this.under8V2Debt -= profit;
          if (this.under8V2Debt <= 0) {
            this.under8V2Debt = 0;
            this.sendLog(? UNDER 8 V2: Debt fully recovered! Returning to original trades.);
            this.under8V2Phase = 'TRADING';
            this.sessionConsecutiveLosses = 0;
            this.under8V2CurrentLosses = 0;
            this.lockedRecoveryDirection = null;
            this.lockedRecoveryMarket = null;
          } else {
            this.sendLog(?? UNDER 8 V2: Partial chunk win. Remaining Debt: {this.under8V2Debt.toFixed(2)});
          }
        } else {
          this._onSessionWin('UNDER_8_V2');
          this.under8V2CurrentLosses = 0;
        }
        this.under8V2CurrentWins++;
      } else {
        this.under8V2Debt = (this.under8V2Debt || 0) + Math.abs(profit);
        
        if (this.under8V2Phase !== 'RECOVERY' && this.under8V2Phase !== 'DEBT_RECOVERY') {
          this.under8V2Phase = 'RECOVERY';
          this.lockedRecoveryDirection = null;
          this.lockedRecoveryMarket = null;
        }

        this.sendLog(?? UNDER 8 V2: Loss detected. OVER 3 Rapid Recovery Active. Debt: {this.under8V2Debt.toFixed(2)});
        
        this._onSessionLoss('UNDER_8_V2');
        this.under8V2CurrentLosses++;

        this._evaluateCircuitBreaker(this.under8V2CurrentLosses);
        this.under8V2CurrentWins = 0;
      }
      riskManager.recordResult(direction, won, profit);
    } else if (this.strategy === 'UNDER_8_V1') {'''

content = content.replace(
    "    } else if (this.strategy === 'UNDER_8_V1') {",
    win_loss_logic
)

# Initialize variables in resetSession()
content = content.replace(
    '    this.under8CurrentWins = 0;',
    '    this.under8CurrentWins = 0;\n    this.under8V2CurrentLosses = 0;\n    this.under8V2CurrentWins = 0;\n    this.under8V2Phase = \'SEARCHING\';\n    this.under8V2TargetMarket = null;\n    this.under8V2Debt = 0;'
)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)
print('UNDER_8_V2 patched successfully')
