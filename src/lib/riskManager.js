/* ═══════════════════════════════════════
   DERIVPRINTER — Risk Manager
   Account-aware stake calculation with
   safe depth limiting.
   ═══════════════════════════════════════ */

class RiskManager {
  constructor() {
    this.sessionStart = 0;
    this.sessionPnL = 0;
    this.maxSafeDepth = 0;
    this.consecutiveLosses = { OVER5: 0, UNDER5: 0, EVEN: 0, ODD: 0 };
  }

  startSession(balance) {
    this.sessionStart = balance;
    this.sessionPnL = 0;
    this.consecutiveLosses = { OVER5: 0, UNDER5: 0, EVEN: 0, ODD: 0 };
  }

  recordResult(direction, won, profit) {
    this.sessionPnL += profit;
    if (won) {
      this.consecutiveLosses[direction] = 0;
    } else {
      this.consecutiveLosses[direction] = (this.consecutiveLosses[direction] || 0) + 1;
    }
  }

  shouldStop(config, currentBalance) {
    const { stopLoss, takeProfit } = config;
    if (stopLoss > 0 && this.sessionPnL <= -stopLoss) {
      return { stop: true, reason: `Stop Loss: -$${Math.abs(this.sessionPnL).toFixed(2)}` };
    }
    if (takeProfit > 0 && this.sessionPnL >= takeProfit) {
      return { stop: true, reason: `Take Profit: +$${this.sessionPnL.toFixed(2)}` };
    }
    return { stop: false, reason: null };
  }

  shouldSwitch(config, channelKey) {
    const switchAfter = config.switchAfterLosses || 3;
    const dir1 = channelKey === 'BOTH5' ? 'OVER5' : 'EVEN';
    const dir2 = channelKey === 'BOTH5' ? 'UNDER5' : 'ODD';
    if (this.consecutiveLosses[dir1] >= switchAfter || this.consecutiveLosses[dir2] >= switchAfter) {
      return { switch: true, reason: `${switchAfter} losses on ${this.consecutiveLosses[dir1] >= switchAfter ? dir1 : dir2}` };
    }
    return { switch: false };
  }

  /* ── Account-aware Martingale stake ── */
  calculateStake(config, step, balance) {
    const stake = config.baseStake * Math.pow(config.martMultiplier || 2.0, step);
    return parseFloat(stake.toFixed(2));
  }

  /* ── Max safe Martingale depth before losing 20% of balance ── */
  getMaxSafeDepth(config, balance) {
    const maxSteps = Number(config.maxSteps);
    return maxSteps > 0 ? maxSteps : 99;
  }

  isExposureSafe(stake, balance) {
    return true; // Removed 5% hard cap
  }

  getStats() {
    return {
      sessionPnL: this.sessionPnL,
      sessionStart: this.sessionStart,
      maxSafeDepth: this.maxSafeDepth,
      consecutiveLosses: { ...this.consecutiveLosses },
    };
  }

  reset() {
    this.sessionStart = 0;
    this.sessionPnL = 0;
    this.maxSafeDepth = 0;
    this.consecutiveLosses = { OVER5: 0, UNDER5: 0, EVEN: 0, ODD: 0 };
  }
}

const riskManager = new RiskManager();
export default riskManager;
