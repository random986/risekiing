/* ══════════════════════════════════════════════════════════════
   DERIVPRINTER — Real Market Algorithmic Trade Engine
   Runs completely client-side in the browser.
   ══════════════════════════════════════════════════════════════ */

import { useRealMarketStore, ALL_MARKETS, MARKET_LABELS } from '../stores/useRealMarketStore.js';
import { extractDigit } from './marketScanner.js';
import { analyzeDigitCounter } from './digitCounter.js';
import useTradeStore from '../store/useTradeStore.js';
import useAccountStore from '../store/useAccountStore.js';
import useConfigStore from '../store/useConfigStore.js';
import derivWS from './derivWS.js';
import { toast } from 'react-hot-toast';

// Helpers
function avg(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length === 0) return 0;
  const mean = avg(arr);
  const variance = arr.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / arr.length;
  return Math.sqrt(variance);
}

function ema(values, period) {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

function getCurrenciesForMarket(marketId) {
  const MARKET_CURRENCIES = {
    frxEURUSD: ['EUR', 'USD'],
    frxGBPUSD: ['GBP', 'USD'],
    frxAUDJPY: ['AUD', 'JPY'],
    frxUSDJPY: ['USD', 'JPY'],
    frxUSDCHF: ['USD', 'CHF'],
    frxXAUUSD: ['USD'],
    frxXAGUSD: ['USD'],
    OTC_DJI: ['USD'],
    OTC_NDX100: ['USD'],
    OTC_FTSE: ['GBP']
  };
  return MARKET_CURRENCIES[marketId] || [];
}

const MARKET_FLOORS = {
  frxEURUSD: 0.00001,
  frxGBPUSD: 0.00001,
  frxAUDJPY: 0.001,
  frxUSDJPY: 0.001,
  frxUSDCHF: 0.00001,
  frxXAUUSD: 0.01,
  frxXAGUSD: 0.001,
  OTC_DJI: 1.0,
  OTC_NDX100: 1.0,
  OTC_FTSE: 1.0
};

function formatSpot(sym, price) {
  const p = Number(price);
  if (!Number.isFinite(p)) return '—';
  if (sym.includes('XAU') || sym.includes('XAG') || sym.startsWith('OTC')) return p.toFixed(2);
  if (sym.includes('JPY')) return p.toFixed(3);
  return p.toFixed(5);
}

const ENTRY_STATUS_RANK = { READY: 0, ARMED: 1, EXECUTING: 2, WATCHING: 3, WARMING: 4, BLOCKED: 5 };

class RealMarketEngine {
  constructor() {
    this.openTrades = [];
    this.placingOrders = new Set();
    this.chronoTimer = null;
    this._unsubTick = null;
    this._unsubContract = null;
    this.entryQueue = [];
    this.isProcessing = false;
    this.preloadDone = false;
    this.marketOpenState = {};
    this._lastOpenStatusFetch = 0;

    // Cooldown strictly after a LOSS (milliseconds).
    // "2 ticks" UX: deriv ticks are usually <2s, so 4s is the safe max window.
    this._postLossCooldownUntil = 0;
    
    // Data Buffers
    this.buffers = {};
    ALL_MARKETS.forEach(m => { this.buffers[m] = []; });
    this.alphaHistory = {};
    
    // News tracking
    this.newsEvents = [];
    
    // Virtual signals
    this.lastPrediction = {};
    this.virtualWins = { RISE: 0, FALL: 0 };
    this.virtualTotal = { RISE: 0, FALL: 0 };
    this.tradeHistory = {}; // for Duration Engine
    this.lastToastedSignal = {};
    this.lastToastedNews = {};
    this._running = false;
    this._preloadInFlight = false;
    this._newsPollTimer = null;
  }

  /** Markets visible on the live board (exchange open or already receiving tick data). */
  _shouldShowOnBoard(sym) {
    if (this.isMarketOpen(sym)) return true;
    return (this.buffers[sym]?.length || 0) >= 20;
  }

  /** True when most markets lack enough history to rank entries. */
  _needsPreload() {
    const warmed = ALL_MARKETS.filter(s => (this.buffers[s]?.length || 0) >= 50).length;
    return warmed < 3;
  }

  _attachWsListeners() {
    if (!this._unsubTick) {
      this._unsubTick = derivWS.on('tick', (msg) => {
        if (msg.tick) this.handleTick(msg.tick);
      });
    }
    if (!this._unsubContract) {
      this._unsubContract = derivWS.on('proposal_open_contract', (msg) => {
        this.handleContractUpdate(msg.proposal_open_contract);
      });
    }
  }

  _subscribeAllTicks() {
    const sub = () => {
      if (!derivWS.isReady) return;
      ALL_MARKETS.forEach(m => derivWS.sendRaw({ ticks: m, subscribe: 1 }));
    };
    if (derivWS.isReady) sub();
    else setTimeout(sub, 800);
  }

  _ensureChronoAndNews() {
    if (!this.chronoTimer) {
      this.chronoTimer = setInterval(() => this.runChronoTimer(), 1000);
    }
    if (!this._newsPollTimer) {
      this.fetchNews();
      this._newsPollTimer = setInterval(() => this.fetchNews(), 15 * 60 * 1000);
    }
  }

  ensureRunning(token) {
    this.start(token);
  }

  start(token) {
    const activeAccount = useAccountStore.getState().accounts.find(a => a.id === useAccountStore.getState().activeAccountId);
    const userToken = token || activeAccount?.token || localStorage.getItem('deriv_api_token') || '';
    const accountId = activeAccount?.loginid || activeAccount?.id;

    if (userToken) {
      localStorage.setItem('deriv_api_token', userToken);
    }

    this._attachWsListeners();
    this._ensureChronoAndNews();

    // Already scanning with live buffers — do not restart preload or reset the board.
    if (this._running) {
      derivWS.connect(userToken, accountId);
      this._subscribeAllTicks();
      if (this._needsPreload() && !this._preloadInFlight) {
        void this.preloadMarketHistory();
      } else {
        this.syncTradeOpportunities();
        this.updateWaitingStatus();
      }
      void this.fetchMarketOpenStatus();
      return;
    }

    this._running = true;
    useRealMarketStore.getState().setEngineStatus('INITIALIZING');
    useRealMarketStore.getState().pushTickFeed('Engine starting up (client-side)...', 'var(--text-muted)');

    derivWS.connect(userToken, accountId);
    this._subscribeAllTicks();

    useRealMarketStore.getState().setEngineStatus('SCANNING');
    useRealMarketStore.getState().pushTickFeed('Connected to Deriv. Scanning markets...', 'var(--success)');

    void this.preloadMarketHistory();
    void this.fetchMarketOpenStatus();
  }

  async fetchMarketOpenStatus() {
    try {
      const res = await derivWS.send({ active_symbols: 'brief', product_type: 'basic' });
      const symbols = res.active_symbols || [];
      const next = { ...this.marketOpenState };
      for (const sym of ALL_MARKETS) {
        const match = symbols.find(s => s.symbol === sym);
        if (match) {
          next[sym] = match.exchange_is_open === 1 || match.is_trading_suspended !== 1;
        } else if (sym.startsWith('OTC_')) {
          next[sym] = true;
        }
      }
      this.marketOpenState = next;
      this._lastOpenStatusFetch = Date.now();
      for (const sym of ALL_MARKETS) {
        useRealMarketStore.getState().setMarketData(sym, {
          isClosed: !this.isMarketOpen(sym),
        });
      }
      this.syncTradeOpportunities();
    } catch (err) {
      console.warn('[RealMarkets] active_symbols fetch failed, using tick fallback:', err?.message);
      for (const sym of ALL_MARKETS) {
        useRealMarketStore.getState().setMarketData(sym, {
          isClosed: !this.isMarketOpen(sym),
        });
      }
    }
  }

  isMarketOpen(sym) {
    if (sym.startsWith('OTC_')) return true;
    if (this.marketOpenState[sym] === true) return true;
    if (this.marketOpenState[sym] === false) {
      const buf = this.buffers[sym];
      if (buf?.length) {
        const lastMs = (buf[buf.length - 1].epoch || 0) * 1000;
        if (Date.now() - lastMs < 120000) return true;
      }
      return false;
    }
    const buf = this.buffers[sym];
    if (!buf?.length) return sym.startsWith('OTC_');
    const lastMs = (buf[buf.length - 1].epoch || 0) * 1000;
    return Date.now() - lastMs < 300000;
  }

  _openTradeCount() {
    return this.openTrades.filter(t => t.endTime == null).length;
  }

  _syncOpenTradesToStore() {
    const live = this.openTrades.filter(t => t.endTime == null);
    useRealMarketStore.getState().setOpenTrades(live);
    if (live.length) {
      useRealMarketStore.getState().setEngineStatus('TRADING');
    } else if (useRealMarketStore.getState().autoTrade) {
      useRealMarketStore.getState().setEngineStatus('SCANNING');
    }
  }

  _computeEntryChance(ea, m) {
    const statusBonus = {
      READY: 95, EXECUTING: 90, ARMED: 75, WATCHING: 45, WARMING: 15, BLOCKED: 0,
    };
    const base = statusBonus[ea?.status] ?? 20;
    const mcs = (ea?.mcsVal ?? m?.mcs?.total ?? 0) * 40;
    const progress = (ea?.progressPct ?? 0) * 0.25;
    return Math.round(Math.min(99, base + mcs + progress));
  }

  async preloadMarketHistory() {
    if (this._preloadInFlight) return;
    this._preloadInFlight = true;
    const PRELOAD_COUNT = 200;
    useRealMarketStore.getState().setEngineAnalysis('Analysing markets… prefetching tick history');
    let done = 0;
    await Promise.all(ALL_MARKETS.map(async (sym) => {
      try {
        const res = await derivWS.send({
          ticks_history: sym,
          end: 'latest',
          count: PRELOAD_COUNT,
          style: 'ticks',
        });
        if (res.history?.prices) {
          const prices = res.history.prices.slice(-PRELOAD_COUNT);
          const times = res.history.times || [];
          this.buffers[sym] = prices.map((price, i) => ({
            price: parseFloat(price),
            epoch: times[i] || Date.now() / 1000,
            bid: parseFloat(price),
            ask: parseFloat(price),
            spread: 0,
          }));
          useRealMarketStore.getState().setMarketData(sym, this.normalizeMarketAnalysis(this.analyzeMarket(sym)));
        }
      } catch (err) {
        console.error(`[RealMarkets] preload ${sym}:`, err);
      }
      done++;
      const warmed = ALL_MARKETS.filter(s => (this.buffers[s]?.length || 0) >= 100).length;
      useRealMarketStore.getState().setEngineAnalysis(
        `Analysing markets… ${done}/${ALL_MARKETS.length} loaded · ${warmed} ready (100+ ticks)`
      );
    }));
    this.preloadDone = true;
    this._preloadInFlight = false;
    const warmed = ALL_MARKETS.filter(s => (this.buffers[s]?.length || 0) >= 100).length;
    useRealMarketStore.getState().pushTickFeed(
      `Preload complete · ${warmed}/${ALL_MARKETS.length} markets at LIVE depth`,
      'var(--success)'
    );
    void this.fetchMarketOpenStatus();
    this.syncTradeOpportunities();
    this.updateWaitingStatus();
    void this.processQueue();
  }

  buildEntryCandidates() {
    const store = useRealMarketStore.getState();
    return ALL_MARKETS
      .filter(sym => this.isMarketOpen(sym))
      .map(sym => {
        const analysis = this.analyzeMarket(sym);
        return { sym, analysis, entry: analysis.entryAnalysis };
      })
      .filter(({ sym, analysis: a, entry }) => {
        if (a.status !== 'LIVE') return false;
        if (a.routing === 'BLOCKED' || store.newsBlocked.includes(sym)) return false;
        if (!store.autoSelect && store.selectedMarket !== 'AUTO' && store.selectedMarket !== sym) return false;
        const tradeType = a.signal || entry?.tradeType;
        if (!this._matchesContractFilter(tradeType, store.contractType)) return false;
        if (entry?.status !== 'READY') return false;
        return parseFloat(a.MCS) >= store.mcsFilter;
      })
      .sort((a, b) => parseFloat(b.analysis.MCS) - parseFloat(a.analysis.MCS));
  }

  _matchesContractFilter(signal, contractType) {
    if (!signal) return contractType === 'AUTO';
    if (contractType === 'RISE/FALL') return signal === 'RISE' || signal === 'FALL';
    if (contractType === 'ACCUMULATOR') return signal === 'ACCUMULATOR';
    return true;
  }

  buildEntryAnalysis(ctx) {
    const store = useRealMarketStore.getState();
    const {
      id, buf, latestPrice, routing, signal, MCS, TII, bbProx,
      ema9, ema21, alphaSigmas, prices, news,
    } = ctx;

    const tiiThreshold = store.tiiThreshold ?? 0.75;
    const bbThreshold = store.bbProxThreshold ?? 0.0005;
    const mcsFilter = store.mcsFilter ?? 0.4;
    const mcsVal = parseFloat(MCS) || 0;

    const prev21 = prices.slice(-21, -1);
    const targetHigh = prev21.length ? Math.max(...prev21) : latestPrice;
    const targetLow = prev21.length ? Math.min(...prev21) : latestPrice;

    let tradeType = null;
    let status = 'WARMING';
    let targetSpot = null;
    let targetCondition = '';
    let progressPct = 0;

    if (buf.length < 100) {
      status = 'WARMING';
      targetCondition = `${buf.length}/100 ticks buffered`;
      progressPct = (buf.length / 100) * 100;
      if (routing === 'ACCUMULATOR') tradeType = 'ACCUMULATOR';
      else if (routing === 'RISE/FALL') tradeType = ema9 >= ema21 ? 'RISE' : 'FALL';
    } else if (routing === 'BLOCKED' || news?.blocked) {
      status = 'BLOCKED';
      targetCondition = news?.blocked ? `News: ${news.event || 'blocked'}` : 'Spread / SVC too high';
    } else if (signal === 'RISE') {
      tradeType = 'RISE';
      targetSpot = targetHigh;
      const triggerMet = Number.isFinite(latestPrice) && latestPrice >= targetHigh;
      if (triggerMet) {
        status = mcsVal >= mcsFilter ? 'READY' : 'ARMED';
        targetCondition = 'spotted';
        progressPct = 100;
      } else {
        status = mcsVal >= mcsFilter ? 'ARMED' : 'WATCHING';
        targetCondition = `Waiting for a RISE at point ${formatSpot(id, targetHigh)}`;
        const gap = Math.max(0, targetHigh - latestPrice);
        const ref = Math.max(Math.abs(targetHigh), MARKET_FLOORS[id] || 0.00001);
        progressPct = Math.max(0, Math.min(99, (1 - gap / ref) * 100));
      }
    } else if (signal === 'FALL') {
      tradeType = 'FALL';
      targetSpot = targetLow;
      const triggerMet = Number.isFinite(latestPrice) && latestPrice <= targetLow;
      if (triggerMet) {
        status = mcsVal >= mcsFilter ? 'READY' : 'ARMED';
        targetCondition = 'spotted';
        progressPct = 100;
      } else {
        status = mcsVal >= mcsFilter ? 'ARMED' : 'WATCHING';
        targetCondition = `Waiting for a FALL at point ${formatSpot(id, targetLow)}`;
        const gap = Math.max(0, latestPrice - targetLow);
        const ref = Math.max(Math.abs(targetLow), MARKET_FLOORS[id] || 0.00001);
        progressPct = Math.max(0, Math.min(99, (1 - gap / ref) * 100));
      }
    } else if (signal === 'ACCUMULATOR') {
      tradeType = 'ACCUMULATOR';
      targetSpot = latestPrice;
      const tiiOk = TII < tiiThreshold;
      const bbOk = bbProx < bbThreshold;
      const accumulatorOk = tiiOk && bbOk;

      const tiiProg = Math.max(0, Math.min(100, ((tiiThreshold - TII) / tiiThreshold) * 100));
      const bbProg = bbThreshold > 0
        ? Math.max(0, Math.min(100, ((bbThreshold - bbProx) / bbThreshold) * 100))
        : 0;

      progressPct = (tiiProg + bbProg) / 2;
      if (accumulatorOk) {
        status = mcsVal >= mcsFilter ? 'READY' : 'ARMED';
        targetCondition = 'spotted';
        progressPct = 100;
      } else {
        status = mcsVal >= mcsFilter ? 'ARMED' : 'WATCHING';
        targetCondition = 'Squeeze overlap — enter at spot';
      }
    } else if (routing === 'ACCUMULATOR') {
      tradeType = 'ACCUMULATOR';
      const tiiOk = TII < tiiThreshold;
      const bbOk = bbProx < bbThreshold;
      const tiiProg = Math.max(0, Math.min(100, ((tiiThreshold - TII) / tiiThreshold) * 100));
      const bbProg = bbThreshold > 0
        ? Math.max(0, Math.min(100, ((bbThreshold - bbProx) / bbThreshold) * 100))
        : 0;
      progressPct = (tiiProg + bbProg) / 2;
      targetSpot = latestPrice;
      targetCondition = `TII < ${tiiThreshold} · BB prox < ${bbThreshold}`;
      status = (tiiOk && bbOk)
        ? (mcsVal >= mcsFilter ? 'READY' : 'ARMED')
        : 'WATCHING';
    } else if (routing === 'RISE/FALL') {
      const favorRise = ema9 > ema21 && alphaSigmas > 1;
      const favorFall = ema9 < ema21 && alphaSigmas > 1;
      tradeType = favorRise ? 'RISE' : favorFall ? 'FALL' : (latestPrice >= ema9 ? 'RISE' : 'FALL');
      targetSpot = tradeType === 'RISE' ? targetHigh : targetLow;
      const gap = Math.abs(latestPrice - targetSpot);
      const ref = Math.max(Math.abs(targetSpot), MARKET_FLOORS[id] || 0.00001);
      const triggerMet = tradeType === 'RISE'
        ? Number.isFinite(latestPrice) && latestPrice >= targetHigh
        : Number.isFinite(latestPrice) && latestPrice <= targetLow;

      if (triggerMet) {
        status = mcsVal >= mcsFilter ? 'READY' : 'ARMED';
        targetCondition = 'spotted';
        progressPct = 100;
      } else {
        status = mcsVal >= mcsFilter ? 'ARMED' : 'WATCHING';
        targetCondition = tradeType === 'RISE'
          ? `Waiting for a RISE at point ${formatSpot(id, targetHigh)}`
          : `Waiting for a FALL at point ${formatSpot(id, targetLow)}`;
        progressPct = Math.max(0, Math.min(99, (1 - gap / ref) * 100));
      }
    } else {
      status = 'WATCHING';
      targetCondition = 'Awaiting routing decision';
      if (routing === 'WAIT' && buf.length >= 20) {
        tradeType = ema9 >= ema21 ? 'RISE' : 'FALL';
      }
    }

    return {
      tradeType,
      status,
      currentSpot: latestPrice,
      currentSpotFmt: formatSpot(id, latestPrice),
      targetSpot,
      targetSpotFmt: targetSpot != null ? formatSpot(id, targetSpot) : '—',
      targetCondition,
      progressPct,
      tii: TII,
      tiiOk: TII < tiiThreshold,
      tiiThreshold,
      bbProx,
      bbOk: bbProx < bbThreshold,
      bbThreshold,
      mcsVal,
      mcsFilter,
    };
  }

  normalizeMarketAnalysis(raw) {
    const mcsVal = parseFloat(raw.MCS) || 0;
    const erVal = parseFloat(raw.ER) || 0;
    const svcVal = parseFloat(raw.SVC) || 0;
    const tiiVal = parseFloat(raw.TII) || 0;
    const bbProxRaw = raw.bbProxRaw ?? (parseFloat(raw.bbProx) || 0);

    return {
      symbol: raw.id,
      name: MARKET_LABELS[raw.id] || raw.id,
      lastPrice: raw.price,
      bid: raw.bid,
      ask: raw.ask,
      spread: raw.spread,
      tickCount: raw.ticks,
      er: erVal,
      svc: svcVal,
      routing: raw.routing,
      signal: raw.signal || null,
      tii: tiiVal,
      bbProx: bbProxRaw,
      alphaSigmas: parseFloat(raw.alphaSigmas) || 0,
      mcs: {
        trend: raw.trendAlign ?? 0,
        volume: raw.volConfirm ?? 0,
        spread: raw.spreadStab ?? 0,
        total: mcsVal,
      },
      suggestedDuration: raw.suggestedDuration,
      t50: parseFloat(raw.suggestedDuration?.T50) || 5,
      vixScaled: parseFloat(raw.suggestedDuration?.VIX) || 0.5,
      entryAnalysis: raw.entryAnalysis,
      statusBadge: raw.status === 'LIVE' ? (raw.signal ? 'SIGNAL' : 'LIVE') : raw.status,
      news: raw.news,
      lastTickTime: Date.now(),
      isClosed: raw.isClosed ?? false,
    };
  }

  syncTradeOpportunities() {
    const store = useRealMarketStore.getState();
    const contractType = store.contractType;
    const selected = store.selectedMarket;
    const autoSelect = store.autoSelect || selected === 'AUTO';
    const openTradeSyms = new Set(this.openTrades.filter(t => !t.endTime).map(t => t.market));

    const ops = ALL_MARKETS.map(sym => {
      if (!this._shouldShowOnBoard(sym)) return null;

      const raw = this.analyzeMarket(sym);
      const normalized = this.normalizeMarketAnalysis({
        ...raw,
        isClosed: false,
      });
      useRealMarketStore.getState().setMarketData(sym, normalized);

      const ea = normalized.entryAnalysis;
      if (!ea || ea.status === 'BLOCKED') return null;
      if (!autoSelect && selected !== sym) return null;

      if (contractType === 'RISE/FALL' && ea.tradeType === 'ACCUMULATOR') return null;
      if (contractType === 'ACCUMULATOR' && (ea.tradeType === 'RISE' || ea.tradeType === 'FALL')) return null;

      const executingTrade = this.openTrades.find(t => !t.endTime && t.market === sym);
      const status = executingTrade ? 'EXECUTING' : ea.status;
      const entryChance = this._computeEntryChance(ea, normalized);
      const livePnl = executingTrade?.livePnl;

      return {
        sym,
        symbol: sym,
        ...normalized,
        entryAnalysis: { ...ea, status, livePnl },
        entryChance,
        routing: normalized.routing,
        er: normalized.er,
        svc: normalized.svc,
      };
    }).filter(Boolean);

    ops.sort((a, b) => {
      const ra = ENTRY_STATUS_RANK[a.entryAnalysis.status] ?? 9;
      const rb = ENTRY_STATUS_RANK[b.entryAnalysis.status] ?? 9;
      if (ra !== rb) return ra - rb;
      const ec = (b.entryChance ?? 0) - (a.entryChance ?? 0);
      if (ec !== 0) return ec;
      const mc = (b.entryAnalysis.mcsVal ?? 0) - (a.entryAnalysis.mcsVal ?? 0);
      if (mc !== 0) return mc;
      return (a.sym || '').localeCompare(b.sym || '');
    });

    useRealMarketStore.getState().setTradeOpportunities(ops);
  }

  syncExecutionQueue() {
    const q = this.entryQueue.map(e => ({
      sym: e.sym,
      name: MARKET_LABELS[e.sym] || e.sym,
      tradeType: e.analysis.signal,
      mcs: parseFloat(e.analysis.MCS) || 0,
      spot: e.analysis.price,
      spotFmt: formatSpot(e.sym, e.analysis.price),
      targetCondition: e.analysis.entryAnalysis?.targetCondition || '',
    }));
    useRealMarketStore.getState().setExecutionQueue(q);
  }

  onAutoTradeStarted() {
    this.syncTradeOpportunities();
    this.enqueueCandidates();
    this.updateWaitingStatus();
    this.syncExecutionQueue();
  }

  updateWaitingStatus() {
    const store = useRealMarketStore.getState();
    const openCount = ALL_MARKETS.filter(s => this.isMarketOpen(s)).length;
    const closedCount = ALL_MARKETS.length - openCount;
    const candidates = this.buildEntryCandidates();
    const readyBoard = store.tradeOpportunities.filter(o => o.entryAnalysis?.status === 'READY').length;

    if (this._openTradeCount() > 0) {
      const live = this.openTrades.filter(t => !t.endTime);
      useRealMarketStore.getState().setEngineAnalysis(
        `✅ ${live.length} trade${live.length > 1 ? 's' : ''} open · ${readyBoard} setups ready · ${openCount} markets open`
      );
      this.syncExecutionQueue();
      this.syncTradeOpportunities();
      return;
    }
    if (!candidates.length) {
      const warmed = ALL_MARKETS.filter(s => this.isMarketOpen(s) && (this.buffers[s]?.length || 0) >= 20).length;
      useRealMarketStore.getState().setEngineAnalysis(
        this.preloadDone
          ? `${openCount} open · ${closedCount} closed · ${warmed} live · ${readyBoard} entry-ready · watching for trigger points`
          : `Loading tick history… ${warmed}/${openCount} markets receiving data`
      );
      this.syncExecutionQueue();
      this.syncTradeOpportunities();
      return;
    }
    const lines = candidates.slice(0, 2).map(c => {
      const label = MARKET_LABELS[c.sym] || c.sym;
      const ea = c.analysis.entryAnalysis;
      return `🎯 ${label} · ${ea?.tradeType || c.analysis.signal} READY (MCS ${c.analysis.MCS})`;
    });
    useRealMarketStore.getState().setEngineAnalysis(
      `${openCount} open markets · ${lines.join(' · ')}`
    );
    this.syncExecutionQueue();
    this.syncTradeOpportunities();
  }

  enqueueCandidates() {
    const store = useRealMarketStore.getState();
    const max = store.maxConcurrentTrades || 2;
    const slots = max - this._openTradeCount();
    if (slots <= 0) return;
    if (Date.now() < this._postLossCooldownUntil) return;

    const fresh = this.buildEntryCandidates().slice(0, slots);
    for (const entry of fresh) {
      const exists = this.entryQueue.some(
        e => e.sym === entry.sym && e.analysis.signal === entry.analysis.signal
      );
      const alreadyOpen = this.openTrades.some(t => !t.endTime && t.market === entry.sym);
      if (!exists && !alreadyOpen) this.entryQueue.push(entry);
    }
    this.updateWaitingStatus();
    void this.processQueue();
  }

  async processQueue() {
    if (this.isProcessing) return;
    const store = useRealMarketStore.getState();
    if (!store.autoTrade || store.killSwitchActive) return;
    if (store.pauseUntil > 0 && Date.now() < store.pauseUntil) return;
    if (Date.now() < this._postLossCooldownUntil) return;

    const max = store.maxConcurrentTrades || 2;

    this.isProcessing = true;
    try {
      while (
        this.entryQueue.length > 0
        && this._openTradeCount() < max
      ) {
        const entry = this.entryQueue.shift();
        const mcsTotal = parseFloat(entry.analysis.MCS) || 0;
        const vixScaled = parseFloat(entry.analysis.suggestedDuration?.VIX) || 0.5;
        useRealMarketStore.getState().setEngineAnalysis(
          `Executing: ${entry.analysis.signal || entry.analysis.entryAnalysis?.tradeType} on ${MARKET_LABELS[entry.sym] || entry.sym}…`
        );
        await this.checkAutoTrade(entry.sym, entry.analysis.signal, mcsTotal, vixScaled, true);
        this.syncExecutionQueue();
        this.syncTradeOpportunities();
      }
    } finally {
      this.isProcessing = false;
      if (store.autoTrade && this._openTradeCount() < max) {
        const fresh = this.buildEntryCandidates().slice(0, max - this._openTradeCount());
        for (const entry of fresh) {
          const exists = this.entryQueue.some(e => e.sym === entry.sym);
          const open = this.openTrades.some(t => !t.endTime && t.market === entry.sym);
          if (!exists && !open) this.entryQueue.push(entry);
        }
        if (this.entryQueue.length) void this.processQueue();
        else this.updateWaitingStatus();
      } else {
        this.updateWaitingStatus();
      }
    }
  }

  stop() {
    this._running = false;
    if (this._unsubTick) {
      this._unsubTick();
      this._unsubTick = null;
    }
    if (this._unsubContract) {
      this._unsubContract();
      this._unsubContract = null;
    }
    if (this.chronoTimer) {
      clearInterval(this.chronoTimer);
      this.chronoTimer = null;
    }
    if (this._newsPollTimer) {
      clearInterval(this._newsPollTimer);
      this._newsPollTimer = null;
    }

    derivWS.sendRaw({ forget_all: 'ticks' });

    useRealMarketStore.getState().setEngineStatus('IDLE');
    useRealMarketStore.getState().pushTickFeed('Engine stopped.', 'var(--text-muted)');
  }

  async fetchNews() {
    try {
      const res = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json");
      if (!res.ok) throw new Error(`HTTP status ${res.status}`);
      const events = await res.json();
      this.newsEvents = events;
      useRealMarketStore.getState().setNewsEvents(events.slice(0, 10));
    } catch (err) {
      console.error('[News Engine] Failed to fetch news calendar:', err.message);
    }
  }

  getNewsStatus(marketId) {
    const currencies = getCurrenciesForMarket(marketId);
    const now = Date.now() / 1000;
    
    let blocked = false;
    let warning = false;
    let minsAway = 999999;
    let eventTitle = '';

    for (const event of this.newsEvents) {
      if (!currencies.includes(event.currency)) continue;
      if (event.impact !== "High") continue;
      
      const eventTime = new Date(event.date).getTime() / 1000;
      if (isNaN(eventTime)) continue;

      const diffMins = (eventTime - now) / 60;
      
      if (diffMins >= -10 && diffMins <= 5) {
        blocked = true;
        minsAway = diffMins;
        eventTitle = event.title;
        const now = Date.now();
        if (!this.lastToastedNews[eventTitle] || now - this.lastToastedNews[eventTitle] > 600000) {
          this.lastToastedNews[eventTitle] = now;
          toast(`High Impact News in ${Math.max(0, diffMins).toFixed(0)}m: ${eventTitle}`, {
            icon: '📰',
            duration: 6000,
            style: { background: 'var(--bg-card)', color: 'var(--amber)', border: '1px solid var(--amber)' }
          });
        }
        break;
      }
      if (diffMins > 5 && diffMins <= 30) {
        warning = true;
        minsAway = diffMins;
        eventTitle = event.title;
      }
    }

    return { blocked, warning, minsAway, event: eventTitle };
  }

  handleTick(tick) {
    const id = tick.symbol;
    if (!ALL_MARKETS.includes(id)) return;

    this.marketOpenState[id] = true;

    let price = parseFloat(tick.quote);

    const epoch = tick.epoch;
    const bidRaw = parseFloat(tick.bid);
    const askRaw = parseFloat(tick.ask);

    // Some OTC ticks may not populate quote reliably; fall back to bid/ask.
    if (!Number.isFinite(price)) {
      if (Number.isFinite(bidRaw)) price = bidRaw;
      else if (Number.isFinite(askRaw)) price = askRaw;
      else return;
    }

    const bid = Number.isFinite(bidRaw) ? bidRaw : price;
    const ask = Number.isFinite(askRaw) ? askRaw : price;
    const spread = ask - bid;
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || !Number.isFinite(spread)) return;

    const buf = this.buffers[id];
    buf.push({ price, epoch, bid, ask, spread });
    if (buf.length > 500) buf.shift();

    // Re-run analysis on this market every tick
    const analysis = this.analyzeMarket(id);
    useRealMarketStore.getState().setMarketData(id, this.normalizeMarketAnalysis({
      ...analysis,
      isClosed: false,
    }));

    if (this._lastOpportunitySync == null || Date.now() - this._lastOpportunitySync > 400) {
      this._lastOpportunitySync = Date.now();
      this.syncTradeOpportunities();
      if (!useRealMarketStore.getState().autoTrade) {
        this.updateWaitingStatus();
      }
    }

    if (useRealMarketStore.getState().autoTrade) {
      this.updateWaitingStatus();
      const entry = analysis.entryAnalysis;
      const mcsTotal = parseFloat(analysis.MCS) || 0;
      const store = useRealMarketStore.getState();

      if (
        analysis.status === 'LIVE'
        && entry?.status === 'READY'
        && mcsTotal >= store.mcsFilter
        && Date.now() >= this._postLossCooldownUntil
        && this._openTradeCount() < (store.maxConcurrentTrades || 2)
      ) {
        const now = Date.now();
        if (!this.lastToastedSignal[id] || now - this.lastToastedSignal[id] > 300000) {
          this.lastToastedSignal[id] = now;
          toast.success(`Entry ready: ${entry.tradeType} on ${MARKET_LABELS[id] || id} (MCS ${mcsTotal.toFixed(2)})`, {
            icon: '🎯',
            duration: 5000,
            style: { background: 'var(--bg-card)', color: 'var(--success)' },
          });
        }

        if (!this.isProcessing) {
          this.enqueueCandidates();
          if (typeof document !== 'undefined' && document.hidden) {
            void this.processQueue();
          }
        } else {
          const exists = this.entryQueue.some(e => e.sym === id);
          const open = this.openTrades.some(t => !t.endTime && t.market === id);
          if (!exists && !open) {
            this.entryQueue.push({ sym: id, analysis });
            this.syncExecutionQueue();
          }
        }
      }
    }
  }

  analyzeMarket(id) {
    const buf = this.buffers[id];
    const floor = MARKET_FLOORS[id] || 0.00001;
    
    if (buf.length < 20) {
      const latestPrice = buf.length ? buf[buf.length - 1].price : NaN;
      const entryAnalysis = this.buildEntryAnalysis({
        id, buf, latestPrice,
        routing: 'WAIT', signal: null, MCS: '0.000', TII: 0, bbProx: 0,
        ema9: 0, ema21: 0, alphaSigmas: 0, prices: buf.map(t => t.price), news: this.getNewsStatus(id),
      });
      return {
        id, status: 'WARMING', ticks: buf.length, routing: 'WAIT',
        price: latestPrice,
        entryAnalysis,
      };
    }

    const prices = buf.map(t => t.price);
    const latestPrice = prices[prices.length - 1];
    const latestTick = buf[buf.length - 1];

    // ER
    const n = Math.min(buf.length, 100);
    const slice = prices.slice(-n);
    const direction = Math.abs(slice[slice.length - 1] - slice[0]);
    let noise = 0;
    for (let i = 1; i < slice.length; i++) {
      noise += Math.abs(slice[i] - slice[i - 1]);
    }
    const ER = noise > 1e-10 ? direction / noise : 0;

    // ATR
    const last20 = prices.slice(-20);
    let rawATR = 0;
    for (let i = 1; i < last20.length; i++) {
      rawATR += Math.abs(last20[i] - last20[i - 1]);
    }
    rawATR /= (last20.length - 1);
    const ATR = Math.max(rawATR, floor);

    // SVC
    const SVC = Math.min(latestTick.spread / ATR, 9.999);

    // News Check
    const news = this.getNewsStatus(id);

    // Routing Decision
    let routing = "WAIT";
    if (SVC > 0.25 || news.blocked) {
      routing = "BLOCKED";
    } else if (ER >= 0.60 && SVC <= 0.15) {
      routing = "RISE_FALL";
    } else if (ER <= 0.30) {
      routing = "ACCUMULATOR";
    }

    // EMAs
    const ema9 = ema(prices.slice(-9), 9);
    const ema21 = ema(prices.slice(-21), 21);

    // Velocity Acceleration (α)
    const epochs = buf.map(t => t.epoch);
    const velocities = [];
    for (let i = 1; i < buf.length; i++) {
      const dt = Math.max(epochs[i] - epochs[i - 1], 0.001);
      velocities.push(Math.abs(prices[i] - prices[i - 1]) / dt);
    }
    const Vsmooth_now = ema(velocities.slice(-5), 5);
    const Vsmooth_prev = ema(velocities.slice(-6, -1), 5);
    const alpha = Vsmooth_now - Vsmooth_prev;

    if (!this.alphaHistory[id]) this.alphaHistory[id] = [];
    const alphaHistory = this.alphaHistory[id];
    alphaHistory.push(alpha);
    if (alphaHistory.length > 50) alphaHistory.shift();

    const mu_a = avg(alphaHistory);
    const sig_a = stddev(alphaHistory);
    const alphaSigmas = sig_a > 0 ? (alpha - mu_a) / sig_a : 0;

    // Bollinger Bands (3σ)
    const bb20 = prices.slice(-20);
    const bbMid = avg(bb20);
    const bbStd = stddev(bb20);
    const bbUpper3 = bbMid + 3 * bbStd;
    const bbLower3 = bbMid - 3 * bbStd;
    const bbProx = Math.min(
      Math.abs(latestPrice - bbUpper3) / Math.max(bbUpper3, 0.0001),
      Math.abs(latestPrice - bbLower3) / Math.max(bbLower3, 0.0001)
    );

    // Signals
    let signal = null;
    if (routing === "RISE_FALL" && buf.length >= 100) {
      const broke_high = latestPrice > Math.max(...prices.slice(-21, -1));
      const broke_low = latestPrice < Math.min(...prices.slice(-21, -1));
      if (broke_high && alphaSigmas > 2 && ema9 > ema21) signal = "RISE";
      if (broke_low && alphaSigmas > 2 && ema9 < ema21) signal = "FALL";
    } else if (routing === "ACCUMULATOR" && buf.length >= 100) {
      const trendAlign = Math.max(0, 1 - ER);
      const recent = buf.slice(-60);
      const hist = buf.slice(-240);
      const avgChange = arr => {
        let s = 0;
        for (let i = 1; i < arr.length; i++) s += Math.abs(arr[i].price - arr[i - 1].price);
        return s / Math.max(arr.length - 1, 1);
      };
      const TII = (recent.length * avgChange(recent)) / (hist.length * avgChange(hist) + 1e-10);
      const volConfirm = Math.min(Math.max(0, 1 - TII), 1);
      const spreadStab = Math.min(Math.max(0, 1 - SVC / 0.25), 1);
      const MCS = 0.40 * trendAlign + 0.35 * volConfirm + 0.25 * spreadStab;
      if (MCS >= 0.70) {
        signal = "ACCUMULATOR";
      }
    }

    // TII
    const recent = buf.slice(-60);
    const hist = buf.slice(-240);
    const avgChange = arr => {
      let s = 0;
      for (let i = 1; i < arr.length; i++) s += Math.abs(arr[i].price - arr[i - 1].price);
      return s / Math.max(arr.length - 1, 1);
    };
    const TII = (recent.length * avgChange(recent)) / (hist.length * avgChange(hist) + 1e-10);

    // MCS
    const trendAlign = routing === "ACCUMULATOR" ? Math.max(0, 1 - ER) : Math.min(ER, 1);
    const volConfirm = routing === "ACCUMULATOR" ? Math.min(Math.max(0, 1 - TII), 1) : Math.min(Math.max(0, alphaSigmas / 3), 1);
    const spreadStab = Math.min(Math.max(0, 1 - SVC / 0.25), 1);
    const MCS = 0.40 * trendAlign + 0.35 * volConfirm + 0.25 * spreadStab;

    const entryAnalysis = this.buildEntryAnalysis({
      id, buf, latestPrice, routing, signal,
      MCS: MCS.toFixed(3), TII, bbProx, ema9, ema21, alphaSigmas, prices, news,
    });

    // Virtual Wins Tracker
    if (buf.length >= 2) {
      const prediction = latestPrice > ema9 ? "RISE" : "FALL";
      const prevPrediction = this.lastPrediction[id];
      if (prevPrediction) {
        const prevPrice = buf[buf.length - 2].price;
        const wentUp = latestPrice > prevPrice;
        if (prevPrediction === "RISE" && wentUp) this.virtualWins.RISE++;
        if (prevPrediction === "FALL" && !wentUp) this.virtualWins.FALL++;
        this.virtualTotal.RISE += prevPrediction === "RISE" ? 1 : 0;
        this.virtualTotal.FALL += prevPrediction === "FALL" ? 1 : 0;
        
        useRealMarketStore.setState({
          virtualRise: { wins: this.virtualWins.RISE, total: this.virtualTotal.RISE },
          virtualFall: { wins: this.virtualWins.FALL, total: this.virtualTotal.FALL }
        });
      }
      this.lastPrediction[id] = prediction;
    }

    // Suggested Duration Engine
    const suggestedDuration = this.computeSuggestedDuration(id, ER, ATR, news, buf);

    return {
      id,
      price: latestPrice,
      bid: latestTick.bid,
      ask: latestTick.ask,
      spread: latestTick.spread,
      ticks: buf.length,
      ER: ER.toFixed(4),
      SVC: SVC.toFixed(4),
      ATR: ATR.toFixed(6),
      routing,
      signal,
      signalTimestamp: signal ? Date.now() : null,
      ema9,
      ema21,
      alpha,
      alphaSigmas: alphaSigmas.toFixed(2),
      MCS: MCS.toFixed(3),
      TII: TII.toFixed(3),
      bbProxRaw: bbProx,
      trendAlign,
      volConfirm,
      spreadStab,
      entryAnalysis,
      news,
      suggestedDuration,
      status: buf.length < 100 ? "WARMING" : "LIVE"
    };
  }

  computeSuggestedDuration(marketId, ER, ATR, news, buf) {
    const history = this.tradeHistory[marketId] || [];
    const wins = history.filter(t => t.won);
    const T50 = wins.length >= 3 ? avg(wins.slice(-10).map(t => t.durationMins)) : 5.0;

    const atrs = [];
    for (let i = 1; i < Math.min(buf.length, 21); i++) {
      atrs.push(Math.abs(buf[i].price - buf[i - 1].price));
    }
    const ATRavg = avg(atrs) || ATR;
    const VIX = Math.min(Math.max((ATR / ATRavg) - 0.5, 0.1), 1.0);

    let computed = T50 * (1 - VIX);
    computed = Math.min(Math.max(computed, 1), 15);

    if (news.warning && news.minsAway < 12) {
      computed = 1;
    } else if (news.warning && news.minsAway < 30) {
      computed = Math.min(computed, 3);
    }

    const hour = new Date().getUTCHours();
    const isOverlap = hour >= 13 && hour < 17;
    const isLondon = hour >= 8 && hour < 17;
    const isNY = hour >= 13 && hour < 22;

    if (isOverlap) computed = Math.min(computed * 0.8, 5);
    if (!isLondon && !isNY && !isOverlap) computed = Math.min(computed * 1.3, 10);

    return {
      computed: Math.round(computed),
      T50: T50.toFixed(1),
      VIX: VIX.toFixed(2),
      reasoning: `T50: ${T50.toFixed(1)}m · VIX: ${VIX.toFixed(2)}`
    };
  }

  async checkAutoTrade(sym, signal, mcsTotal, vixScaled, fromQueue = false) {
    if (this.placingOrders.has(sym)) return;

    const store = useRealMarketStore.getState();
    if (!store.autoTrade || store.killSwitchActive) return;
    if (store.pauseUntil > 0 && Date.now() < store.pauseUntil) return;
    if (Date.now() < this._postLossCooldownUntil) return;
    if (!this.isMarketOpen(sym)) return;

    const max = store.maxConcurrentTrades || 2;
    if (this._openTradeCount() >= max) return;

    if (store.newsBlocked.includes(sym)) return;
    if (!store.autoSelect && store.selectedMarket !== sym && store.selectedMarket !== 'AUTO') return;
    if (mcsTotal < store.mcsFilter) return;

    const entry = store.markets[sym]?.entryAnalysis;
    if (entry?.status !== 'READY') return;

    const alreadyOpen = this.openTrades.some(t => !t.endTime && t.market === sym);
    if (alreadyOpen) return;

    const cfg = useConfigStore.getState();
    if (cfg?.takeProfit > 0) {
      if (cfg.takeProfitType === 'wins') {
        if (store.sessionWins >= cfg.takeProfit) {
          store.setAutoTrade(false);
          store.setEngineStatus('PAUSED');
          store.pushTickFeed(`Take Profit reached — ${store.sessionWins} wins. Pausing new entries.`, 'var(--success)');
          return;
        }
      } else {
        if (store.dailyPnL >= cfg.takeProfit) {
          store.setAutoTrade(false);
          store.setEngineStatus('PAUSED');
          store.pushTickFeed(`Take Profit reached — PnL is +$${store.dailyPnL.toFixed(2)}. Pausing new entries.`, 'var(--success)');
          return;
        }
      }
    }

    let shouldTrade = false;
    let typeStr = '';
    const effectiveSignal = signal || entry?.tradeType;

    if ((effectiveSignal === 'RISE' || signal === 'RISE') && (store.contractType === 'AUTO' || store.contractType === 'RISE/FALL')) {
      shouldTrade = true;
      typeStr = 'RISE';
    } else if ((effectiveSignal === 'FALL' || signal === 'FALL') && (store.contractType === 'AUTO' || store.contractType === 'RISE/FALL')) {
      shouldTrade = true;
      typeStr = 'FALL';
    } else if ((effectiveSignal === 'ACCUMULATOR' || signal === 'ACCUMULATOR') && (store.contractType === 'AUTO' || store.contractType === 'ACCUMULATOR')) {
      shouldTrade = true;
      typeStr = 'ACCUM';
    }

    if (!shouldTrade) return;

    this.placingOrders.add(sym);
    useRealMarketStore.getState().setEngineStatus('SIGNAL_FOUND');

    try {
      const stakeAmount = store.baseStake;

      let durationVal = 3;
      if (store.expiry === 'AUTO') {
        const suggest = store.markets[sym]?.suggestedDuration?.computed;
        durationVal = suggest ? parseInt(suggest, 10) : 3;
      } else {
        durationVal = parseInt(store.expiry, 10) || 3;
      }

      const proposalPayload = {
        proposal: 1,
        amount: Number(stakeAmount.toFixed(2)),
        basis: 'stake',
        currency: store.currency || 'USD',
        symbol: sym,
      };

      if (typeStr === 'ACCUM') {
        proposalPayload.contract_type = 'ACCU';
        proposalPayload.growth_rate = 0.01;
      } else {
        proposalPayload.contract_type = typeStr === 'RISE' ? 'CALL' : 'PUT';
        proposalPayload.duration = durationVal;
        proposalPayload.duration_unit = 'm';
      }

      useRealMarketStore.getState().pushTickFeed(`Requesting proposal for ${sym}…`, 'var(--text-muted)');
      const propRes = await derivWS.send(proposalPayload);

      if (propRes.error) {
        useRealMarketStore.getState().pushTickFeed(`Proposal failed: ${propRes.error.message}`, 'var(--crimson)');
        return;
      }

      const proposalId = propRes.proposal?.id;
      const askPrice = propRes.proposal?.ask_price;
      if (!proposalId) {
        useRealMarketStore.getState().pushTickFeed('No proposal ID returned.', 'var(--crimson)');
        return;
      }

      useRealMarketStore.getState().pushTickFeed(`Executing buy for ${sym}…`, 'var(--text-muted)');
      const buyRes = await derivWS.send({ buy: proposalId, price: askPrice });

      if (buyRes.error) {
        useRealMarketStore.getState().pushTickFeed(`Buy failed: ${buyRes.error.message}`, 'var(--crimson)');
        return;
      }

      if (buyRes.buy) {
        const contractId = buyRes.buy.contract_id;

        const newTrade = {
          id: contractId,
          market: sym,
          type: typeStr,
          duration: typeStr === 'ACCUM' ? 'Accumulator' : `${durationVal}m`,
          stake: askPrice,
          mcs: mcsTotal,
          startTime: Date.now(),
          endTime: null,
          won: null,
          pnl: null,
          kMaxRemaining: typeStr === 'ACCUM' ? 60 : durationVal * 60,
        };

        this.openTrades.push(newTrade);
        this._syncOpenTradesToStore();
        useRealMarketStore.getState().pushTickFeed(
          `⚡ TRADE PLACED: ${MARKET_LABELS[sym] || sym} ${typeStr} $${Number(askPrice).toFixed(2)}`,
          '#fff'
        );
        derivWS.sendRaw({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
        this.syncTradeOpportunities();
      }
    } catch (err) {
      console.error('Auto trade purchase error:', err);
    } finally {
      this.placingOrders.delete(sym);
      if (this._openTradeCount() === 0) {
        useRealMarketStore.getState().setEngineStatus('SCANNING');
      }
    }
  }

  handleContractUpdate(contract) {
    if (!contract || !contract.contract_id) return;
    const cid = contract.contract_id;

    const idx = this.openTrades.findIndex(t => t.id === cid);
    if (idx === -1) return;

    const trade = this.openTrades[idx];

    // Live (not yet sold): update live P&L for UI.
    if (!contract.is_sold) {
      const liveProfit = parseFloat(contract.profit);
      if (Number.isFinite(liveProfit)) trade.livePnl = liveProfit;
      this._syncOpenTradesToStore();
      this.syncTradeOpportunities();
      return;
    }

    // Sold: finalize trade.
    this.openTrades.splice(idx, 1);

    const won = contract.status === 'won';
    const profit = parseFloat(contract.profit) || 0;

    trade.won = won;
    trade.pnl = profit;
    trade.livePnl = profit;
    trade.endTime = Date.now();
    
    useRealMarketStore.getState().recordTradeResult(trade);
    this._syncOpenTradesToStore();
    useRealMarketStore.getState().pushTickFeed(
      `${won ? '✅' : '❌'} TRADE RESULT: ${trade.market} ${trade.type} → ${won ? 'WON' : 'LOST'} ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`,
      won ? 'var(--success)' : 'var(--crimson)'
    );

    // Cooldown strictly after LOSS (prevents rapid re-entry).
    if (!won) {
      this._postLossCooldownUntil = Date.now() + 4000; // ~2 ticks max
      useRealMarketStore.getState().setEngineStatus('PAUSED');
    }

    // Track for duration engine
    if (!this.tradeHistory[trade.market]) this.tradeHistory[trade.market] = [];
    let durMins = 3;
    if (trade.duration.includes('m')) durMins = parseInt(trade.duration, 10);
    this.tradeHistory[trade.market].push({ won, durationMins: durMins });
    if (this.tradeHistory[trade.market].length > 100) this.tradeHistory[trade.market].shift();

    derivWS.send({ forget: contract.id || cid }).catch(() => {});

    this.syncTradeOpportunities();
    void this.processQueue();
  }

  runChronoTimer() {
    const store = useRealMarketStore.getState();
    const now = Date.now();

    if (now - (this._lastOpenStatusFetch || 0) > 120000) {
      void this.fetchMarketOpenStatus();
    }

    // Session Status Update
    const h = new Date().getUTCHours();
    const m = new Date().getUTCMinutes();
    const t = h + m / 60;
    const session = {
      sydney: t >= 22 || t < 7,
      tokyo: t >= 0 && t < 9,
      london: t >= 8 && t < 17,
      newYork: t >= 13 && t < 22,
      overlap: t >= 13 && t < 17,
      quality: (t >= 13 && t < 17) ? "PRIME" : (t >= 8 && t < 17) || (t >= 13 && t < 22) ? "ACTIVE" : "LOW"
    };
    // No direct session store field, but can update UI later if needed.

    if (store.pauseUntil > 0) {
      if (now >= store.pauseUntil) {
        useRealMarketStore.getState().pushTickFeed('Pause period completed. Resuming...', 'var(--success)');
        useRealMarketStore.getState().recordTradeResult({ won: true, pnl: 0, startTime: now, endTime: now, market: '', type: 'RESET' });
        useRealMarketStore.getState().setEngineStatus('SCANNING');
      } else {
        const diff = store.pauseUntil - now;
        const mins = Math.floor(diff / 60000);
        const secs = Math.floor((diff % 60000) / 1000);
        const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        useRealMarketStore.getState().setEngineAnalysis(`Engine paused due to loss threshold. Auto-resuming in ${timeStr}`);
      }
    }

    if (this.openTrades.length > 0) {
      this.openTrades.forEach(trade => {
        if (trade.endTime === null) {
          let durationMs = 3 * 60000;
          if (trade.duration.includes('m')) {
            durationMs = parseInt(trade.duration, 10) * 60 * 1000;
          } else {
            durationMs = 60 * 1000;
          }
          const elapsed = now - trade.startTime;
          const remaining = Math.max(0, Math.round((durationMs - elapsed) / 1000));
          trade.kMaxRemaining = remaining;
        }
      });
      this._syncOpenTradesToStore();
    }
  }

  wakeFromBackgroundTab() {
    if (!useRealMarketStore.getState().autoTrade) return;
    this.syncTradeOpportunities();
    if (!this.isProcessing) {
      void this.processQueue();
    }
  }

  async engageKillSwitch() {
    useRealMarketStore.getState().setAutoTrade(false);
    useRealMarketStore.getState().setEngineStatus('PAUSED');
    useRealMarketStore.getState().setMarketData(useRealMarketStore.getState().selectedMarket, { killSwitchActive: true });
    
    if (!useRealMarketStore.getState().killSwitchActive) {
      useRealMarketStore.getState().toggleKillSwitch();
    }
    
    useRealMarketStore.getState().pushTickFeed('🚨 KILL SWITCH ENGAGED! Dispatching early exit...', 'var(--crimson)');
    
    const activeOpenTrades = [...this.openTrades];
    this.openTrades = [];
    
    for (const trade of activeOpenTrades) {
      if (trade.id) {
        useRealMarketStore.getState().pushTickFeed(`Selling contract ${trade.id} early...`, 'var(--crimson)');
        try {
          await derivWS.send({ sell: trade.id, price: 0 });
        } catch (e) {
          console.error(`Kill switch early sell error:`, e);
        }
      }
    }
  }
}

export const engine = new RealMarketEngine();
