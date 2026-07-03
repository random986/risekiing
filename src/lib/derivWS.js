/* ══════════════════════════════════════════════════════════════
   DERIVPRINTER — Deriv Options API Client
   Uses the NEW Options API (non-legacy):
     - REST for accounts, balances, demo reset
     - OTP-based WebSocket for real-time trading
   ══════════════════════════════════════════════════════════════ */

import useConnectionStore from '../store/useConnectionStore.js';
import { APP_ID } from '../config.js';

const API_BASE = 'https://api.derivws.com/trading/v1/options';

class DerivWebSocket {
  constructor() {
    this.ws = null;
    this.status = 'disconnected'; // disconnected | connecting | connected | authorized | error
    this.token = null;        // OAuth2 Bearer token
    this.accountId = null;    // DOT-prefixed account ID
    this.accountInfo = null;
    this.handlers = new Map();
    this.pendingRequests = new Map();
    this.reqId = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this._backgroundTab = false;
    this.onStatusChange = null;
    this.onAccountUpdate = null;
    this._wsUrl = null;       // OTP-authenticated WS URL
  }

  // ═══════════════════════════════════════════════════════
  // REST API helpers (new Options API)
  // ═══════════════════════════════════════════════════════

  /** Fetch all Options trading accounts with balances */
  async fetchAccounts() {
    const res = await fetch(`${API_BASE}/accounts`, {
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Deriv-App-ID': APP_ID,
      }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.errors?.[0]?.message || err?.message || `HTTP ${res.status}`);
    }
    const json = await res.json();
    return json.data || json.accounts || [];
  }

  /** Reset demo account balance to $10,000 */
  async resetDemoBalance(accountId) {
    const res = await fetch(`${API_BASE}/accounts/${accountId}/reset-balance`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Deriv-App-ID': APP_ID,
      }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.errors?.[0]?.message || err?.message || `HTTP ${res.status}`);
    }
    return res.json();
  }

  /** Get an OTP URL for WebSocket connection */
  async _getOtpUrl(accountId) {
    const res = await fetch(`${API_BASE}/accounts/${accountId}/otp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Deriv-App-ID': APP_ID,
      }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.errors?.[0]?.message || err?.message || `OTP request failed: HTTP ${res.status}`);
    }
    const json = await res.json();
    const url = json?.data?.url || json?.url;
    if (!url) throw new Error('OTP response did not contain a WebSocket URL');
    return url;
  }

  // ═══════════════════════════════════════════════════════
  // WebSocket connection (OTP-based, new Options API)
  // ═══════════════════════════════════════════════════════

  async connect(token, accountId) {
    if (!token) return;

    // If we're already connecting or connected to this same account, do nothing
    if (this.token === token && this.accountId === accountId && (this.status === 'connecting' || this.status === 'connected' || this.status === 'authorized')) {
      console.log(`[derivWS] Already ${this.status} to ${accountId}, skipping reconnect.`);
      return;
    }

    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
    }

    this.token = token;
    this.accountId = accountId;
    
    this.status = 'connecting';
    this._emitStatus();

    try {
      // Step 1: Get OTP-authenticated WebSocket URL
      console.log(`[derivWS] Requesting OTP for account ${accountId}...`);
      this._wsUrl = await this._getOtpUrl(accountId);
      console.log('[derivWS] Got OTP WebSocket URL');
      
      // Step 2: Connect to the OTP URL (no authorize needed)
      this._connectWs();
    } catch (err) {
      console.error('[derivWS] OTP/connect failed, falling back to legacy WS:', err.message);
      // Fallback: try legacy WebSocket with authorize
      this._wsUrl = null;
      this._connectLegacy();
    }
  }

  _connectWs() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const url = this._wsUrl;
    console.log('[derivWS] Connecting to Options WS (OTP)...');

    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      console.error('[derivWS] Failed to open WS:', e);
      this.status = 'error';
      this._emitStatus();
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log('[derivWS] Connected to Deriv Options WebSocket (OTP authenticated)');
      this.status = 'authorized'; // OTP URL = already authenticated
      this._emitStatus();
      this._startPing();

      // Fetch account balance via REST and push to store
      this._syncAccountBalance();
      // Subscribe to real-time balance updates
      this.sendRaw({ balance: 1, subscribe: 1 });
    };

    this.ws.onmessage = (event) => {
      this._handleMessage(event);
    };

    this.ws.onclose = () => {
      console.log('[derivWS] WebSocket disconnected');
      this._stopPing();
      this.status = 'disconnected';
      this._emitStatus();
      this._scheduleReconnect();
    };

    this.ws.onerror = () => {
      console.error('[derivWS] WebSocket error');
    };
  }

  /** Legacy fallback: connect to ws.binaryws.com with authorize */
  _connectLegacy() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const wsUrl = `wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`;
    console.log('[derivWS] Connecting to legacy Deriv WS:', wsUrl);

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (e) {
      console.error('[derivWS] Failed to open legacy WS:', e);
      this.status = 'error';
      this._emitStatus();
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log('[derivWS] Connected to legacy Deriv WS');
      this.status = 'connected';
      this._emitStatus();
      this._startPing();

      if (this.token) {
        this.sendRaw({ authorize: this.token });
      }
    };

    this.ws.onmessage = (event) => {
      this._handleMessage(event);
    };

    this.ws.onclose = () => {
      console.log('[derivWS] Legacy WS disconnected');
      this._stopPing();
      this.status = 'disconnected';
      this._emitStatus();
      this._scheduleReconnect();
    };

    this.ws.onerror = () => {
      console.error('[derivWS] Legacy WS error');
    };
  }

  _handleMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      return;
    }

    // Handle ping response
    if (msg.msg_type === 'ping') return;

    // Handle authorization (legacy fallback)
    if (msg.msg_type === 'authorize') {
      if (!msg.error) {
        this.status = 'authorized';
        this.accountInfo = {
          loginid: msg.authorize?.loginid || this.accountId,
          balance: parseFloat(msg.authorize?.balance) || 0,
          currency: msg.authorize?.currency || 'USD',
          fullname: msg.authorize?.fullname || msg.authorize?.email || '',
        };
        this._emitStatus();
        if (this.onAccountUpdate) this.onAccountUpdate({ ...this.accountInfo });
        useConnectionStore.setState({ balance: this.accountInfo.balance, currency: this.accountInfo.currency });
        
        // Subscribe to real-time balance updates
        this.sendRaw({ balance: 1, subscribe: 1 });
      } else {
        console.error('[derivWS] Authorization failed:', msg.error.message);
        this.status = 'error';
        this._emitStatus();
      }
    }

    // Handle balance updates (legacy fallback)
    if (msg.msg_type === 'balance' && msg.balance) {
      const bal = parseFloat(msg.balance.balance);
      this.accountInfo = {
        ...this.accountInfo,
        balance: bal,
      };
      if (this.onAccountUpdate) this.onAccountUpdate({ ...this.accountInfo });
      useConnectionStore.setState({ balance: bal });
    }

    // Handle request tracking resolutions (matching req_id)
    if (msg.req_id && this.pendingRequests.has(msg.req_id)) {
      const resolve = this.pendingRequests.get(msg.req_id);
      this.pendingRequests.delete(msg.req_id);
      resolve(msg);
    }

    // Broadcast to general message type handlers
    const type = msg.msg_type;
    if (type && this.handlers.has(type)) {
      this.handlers.get(type).forEach(fn => {
        try { fn(msg); } catch (e) { console.error(`Deriv message handler error [${type}]:`, e); }
      });
    }
  }

  /** Sync account balance via REST API and push to stores */
  async _syncAccountBalance() {
    try {
      const accounts = await this.fetchAccounts();
      const myAccount = accounts.find(a => a.account_id === this.accountId);
      if (myAccount) {
        this.accountInfo = {
          loginid: myAccount.account_id,
          balance: typeof myAccount.balance === 'number' ? myAccount.balance : parseFloat(myAccount.balance) || 0,
          currency: myAccount.currency || 'USD',
          fullname: '',
        };
        if (this.onAccountUpdate) this.onAccountUpdate({ ...this.accountInfo });
        useConnectionStore.setState({ balance: this.accountInfo.balance, currency: this.accountInfo.currency });
      }
    } catch (err) {
      console.warn('[derivWS] Failed to sync balance via REST:', err.message);
    }
  }

  // ═══════════════════════════════════════════════════════
  // Public API (unchanged interface for consumers)
  // ═══════════════════════════════════════════════════════

  send(payload, opts = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Deriv WebSocket connection not open'));
        return;
      }

      this.reqId += 1;
      const id = this.reqId;
      const reqPayload = { ...payload, req_id: id };
      this.pendingRequests.set(id, resolve);

      try {
        this.ws.send(JSON.stringify(reqPayload));
      } catch (e) {
        this.pendingRequests.delete(id);
        reject(e);
      }

      // Timeout request after 15 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          resolve({ error: { message: 'Request timed out' } });
        }
      }, 15000);
    });
  }

  sendRaw(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  on(msgType, handler) {
    if (!this.handlers.has(msgType)) {
      this.handlers.set(msgType, new Set());
    }
    this.handlers.get(msgType).add(handler);
    return () => this.handlers.get(msgType)?.delete(handler);
  }

  /** Subscribe to all market tick streams */
  subscribeAllMarkets(markets) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    markets.forEach(sym => {
      this.sendRaw({ ticks: sym, subscribe: 1 });
    });
  }

  disconnect() {
    clearTimeout(this.reconnectTimer);
    this._stopPing();
    this.token = null;
    this._wsUrl = null;
    this.pendingRequests.clear();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.status = 'disconnected';
    this._emitStatus();
  }

  _scheduleReconnect() {
    if (!this.token) return;
    this.reconnectTimer = setTimeout(() => {
      if (this._wsUrl) {
        this._connectWs();
      } else {
        this._connectLegacy();
      }
    }, 3000);
  }

  _emitStatus() {
    if (this.onStatusChange) this.onStatusChange(this.status);
    useConnectionStore.setState({ status: this.status });
  }

  setBackgroundMode(hidden) {
    const next = !!hidden;
    if (this._backgroundTab === next) return;
    this._backgroundTab = next;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this._startPing();
    }
  }

  _startPing() {
    this._stopPing();
    const intervalMs = 30000;
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ ping: 1 }));
      }
    }, intervalMs);
  }

  _stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  get isReady() {
    return this.status === 'authorized' && this.ws?.readyState === WebSocket.OPEN;
  }
}

const derivWS = new DerivWebSocket();
export default derivWS;
