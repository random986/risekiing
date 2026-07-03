import sys

file_path = 'src/lib/enhancedTradeEngine.js'
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Add _executeOver3V3Cycle dispatch
content = content.replace(
    "if (this.strategy === 'OVER_3_V2') {",
    "if (this.strategy === 'OVER_3_V3') {\n      this._executeOver3V3Cycle();\n      return;\n    }\n    if (this.strategy === 'OVER_3_V2') {"
)

# Add _executeOver3V3Cycle function
over3v3_cycle = '''
  _executeOver3V3Cycle() {
    const channel = this.channels.SINGLE;
    if (channel.active) {
      this._scheduleNext(100);
      return;
    }

    if (this.over3v3Phase === 'SEARCHING') {
      this.updateStatus('OVER 3 V3: Scanning all markets for momentum...');
      let bestMarket = null;
      let highestOver3Pct = 0;

      for (const sym of MARKETS) {
        if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
        const ticks = scanner.buffers[sym] || [];
        if (ticks.length < 400) continue; 

        const half = Math.floor(ticks.length / 2);
        const olderHalf = ticks.slice(0, half);
        const newerHalf = ticks.slice(half);

        const pctOver3 = (arr) => arr.filter(t => t > 3).length / arr.length * 100;
        
        const olderPct = pctOver3(olderHalf);
        const newerPct = pctOver3(newerHalf);

        if (newerPct > olderPct && newerPct > highestOver3Pct) {
          highestOver3Pct = newerPct;
          bestMarket = sym;
        }
      }

      if (!bestMarket) {
        this.stop('OVER 3 V3: No market found with increasing > 3 percentages');
        return;
      }

      this.activeMarket = bestMarket;
      if (this.onMarketSwitch) this.onMarketSwitch(bestMarket);
      this.over3v3TargetMarket = bestMarket;
      this.over3v3Phase = 'TRADING';
      this.sendLog("OVER 3 V3: Rapid firing enabled. Instantly entering OVER 3.");
    }

    if (this.over3v3Phase === 'TRADING') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(50);
        return;
      }
      const stake = this.channels.SINGLE.stake || this.config.baseStake;
      this._placeTrade('SINGLE', 'OVER3', stake);
      this._scheduleNext(50);
      return;
    }

    if (this.over3v3Phase === 'RECOVERY' || this.over3v3Phase === 'DEBT_RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(50);
        return;
      }
      
      // Strict lockdown on original market and direction for blind rapid recovery
      if (!this.lockedRecoveryMarket || !this.lockedRecoveryDirection) {
        this.lockedRecoveryMarket = this.over3v3TargetMarket;
        this.lockedRecoveryDirection = 'OVER3'; // Hard lock to the original direction
        this.sendLog(OVER 3 V3: Locked strictly into   for blind recovery firing.);
      }

      const recMarket = this.lockedRecoveryMarket;
      const recDir = this.lockedRecoveryDirection;

      // Hardcoded 1.5x multiplier capped at 5 steps for small chunks recovery
      const multi = 1.5;
      const cappedLosses = Math.min(this.over3v3CurrentLosses, 5);
      const stake = this.config.baseStake * Math.pow(multi, cappedLosses);

      this.updateStatus(OVER 3 V3: Combined Recovery () on  Stake: {stake.toFixed(2)} (Step )...);
      this._placeTrade('SINGLE', recDir, stake);
      this._scheduleNext(50);
      return;
    }
  }
'''
content = content.replace(
    '  _executeOver3V2Cycle() {',
    over3v3_cycle + '\n  _executeOver3V2Cycle() {'
)

# Add over3v3 win/loss handling
win_loss_logic = '''    } else if (this.strategy === 'OVER_3_V3') {
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
      riskManager.recordResult(direction, won, profit);
    } else if (this.strategy === 'OVER_5_V1') {'''

content = content.replace(
    "    } else if (this.strategy === 'OVER_5_V1') {",
    win_loss_logic
)

# Initialize variables in resetSession()
content = content.replace(
    '    this.over3v2CurrentWins = 0;',
    '    this.over3v2CurrentWins = 0;\n    this.over3v3CurrentLosses = 0;\n    this.over3v3CurrentWins = 0;\n    this.over3v3Phase = \'SEARCHING\';\n    this.over3v3TargetMarket = null;\n    this.over3v3Debt = 0;'
)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)
print('Reconstruction patched successfully')
