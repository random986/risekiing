/* ═══════════════════════════════════════
   DERIVPRINTER — Trade Execution Engine
   Single-direction signal-based trading
   with optional Martingale recovery.
   ═══════════════════════════════════════ */

import derivWS from './derivWS.js';
import scanner from './marketScanner.js';
import riskManager from './riskManager.js';
import copyTradeEngine from './copyTradeEngine.js';

const CONTRACT_MAP = {
  OVER5:  { contract_type: 'DIGITOVER',  barrier: '5' },
  UNDER5: { contract_type: 'DIGITUNDER', barrier: '5' },
  EVEN:   { contract_type: 'DIGITEVEN' },
  ODD:    { contract_type: 'DIGITODD' },
};

class TradeEngine {
  constructor() {
    this.running = false;
    this.channels = {
      SINGLE: { active: false, step: 0, consecutiveLosses: 0, stake: 0.35, contractId: null, direction: null },
      OVER5:  { active: false, step: 0, consecutiveLosses: 0, stake: 0.35, contractId: null },
      UNDER5: { active: false, step: 0, consecutiveLosses: 0, stake: 0.35, contractId: null },
      EVEN:   { active: false, step: 0, consecutiveLosses: 0, stake: 0.35, contractId: null },
      ODD:    { active: false, step: 0, consecutiveLosses: 0, stake: 0.35, contractId: null },
    };
    this.globalConsecutiveLosses = 0; // For market switching
    this.lastTradeTime = 0;
    this.activeMarket = null;
    this.strategy = 'BOTH5';
    this.config = null;
    this.onTradeUpdate = null;
    this.onBotStop = null;
    this.onMarketSwitch = null;
    this._pocHandler = null;
    this._cycleTimer = null;
  }

  start(config) {
    if (this.running) return;
    this.running = true;
    this.config = config;
    this.strategy = config.strategy || 'BOTH5';

    // Reset channels
    for (const key in this.channels) {
      this.channels[key] = {
        active: false,
        step: 0,
        consecutiveLosses: 0,
        stake: config.baseStake,
        contractId: null,
        direction: null
      };
    }
    this.globalConsecutiveLosses = 0;
    this.lastTradeTime = 0;

    this.activeMarket = scanner.getBest(this.strategy);
    if (this.onMarketSwitch) this.onMarketSwitch(this.activeMarket);

    this._pocHandler = derivWS.on('proposal_open_contract', (msg) => this._handleContractUpdate(msg));

    const balance = derivWS.accountInfo?.balance || 0;
    riskManager.startSession(balance);
    this._executeCycle();
  }

  stop(reason) {
    this.running = false;
    if (this._cycleTimer) { clearTimeout(this._cycleTimer); this._cycleTimer = null; }
    if (this._pocHandler) { this._pocHandler(); this._pocHandler = null; }
    if (this.onBotStop) this.onBotStop(reason || 'User stopped');
  }

  _executeCycle() {
    if (!this.running || !derivWS.isReady) return;

    const balance = derivWS.accountInfo?.balance || 0;
    const stopCheck = riskManager.shouldStop(this.config, balance);
    if (stopCheck.stop) { this.stop(stopCheck.reason); return; }

    const cooldownMs = this.config.cooldownMs || 1000;
    const elapsed = Date.now() - this.lastTradeTime;
    if (this.lastTradeTime > 0 && elapsed < cooldownMs) {
      this._scheduleNext(cooldownMs - elapsed + 100);
      return;
    }

    const scores = scanner.scores[this.activeMarket];
    if (!scores || scores.tickCount < 10) {
      this._scheduleNext(2000);
      return;
    }

    const isDual = this.strategy === 'OU_WINNING' || this.strategy === 'EO_WINNING';

    if (isDual) {
      const dirs = this.strategy === 'OU_WINNING' ? ['OVER5', 'UNDER5'] : ['EVEN', 'ODD'];
      let tradesPlaced = 0;
      dirs.forEach(dir => {
        const channel = this.channels[dir];
        if (!channel.active) {
          this._placeTrade(dir, dir, channel.stake);
          tradesPlaced++;
        }
      });
      if (tradesPlaced === 0) return; // Both legs active, wait
      return;
    }

    if (this.channels.SINGLE.active) return;

    this._placeTrade('SINGLE', 'MATCH', this.channels.SINGLE.stake);
  }

  async _placeTrade(channelKey, direction, stake) {
    const spec = CONTRACT_MAP[direction];
    if (!spec) return;

    const numericStake = Number(Number(stake).toFixed(2)) || 0.35;

    const isRiseFall = direction === 'RISE' || direction === 'FALL';

    const proposalPayload = {
      proposal: 1,
      amount: numericStake,
      basis: 'stake',
      contract_type: spec.contract_type,
      currency: derivWS.accountInfo?.currency || 'USD',
      duration: isRiseFall ? (this.config.riseFallDuration || 30) : 1,
      duration_unit: isRiseFall ? (this.config.riseFallDurationUnit || 's') : 't',
      underlying_symbol: this.activeMarket,
    };
    if (spec.barrier !== null && spec.barrier !== undefined) proposalPayload.barrier = String(spec.barrier);

    const channel = this.channels[channelKey];
    channel.active = true;
    channel.direction = direction;
    channel.stake = numericStake;

    try {
      // Step 1: Request Proposal
      const propRes = await derivWS.send(proposalPayload);
      if (propRes.error) {
        channel.active = false;
        channel.direction = null;
        this.stop(`${propRes.error.message} | Payload: ${JSON.stringify(proposalPayload)}`);
        return;
      }

      if (!propRes.proposal || !propRes.proposal.id) {
        channel.active = false;
        channel.direction = null;
        this.stop(`No proposal ID returned`);
        return;
      }

      // Step 2: Execute Buy
      const buyPayload = {
        buy: propRes.proposal.id,
        price: propRes.proposal.ask_price
      };

      const res = await derivWS.send(buyPayload);
      
      if (res.error) {
        console.error(`Trade error [${direction}]:`, res.error.message);
        channel.active = false;
        channel.direction = null;
        const details = res.error.details ? JSON.stringify(res.error.details) : '';
        this.stop(`${res.error.message} | Details: ${details}`);
        return;
      }

      if (res.buy) {
        channel.contractId = res.buy.contract_id;
        derivWS.sendRaw({ proposal_open_contract: 1, contract_id: channel.contractId, subscribe: 1 });
        
        // MIRROR TO DEMO IF COPYTRADE IS ACTIVE
        if (copyTradeEngine.active) {
          copyTradeEngine.copyTrade({
            contractType: spec.contract_type,
            symbol: this.activeMarket,
            amount: propRes.proposal.ask_price,
            duration: 1,
            durationUnit: 't',
            barrier: spec.barrier !== null && spec.barrier !== undefined ? String(spec.barrier) : undefined,
            currency: derivWS.accountInfo?.currency || 'USD'
          });
        }
      }
    } catch (e) {
      console.error(`Trade failed [${direction}]:`, e);
      channel.active = false;
      channel.direction = null;
      if (this.running) this._scheduleNext(2000);
    }
  }

  _handleContractUpdate(msg) {
    const contract = msg.proposal_open_contract;
    if (!contract || !contract.is_sold) return;
    const cid = contract.contract_id;

    // Find which channel this contract belongs to
    let channelKey = null;
    let channel = null;
    for (const key in this.channels) {
      if (this.channels[key].contractId === cid) {
        channelKey = key;
        channel = this.channels[key];
        break;
      }
    }

    if (!channel) return;

    const direction = channel.direction;
    const won = contract.status === 'won';
    const profit = parseFloat(contract.profit) || 0;
    const buyPrice = parseFloat(contract.buy_price) || 0;

    const trade = {
      id: cid,
      direction,
      market: contract.underlying || this.activeMarket,
      stake: buyPrice,
      profit,
      won,
      exitTick: contract.current_spot_display_value || contract.exit_tick_display_value || contract.sell_spot_display_value || contract.current_spot || contract.sell_spot || '',
      time: Date.now(),
    };

    riskManager.recordResult(direction, won, profit);
    const maxSteps = this.config.maxSteps || 6;

    if (won) {
      console.log(`✅ WIN [${direction}] +$${profit.toFixed(2)} | Resetting stake`);
      channel.step = 0;
      channel.stake = this.config.baseStake;
      channel.consecutiveLosses = 0;
      this.globalConsecutiveLosses = 0;
    } else {
      channel.consecutiveLosses++;
      this.globalConsecutiveLosses++;

      if (this.config.recoveryEnabled) {
        if (channel.step < maxSteps) {
          channel.step++;
          
          if (direction === 'RISE' || direction === 'FALL') {
            const lossAmount = Math.abs(profit);
            channel.stake = Number((channel.stake + (lossAmount * 1.071)).toFixed(2));
          } else {
            channel.stake = riskManager.calculateStake(this.config, channel.step, 0);
          }
          
          console.log(`❌ LOSS [${direction}] $${profit.toFixed(2)} | Martingale step ${channel.step}/${maxSteps} → next trade at $${channel.stake}`);
        } else {
          // Reached max steps, reset to base
          console.log(`❌ LOSS [${direction}] $${profit.toFixed(2)} | Martingale max steps (${maxSteps}) reached. Resetting to base stake.`);
          channel.step = 0;
          channel.stake = this.config.baseStake;
        }
      } else {
        console.log(`❌ LOSS [${direction}] $${profit.toFixed(2)} | Recovery disabled`);
        channel.step = 0;
        channel.stake = this.config.baseStake;
      }

      // Check if we should switch markets using
    }

    channel.active = false;
    channel.contractId = null;
    if (channelKey === 'SINGLE') channel.direction = null;
    this.lastTradeTime = Date.now();

    if (this.onTradeUpdate) this.onTradeUpdate(trade);
    if (this.running) this._scheduleNext(this.config.cooldownMs || 1000);
  }

  _switchMarket() {
    return;
  }

  _scheduleNext(delayMs) {
    if (this._cycleTimer) clearTimeout(this._cycleTimer);
    this._cycleTimer = setTimeout(() => this._executeCycle(), delayMs);
  }

  updateConfig(config) {
    this.config = config;
  }
}

const tradeEngine = new TradeEngine();
export default tradeEngine;
