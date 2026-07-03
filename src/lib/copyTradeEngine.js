/* ══════════════════════════════════════════════════════════════
   COPY TRADE ENGINE — Mirrors trades between accounts
   Supports Real→Demo AND Demo→Real copying.
   Spawns a secondary WebSocket for the target account and
   replicates buy events from the source connection.
   ══════════════════════════════════════════════════════════════ */

const WS_URL = 'wss://ws.derivws.com/websockets/v3';
import { APP_ID } from '../config.js';

class CopyTradeEngine {
  constructor() {
    this.ws = null;
    this.status = 'idle'; // idle | connecting | authorized | error
    this.targetToken = null;
    this.targetAccountId = null;
    this.sourceAccountId = null;
    this.direction = 'demo_to_real'; // 'demo_to_real' or 'real_to_demo'
    this.active = false;
    this.copiedTrades = [];
    this.maxLog = 100;
    this.onStatusChange = null;
    this.onTradeLog = null;
    this.reqId = 0;
    this.pendingRequests = new Map();
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnect = 5;
  }

  /* ── Configure with target account details ── */
  configure({ targetToken, targetAccountId, sourceAccountId, direction }) {
    this.targetToken = targetToken;
    this.targetAccountId = targetAccountId;
    this.sourceAccountId = sourceAccountId;
    this.direction = direction || 'demo_to_real';
  }

  /* ── Start: connect the target WS ── */
  async start() {
    if (!this.targetToken || !this.targetAccountId) {
      this._log('❌ No target account configured. Please select a target account.');
      return;
    }
    this.active = true;
    this.reconnectAttempts = 0;
    await this._connectTarget();
  }

  /* ── Stop: tear down the target WS ── */
  stop() {
    this.active = false;
    this.status = 'idle';
    this._emitStatus();
    this._stopPing();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this._log('⏹️ Copy trade stopped.');
  }

  /* ── Mirror a trade to the target account ── */
  async copyTrade({ contractType, symbol, amount, duration, durationUnit, barrier, currency = 'USD' }) {
    if (!this.active || this.status !== 'authorized') {
      this._log('⚠️ Cannot copy — target WS not authorized.');
      return;
    }

    const cleanAmount = Number(Number(amount).toFixed(2));

    const proposalPayload = {
      proposal: 1,
      amount: cleanAmount,
      basis: 'stake',
      contract_type: contractType,
      currency: currency,
      underlying_symbol: symbol,
      duration: duration,
      duration_unit: durationUnit
    };
    if (barrier !== null && barrier !== undefined) proposalPayload.barrier = String(barrier);

    const dirLabel = this.direction === 'demo_to_real' ? 'Demo→Real' : 'Real→Demo';
    this._log(`📋 [${dirLabel}] Copying → ${contractType} on ${symbol} @ $${amount}`);

    try {
      const propRes = await this._send(proposalPayload);
      if (propRes.error) {
        this._log(`❌ Proposal failed: ${propRes.error.message}`);
        return;
      }
      
      const buyPayload = {
        buy: propRes.proposal.id,
        price: propRes.proposal.ask_price,
        subscribe: 1
      };
      
      const result = await this._send(buyPayload);
      if (result.error) {
        this._log(`❌ Copy failed: ${result.error.message}`);
      } else {
        const cid = result.buy?.contract_id;
        this._log(`✅ Copied! Contract ID: ${cid}`);
        this.copiedTrades.push({
          id: cid,
          contractType,
          symbol,
          amount,
          time: Date.now(),
          status: 'open',
          direction: this.direction
        });
        if (this.copiedTrades.length > this.maxLog) {
          this.copiedTrades = this.copiedTrades.slice(-this.maxLog);
        }
      }
    } catch (err) {
      this._log(`❌ Copy error: ${err.message}`);
    }
  }

  /* ── Internal: connect to target WS via OTP ── */
  async _connectTarget() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.status = 'connecting';
    this._emitStatus();
    this._log('🔌 Connecting target WebSocket...');

    const isAlphanumeric = isNaN(Number(APP_ID));
    let wsUrl = `${WS_URL}?app_id=${APP_ID}`;
    let usedOtp = false;

    // Try OTP route if ID is alphanumeric
    if (this.targetToken && this.targetAccountId && isAlphanumeric) {
      try {
        const response = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${this.targetAccountId}/otp`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.targetToken}`,
            'Deriv-App-ID': APP_ID
          }
        });
        if (response.ok) {
          const data = await response.json();
          if (data.otp_url) {
            wsUrl = data.otp_url;
            usedOtp = true;
            this._log('🔑 OTP URL obtained for target account.');
          }
        }
      } catch (err) {
        this._log(`⚠️ OTP fetch failed, falling back to authorize: ${err.message}`);
      }
    }

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this._log('✅ Target WebSocket connected.');
      this.reconnectAttempts = 0;
      this._startPing();

      if (usedOtp) {
        this.status = 'authorized';
        this._emitStatus();
        this._log('🔐 Target account authorized via OTP.');
      } else if (this.targetToken) {
        // Legacy system needs manual authorization via WebSocket payload
        this.ws.send(JSON.stringify({ authorize: this.targetToken }));
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.msg_type === 'authorize') {
          if (msg.error) {
            this._log(`❌ Target auth failed: ${msg.error.message}`);
            this.status = 'error';
          } else {
            this.status = 'authorized';
            this._log(`🔐 Target authorized: ${msg.authorize?.loginid}`);
          }
          this._emitStatus();
          return;
        }

        if (msg.req_id && this.pendingRequests.has(msg.req_id)) {
          const { resolve } = this.pendingRequests.get(msg.req_id);
          this.pendingRequests.delete(msg.req_id);
          resolve(msg);
        }
      } catch (err) {
        // ignore parse errors
      }
    };

    this.ws.onerror = () => {
      this._log('❌ Target WebSocket error.');
      this.status = 'error';
      this._emitStatus();
    };

    this.ws.onclose = () => {
      this._log('🔌 Target WebSocket disconnected.');
      this.status = 'idle';
      this._emitStatus();
      this._stopPing();

      if (this.active && this.reconnectAttempts < this.maxReconnect) {
        const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempts), 30000);
        this.reconnectAttempts++;
        this._log(`🔄 Reconnecting target in ${(delay / 1000).toFixed(0)}s...`);
        this.reconnectTimer = setTimeout(() => this._connectTarget(), delay);
      }
    };
  }

  /* ── Internal: send message on target WS ── */
  _send(payload) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('Target WS not open'));
      }
      const id = ++this.reqId;
      payload.req_id = id;
      this.pendingRequests.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timed out'));
        }
      }, 15000);
    });
  }

  /* ── Internal: log helper ── */
  _log(message) {
    console.log('[CopyTrade]', message);
    if (this.onTradeLog) this.onTradeLog(message);
  }

  /* ── Internal: status emitter ── */
  _emitStatus() {
    if (this.onStatusChange) this.onStatusChange(this.status);
  }

  /* ── Get current state summary ── */
  getState() {
    return {
      status: this.status,
      active: this.active,
      copiedTrades: this.copiedTrades,
      targetAccountId: this.targetAccountId,
      sourceAccountId: this.sourceAccountId,
      direction: this.direction
    };
  }

  /* ── Internal: keep connection alive ── */
  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ ping: 1 }));
      }
    }, 30000);
  }

  _stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

export const copyTradeEngine = new CopyTradeEngine();
export default copyTradeEngine;
