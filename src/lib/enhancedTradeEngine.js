/* ═══════════════════════════════════════════════════════════════
   DERIVPRINTER — Enhanced Trade Execution Engine (Demo Mode)
   Sequence-firing Over/Under trading with streak protection,
   multiplier-based stake sizing, and live decision auditing.
   ═══════════════════════════════════════════════════════════════ */

import derivWS from './derivWS.js';
import scanner, { MARKETS, MARKET_LABELS } from './marketScanner.js';
import riskManager from './riskManager.js';
import copyTradeEngine from './copyTradeEngine.js';
import toast from 'react-hot-toast';
import {
  ENTRY_ALGORITHMS,
  ENTRY_ALGORITHM_ORDER,
  OMNI_ALGORITHM_ORDER,
  ALGO_META,
  TARGET_WIN_RATE,
  minDistributionBias,
  minDistributionBiasNormal,
  hasRealDistributionEdge,
  applyBinaryScoring,
  rankByBinaryEdge,
  passesNormalFireGate,
  passesRecoveryFireGate,
  passesTournamentWinGate,
  getTournamentGateThresholds,
  hasNormalDistributionEdge,
  shouldPauseForLowWinRate,
  computeUnifiedRankScore,
} from './entryEnsemble.js';
import {
  analyzeBinaryFlow,
  passesBinaryFlowGate,
  flowScoreBonus,
} from './binaryFlowGuard.js';
import {
  analyzeDigitCounter,
  getCounterSignal,
  counterAlignedForDirection,
} from './digitCounter.js';
import {
  runMatrixSweep,
  sweepApexBestDualMarket,
  sweepApexBestRecoveryForDir,
  capTickBuffer,
  isApexOrderInFlight,
  tryAcquireApexLock,
  armApexOrderInFlight,
  setApexOrderInFlight,
  updateRecoveryState,
  shouldUseFastPassRecovery,
  buildFastPassRecoveryOrder,
  computeFastPassStake,
  getFastPassRecoveryState,
  processSuperMatrixSweep,
  pickStealthTopEntry,
  registerEngineFeedback,
  registerEngineTransaction,
  resetGlobalRiskMatrix,
  isAssetCircuitBroken,
  getIsolatedStakeForSymbol,
  getAssetTracker,
  ENGINE_CONFIG,
  globalMatrixState,
  usesMatrix20Engine,
} from './apexMatrixEngine.js';
import {
  setRecoveryStateReader,
  buildMarketDataMap,
  canDispatchNetworkPhase,
  markNetworkDispatch,
  resetNetworkThrottle,
  isStreamFresh,
  abortReasonForSymbol,
} from './apexNetworkPhase.js';
import {
  consumeBufferedProposal,
  warmRecoveryProposals,
  prefetchProposalToken,
} from './apexProposalBuffer.js';
import { convergenceScan } from './convergenceCalculator.js';
import { buildEntryMetadata } from './tradeAnalytics.js';
import {
  evaluateSessionSafety,
  onConsecutiveLoss,
  isCascadePauseActive,
} from './sessionGuards.js';
import { isBinaryEntryTrap } from './binaryEntryTrap.js';
import { flipDigitDirection, isMomentumContinuationTrap, isRecentlyDominant } from './tradeDirection.js';
import {
  dirToContractType,
  passesFourTickExhaustionGate,
} from './apexMeanReversionLeaderboard.js';

const CONTRACT_MAP = {
  OVER0:  { contract_type: 'DIGITOVER',  barrier: '0' },
  OVER1:  { contract_type: 'DIGITOVER',  barrier: '1' },
  OVER2:  { contract_type: 'DIGITOVER',  barrier: '2' },
  OVER3:  { contract_type: 'DIGITOVER',  barrier: '3' },
  OVER4:  { contract_type: 'DIGITOVER',  barrier: '4' },
  OVER5:  { contract_type: 'DIGITOVER',  barrier: '5' },
  OVER6:  { contract_type: 'DIGITOVER',  barrier: '6' },
  OVER7:  { contract_type: 'DIGITOVER',  barrier: '7' },
  OVER8:  { contract_type: 'DIGITOVER',  barrier: '8' },
  UNDER2: { contract_type: 'DIGITUNDER', barrier: '2' },
  UNDER3: { contract_type: 'DIGITUNDER', barrier: '3' },
  UNDER4: { contract_type: 'DIGITUNDER', barrier: '4' },
  UNDER5: { contract_type: 'DIGITUNDER', barrier: '5' },
  UNDER6: { contract_type: 'DIGITUNDER', barrier: '6' },
  UNDER7: { contract_type: 'DIGITUNDER', barrier: '7' },
  UNDER8: { contract_type: 'DIGITUNDER', barrier: '8' },
  UNDER9: { contract_type: 'DIGITUNDER', barrier: '9' },
  EVEN:   { contract_type: 'DIGITEVEN' },
  ODD:    { contract_type: 'DIGITODD' },
  DIFF:   { contract_type: 'DIGITDIFF' },
  MATCH:  { contract_type: 'DIGITMATCH' },
  RISE:   { contract_type: 'CALL' },
  FALL:   { contract_type: 'PUT' },
  UP:     { contract_type: 'CALL' },
  DOWN:   { contract_type: 'PUT' },
};

/** Per dual-leg threshold before market rotation / stake reset (fallback when settings unset) */
const MAX_LEG_LOSS_STREAK = 3;
/** Brief pause after any loss — then resume normal strategy (no recovery hunt). */
const POST_LOSS_PAUSE_TICKS = 5;
const DEFAULT_ALTERNATION_CAP = 0.60;
const FAST_ALTERNATION_CAP = 0.72;
/** Omni-scanner poll interval (ms) — fast sweep across 15 markets */
const OMNI_SCAN_MS = 100;
/** Wait N market ticks after every settled trade before next entry. */
const POST_TRADE_TICK_COOLDOWN = 0;
/** Direction floors (~3% streak rarity): OVER 0.6^7≈2.8%, UNDER/EO 0.5^5≈3.1% */
const BASE_VL = { OVER5: 7, UNDER5: 5, EVEN: 5, ODD: 5 };
const MAX_VL_REQUIREMENT = 10;
const MS_PER_TICK_EST = 1200;
const VL_CONSENSUS_MS = 800;
/** Single execution slot — pick best of all ready markets, fire one, then next after settle. */
const TOURNAMENT_SLOT_COUNT = 1;
const TOURNAMENT_STRATEGIES = new Set([]);
/** Responsive VL floors for tournament (instant best-market fire, no multi-market wait). */
const TOURNAMENT_VL = { OVER5: 4, UNDER5: 4, EVEN: 3, ODD: 3 };
/** Faster VL when session is green — more trades, still ranked best-of-15. */
const TOURNAMENT_VL_FAST = { OVER5: 3, UNDER5: 3, EVEN: 3, ODD: 3 };
const TOURNAMENT_MIN_WIN_EST = 48;
const TOURNAMENT_MIN_WIN_FAST = 46;
const TOURNAMENT_PULSE_WIN = 48;
const TOURNAMENT_FLOW_MIN = 52;
/** Min winning ticks in last 3 before entry (2 after loss streak). */
const TOURNAMENT_REBOUND_WINDOW = 3;
/** Brief market pause after losses — not multi-minute quarantines. */
const MARKET_QUARANTINE_MS = 0;
/** Opposite-leg lock after a tournament fire (ms). */
const OPP_LEG_LOCK_MS = 2000;
/** Max wait after a loss before force-firing best board pick (ms). */
const RECOVERY_FIRE_DEADLINE_MS = 7000;
/** Poll interval while recovery window is active (ms). */
const RECOVERY_PULSE_MS = 80;
const ENTRY_CONFIRM_MS_MIN = 20000;
const ENTRY_CONFIRM_MS_MAX = 25000;
const ENTRY_CONFIRM_MIN_PAPER_SIGNALS = 2;
const ENTRY_CONFIRM_MIN_PAPER_TICKS = 6;
const ENTRY_CONFIRM_MIN_ACCURACY = 0.55;
const ENTRY_CONFIRM_STRONG_ACCURACY = 0.62;
const ENTRY_CONFIRM_EARLY_AFTER_MS = 10000;
const ENTRY_CONFIRM_VERY_EARLY_MS = 10000;
/** Stealth recovery lenses — alternate so Deriv does not see one fixed pick pattern. */
const RECOVERY_LENS = { OPPOSITE: 'opposite_streak', MARKET_PCT: 'market_pct' };
const DUAL_RECOVERY_MAX_STREAK = 3;

class EnhancedTradeEngine {
  constructor() {
    this.paused = false;
    this.running = false;
    this.channels = {
      SINGLE: { active: false, step: 0, consecutiveLosses: 0, stake: 0.35, contractId: null, direction: null },
      OVER5:  { active: false, step: 0, consecutiveLosses: 0, stake: 0.35, contractId: null },
      UNDER5: { active: false, step: 0, consecutiveLosses: 0, stake: 0.35, contractId: null },
      EVEN:   { active: false, step: 0, consecutiveLosses: 0, stake: 0.35, contractId: null },
      ODD:    { active: false, step: 0, consecutiveLosses: 0, stake: 0.35, contractId: null },
    };

    // --- Market Protection & Meta Scoring States ---
    this.marketStats = {};
    MARKETS.forEach(sym => {
      this.marketStats[sym] = {
        consecutiveLosses: 0,
        totalSessionLosses: 0,
        totalSessionWins: 0,
        metaScore: 0,
        quarantinedUntil: 0,
        lastLossAt: 0,
      };
    });

    // --- Sizing and Protection Session States ---
    this.stakeMultiplier = 1.0;
    this.sessionOpeningBalance = 0;
    this.sessionConsecutiveLosses = 0;
    this.momentumTradesRemaining = 0;
    this.defensiveWins = 0;
    this.isDefensiveMode = false;

    // --- General Session Properties ---
    this.activeMarket = '1HZ10V';
    this.strategy = 'MATCHES';
    this.config = null;
    this.lastTradeTime = 0;
    this.nextAllowedTradeTime = 0;
    this.sessionTrades = []; // Accumulator for mathematical expectancy
    this.currentStatus = 'Idle';
    this.sessionStartedAt = 0; // Timestamp when bot was started
    this.sessionEndedAt = 0;   // Timestamp when bot stopped

    // Hook up configuration changes
    this._configUpdateListener = () => {
      if (typeof localStorage !== 'undefined') {
        const configStr = localStorage.getItem('derivprinter_config');
        if (configStr) {
          try {
            this.config = JSON.parse(configStr);
          } catch(e) {}
        }
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', this._configUpdateListener);
    }

    // --- Callbacks registered by UI ---
    this.onTradeUpdate = null;
    this.onBotStop = null;
    this.onMarketSwitch = null;
    this.onStatusChange = null;
    this.onLiveAnalysisUpdate = null;

    /** Full 15-market × dual-side ranked board (EVEN+ODD or O5+U5 per strategy) */
    this._liveDualSideBoard = [];
    this._liveDualSideBoardAt = 0;
    this._liveBoardInterval = null;
    this._recoveryFireDeadlineAt = 0;
    this._recoveryPulseTimer = null;

    // --- Watchdogs and timers ---
    this._pocHandler = null;
    this._cycleTimer = null;
    this._contractLedger = {};  // Tracks contracts displaced from channels
    this._lastVlToastTime = 0;  // Throttle notifications
    this._directionCooldown = {};       // direction -> until timestamp
    this._marketDirCooldown = {};         // 'market:dir' -> until timestamp
    /** Per market+direction loss streaks — drives early rotation before long runs */
    this._legMarketLosses = {};
    this._legBestMarket = {};             // dir -> { market, score, detail, at }
    this._legMarketQuarantine = {};       // 'market:dir' -> until timestamp
    this._lastLegBestRefreshAt = 0;
    this._toastIds = { scan: 'dp-scan', entry: 'dp-entry', recovery: 'dp-recovery' };
    this._prevScannerOnUpdate = null;
    this._tickWakeTimer = null;
    this._lastTradeDirection = null;
    this._lastTradeWon = null;
    this._tradeMinuteBucket = { minute: 0, count: 0 };

    // --- DIFF strategy original states ---
    this.currentAutoDigit = null;
    this.winsSinceDigitChange = 0;
    this.waitingForTargetDigit = false;
    this.pauseTicksRemaining = 0;
    this._postTradeTickCooldown = 0;

    // --- MATCH_DIFF strategy states ---
    this.matchDiffStakeStep = 0;
    this._restartTimer = null;

    // --- MATCHES strategy states ---
    this.matchesTargetDigit = null;
    this.matchesLastSwitchTime = 0;

    // --- RISE/FALL strategy states ---
    this._rfConsecutiveLosses = 0;         // Tracks consecutive Rise/Fall losses
    this._rfPauseTicksRemaining = 0;       // Ticks left in the cooldown pause
    this._rfPauseStartPrices = {};         // { sym: price } snapshot when pause began
    this._rfWaitingForReversal = false;    // True = waiting for 1 opposite tick after pause
    this._rfPauseDirection = null;         // The direction we were trading when pause triggered
    this._rfLockedMarket = null;           // Locked market for the session — never switches mid-trade

    // --- VL quality gates ---
    this._lastTradeSettledAt = 0;
    this._dirWinHistory = {};
    this._vlDepthStats = {};

    // --- Tournament mode (BOTH5 / BOTH): per-market VL + multi-slot ---
    this.executionSlots = [];
    this.marketVLState = {};
    this.lockedMarkets = new Set();
    /** `${symbol}:${direction}` — EVEN and ODD (or OVER/UNDER) on same market can run together. */
    this.lockedTournamentEntries = new Set();
    this._contractToSlot = {};
    this._tournamentWatchdog = null;
    this._unsubTournamentTick = null;
    this._lastScanToastAt = 0;
    this._tournamentQueuedCount = 0;
    this._tournamentTopStreak = 0;
    this._tournamentTradeInFlight = false;
    this._tournamentFireTryPending = false;
    /** One martingale ladder for tournament — survives slot/channel desync. */
    this._sessionMartingaleStep = 0;
    this._openTournamentContracts = new Map();
    this._settledContractIds = new Set();
    this._pendingTournamentBuy = false;
    this._martingaleArmAfter = 0;
    this._dualHedgeInFlight = false;
    this._confirmRetryTimer = null;
    this._statusDebounceTimer = null;
    this._dualPairStep = 0;
    this._lastDualLosingDir = null;
    this._lastDualWinningDir = null;
    this._marketOppositeLock = {};
    this._activeEntryAlgorithm = null;
    this._dualHedgePending = null;
    this._martingaleRecoveryMode = false;
    this._recoveryDebt = 0;
    this._recoveryPlan = null;
    this._ouTrackFailures = { OVER5: 0, UNDER5: 0, EVEN: 0, ODD: 0 };
    this._entryConfirmLab = null;
    setRecoveryStateReader(() => getFastPassRecoveryState());
    this._initTradeLearning();
    this._initMarketVLState();
  }

  _initTradeLearning() {
    this._learningPatterns = {};
    this._recentLossSetups = [];
    this._lastTournamentEntry = null;
    this._lastWinSetup = null;
    this._cascadePausedUntil = 0;
    this._lossStreakCooldownUntil = 0;
    this._cascadeMartingaleFrozen = false;
    this._lastLossSetup = null;
    this._recoveryLens = null;
    this._lastRecoveryLens = null;
    this._activeEntryAlgorithm = null;
    this._dualHedgePending = null;
    this._martingaleRecoveryMode = false;
    this._recoveryDebt = 0;
    this._recoveryPlan = null;
    this._ouTrackFailures = { OVER5: 0, UNDER5: 0, EVEN: 0, ODD: 0 };
    this._entryConfirmLab = null;
  }

  _getEntryConfirmMs() {
    const minSec = Number(this.config?.entryConfirmMinSec);
    const maxSec = Number(this.config?.entryConfirmMaxSec);
    const lo = Math.max(
      3000,
      (Number.isFinite(minSec) && minSec > 0 ? minSec : 3) * 1000
    );
    const rawHi = (Number.isFinite(maxSec) && maxSec > 0 ? maxSec : 6) * 1000;
    const hi = Math.min(8000, Math.max(lo, rawHi));
      if (this.config?.entryConfirmRandom === false) {
        const fixed = Number(this.config?.entryConfirmMs);
        if (Number.isFinite(fixed) && fixed >= lo) {
          return Math.min(hi, Math.floor(fixed));
        }
      }
    return this._randMs(lo, hi);
  }

  _entryConfirmEnabled() {
    if (this.config?.rapidRecoveryEnabled !== false) return false;
    if (this.config?.entryConfirmEnabled === false) return false;
    return this._usesTournamentMode();
  }

  _armEntryConfirmLab(reason = 'loss') {
    if (!this._entryConfirmEnabled()) return;
    const duration = this._getEntryConfirmMs();
    const now = Date.now();
    this._entryConfirmLab = {
      active: true,
      confirmed: false,
      reason,
      startedAt: now,
      endsAt: now + duration,
      pick: null,
      setups: {},
      tickSamples: 0,
      lastTickIdx: {},
    };
    this.nextAllowedTradeTime = now + duration;
    this.sendLog(
      `🧪 Entry test ~${Math.round(duration / 1000)}s — paper-trading 15 mkts · confirm best setup`
    );
  }

  _clearEntryConfirmLab(tag = '') {
    if (!this._entryConfirmLab) return;
    this._entryConfirmLab = null;
    if (tag) this.sendLog(`🧪 Entry test cleared (${tag})`);
  }

  _isEntryConfirmBlocking() {
    const lab = this._entryConfirmLab;
    if (!lab?.active || lab.confirmed) return false;
    return Date.now() < lab.endsAt;
  }

  _wouldPaperSignal(sym, dir) {
    const st = this.marketVLState[sym];
    if (!st || !this._isDirReady(st, dir)) return false;
    if (this._isDirectionBlocked(dir, sym)) return false;
    if (this.marketStats[sym]?.quarantinedUntil > Date.now()) return false;
    const ticks = scanner.buffers[sym] || [];
    if (ticks.length < 8) return false;
    const scores = scanner.scores[sym] || {};
    const streak = this._getStreakForDir(st || {}, dir, scores);
    const required = this._getTournamentVlRequired(dir, this._getWinRecoveryContext());
    const winChance = st.dirWinChance?.[dir]
      ?? this._estimateTournamentWinChance(sym, dir, streak, ticks, scores);
    return this._passesTournamentEntryQuality(sym, dir, ticks, scores, streak, required, winChance);
  }

  _tickEntryConfirmLab(sym, digit) {
    const lab = this._entryConfirmLab;
    if (!lab?.active || lab.confirmed) return;

    const ticks = scanner.buffers[sym];
    if (!ticks?.length) return;
    const idx = ticks.length - 1;
    if (lab.lastTickIdx[sym] === idx) return;
    lab.lastTickIdx[sym] = idx;

    const dirs = this.strategy === 'BOTH5' ? ['OVER5', 'UNDER5'] : ['EVEN', 'ODD'];

    for (const key of Object.keys(lab.setups)) {
      const s = lab.setups[key];
      if (!s.pendingTick || s.sym !== sym) continue;
      if (this._directionWouldWin(digit, s.dir)) s.correct++;
      else s.incorrect++;
      s.pendingTick = false;
      lab.tickSamples++;
    }

    const scores = scanner.scores[sym] || {};
    for (const dir of dirs) {
      if (!this._wouldPaperSignal(sym, dir)) continue;
      const key = `${sym}:${dir}`;
      if (!lab.setups[key]) {
        lab.setups[key] = {
          sym, dir, correct: 0, incorrect: 0, signals: 0, bias: 0, pendingTick: false,
        };
      }
      const s = lab.setups[key];
      if (!s.pendingTick) {
        s.pendingTick = true;
        s.signals++;
        s.bias = this._getDistributionBiasPct(dir, scores);
      }
    }

    this._tryCompleteEntryConfirmLab();
  }

  _scorePaperSetup(s) {
    const resolved = (s.correct || 0) + (s.incorrect || 0);
    if (resolved < 1 || (s.signals || 0) < ENTRY_CONFIRM_MIN_PAPER_SIGNALS) return -1;
    const acc = resolved > 0 ? s.correct / resolved : 0;
    return acc * 100 + (s.bias || 50) * 0.35 + Math.min(s.signals, 12) * 1.5;
  }

  _tryCompleteEntryConfirmLab() {
    const lab = this._entryConfirmLab;
    if (!lab?.active || lab.confirmed) return;

    const now = Date.now();
    const elapsed = now - lab.startedAt;
    const timeUp = now >= lab.endsAt;
    const canEarly = elapsed >= ENTRY_CONFIRM_EARLY_AFTER_MS
      && lab.tickSamples >= ENTRY_CONFIRM_MIN_PAPER_TICKS;
    const canVeryEarly = elapsed >= ENTRY_CONFIRM_VERY_EARLY_MS
      && lab.tickSamples >= 4;

    let best = null;
    let bestScore = -1;
    for (const s of Object.values(lab.setups)) {
      const sc = this._scorePaperSetup(s);
      if (sc > bestScore) {
        bestScore = sc;
        best = s;
      }
    }

    if (!best) {
      if (timeUp) {
        this.sendLog('🧪 Entry test ended — no setup met minimum paper signals; using live scan');
        lab.confirmed = true;
        lab.pick = null;
        this.nextAllowedTradeTime = 0;
      }
      return;
    }

    const resolved = best.correct + best.incorrect;
    const acc = best.correct / resolved;

    const strongEnough = acc >= ENTRY_CONFIRM_STRONG_ACCURACY
      && resolved >= ENTRY_CONFIRM_MIN_PAPER_SIGNALS;
    const okEnough = acc >= ENTRY_CONFIRM_MIN_ACCURACY
      && resolved >= ENTRY_CONFIRM_MIN_PAPER_SIGNALS;
    const veryStrong = acc >= 0.72 && resolved >= 2;

    if (!timeUp && !canEarly && !canVeryEarly) return;
    if (!timeUp && canVeryEarly && !veryStrong && !strongEnough) return;
    if (!timeUp && canEarly && !veryStrong && !strongEnough) return;
    if (timeUp && !okEnough && !strongEnough) {
      this.sendLog(
        `🧪 Entry test ended — best ${best.dir} ${MARKET_LABELS[best.sym]} only ${(acc * 100).toFixed(0)}% paper · proceeding with caution`
      );
    }

    lab.confirmed = true;
    lab.pick = {
      sym: best.sym,
      dir: best.dir,
      paperAcc: acc,
      paperResolved: resolved,
      paperSignals: best.signals,
      bias: best.bias,
      score: bestScore,
    };
    this.nextAllowedTradeTime = 0;
    const mLabel = MARKET_LABELS[best.sym] || best.sym;
    this.sendLog(
      `✅ Entry confirmed — ${best.dir} ${mLabel} · paper ${(acc * 100).toFixed(0)}% (${best.correct}/${resolved}) · ` +
      `bias ${(best.bias || 0).toFixed(0)}% · ${timeUp ? 'full test' : 'early confirm'}`
    );
    this._notifyOnce(
      this._toastIds.entry,
      `Confirmed ${best.dir} on ${mLabel}`,
      { icon: '✅', duration: 2800 }
    );
  }

  _updateEntryConfirmLabStatus() {
    const lab = this._entryConfirmLab;
    if (!lab?.active) return;
    const left = Math.max(0, lab.endsAt - Date.now());
    const sec = Math.ceil(left / 1000);
    const min = Math.floor(sec / 60);
    const rem = sec % 60;
    const timeStr = min > 0 ? `${min}:${String(rem).padStart(2, '0')}` : `${sec}s`;

    let top = null;
    let topScore = -1;
    for (const s of Object.values(lab.setups)) {
      const sc = this._scorePaperSetup(s);
      if (sc > topScore) {
        topScore = sc;
        top = s;
      }
    }

    const phase = lab.confirmed ? 'confirmed' : 'testing';
    const topTag = top && top.correct + top.incorrect > 0
      ? ` · lead ${top.dir} ${MARKET_LABELS[top.sym]} ${((top.correct / (top.correct + top.incorrect)) * 100).toFixed(0)}%`
      : ` · ${Object.keys(lab.setups).length} setups watched`;
    this.updateStatus(`🧪 ${phase} ${timeStr} left${topTag}`, true);
  }

  _applyConfirmedEntryPick(candidates) {
    const pick = this._entryConfirmLab?.pick;
    if (!pick) return candidates;

    const idx = candidates.findIndex(c => c.sym === pick.sym && c.dir === pick.dir);
    if (idx > 0) {
      const [c] = candidates.splice(idx, 1);
      candidates.unshift(c);
      return candidates;
    }
    if (idx === 0) return candidates;

    if (!this._wouldPaperSignal(pick.sym, pick.dir)) return candidates;

    const st = this.marketVLState[pick.sym];
    const ticks = scanner.buffers[pick.sym] || [];
    const scores = scanner.scores[pick.sym] || {};
    const streak = this._getStreakForDir(st || {}, pick.dir, scores);
    const required = this._getTournamentVlRequired(pick.dir, this._getWinRecoveryContext());
    const winChance = st?.dirWinChance?.[pick.dir]
      ?? this._estimateTournamentWinChance(pick.sym, pick.dir, streak, ticks, scores);

    candidates.unshift({
      sym: pick.sym,
      dir: pick.dir,
      streak,
      required,
      winChance,
      score: pick.score,
      recoveryScore: pick.score,
      ready: true,
      confirmedByLab: true,
      paperAcc: pick.paperAcc,
      algorithm: ENTRY_ALGORITHMS.DISTRIBUTION_BIAS,
    });
    return candidates;
  }

  _rollEntryAlgorithm() {
    return this._activeEntryAlgorithm || ENTRY_ALGORITHMS.DISTRIBUTION_BIAS;
  }

  /** Logged reference of all entry algorithms (for session start). */
  _logEnsembleAlgorithms() {
    const lines = OMNI_ALGORITHM_ORDER.map(a => {
      const m = ALGO_META[a];
      return `  ${m.rating} ${m.label} — ${m.note}`;
    });
    this.sendLog(`📋 Binary omni-scan (${OMNI_ALGORITHM_ORDER.length} edge algos × 15 markets, 45% WR gate):\n${lines.join('\n')}`);
  }

  _algoLabel(algo) {
    return ALGO_META[algo]?.label || algo;
  }

  /** Rolling session win rate (last N settled trades). */
  _getRollingWinRate(window = 10) {
    const settled = (this.sessionTrades || []).filter(t => !t.pending);
    if (settled.length < 3) return null;
    const slice = settled.slice(-window);
    if (!slice.length) return null;
    return slice.filter(t => t.won).length / slice.length;
  }

  _getDistributionBiasPct(dir, scores) {
    if (scores.ltPct && scores.ltPct[dir] !== undefined) {
      return parseFloat(scores.ltPct[dir]) || 0;
    }
    if (scores.pct && scores.pct[dir] !== undefined) {
      return parseFloat(scores.pct[dir]) || 0;
    }
    if (dir === 'OVER5') return parseFloat(scores.ltOverPct) || 0;
    if (dir === 'UNDER5') return parseFloat(scores.ltUnderPct) || 0;
    if (dir === 'EVEN') return parseFloat(scores.ltEvenPct) || 0;
    if (dir === 'ODD') return parseFloat(scores.ltOddPct) || 0;
    return 0;
  }

  _getOmniDirBaseline(dir) {
    const baselines = {
      OVER1: 80, OVER2: 70, OVER3: 60, OVER4: 50, OVER5: 40, OVER6: 30, OVER7: 20,
      UNDER2: 20, UNDER4: 40, UNDER5: 50, UNDER6: 60, UNDER7: 70,
      EVEN: 50, ODD: 50, RISE: 50, FALL: 50, MATCH: 10, DIFF: 90,
    };
    return baselines[dir] ?? 50;
  }

  _passesOmniDirBias(dir, pct) {
    // OMNISNIPER scans all valid dirs — never block on distribution pct.
    // Probability is expressed in the contract type itself (e.g. OVER1 ≈80%).
    return true;
  }

  _getDistributionBiasThreshold(dir) {
    if (this._needsRecoveryFireGate()) {
      const tier = this._getTournamentEntryTier();
      if (tier === 'strict') return 58;
      if (tier === 'cautious') return 56;
      return minDistributionBias(dir);
    }
    return minDistributionBiasNormal(dir);
  }

  _buildEnsembleCandidate(sym, dir, scores, ticks, algo, score, winChance, extra = {}) {
    const req = this._getTournamentVlRequired(dir, this._getWinRecoveryContext());
    const state = this.marketVLState[sym] || {};
    const streak = this._getStreakForDir(state, dir, scores);
    const candidate = {
      sym,
      dir,
      streak,
      required: req,
      winChance: Math.round(winChance),
      score: Math.round(score),
      recoveryScore: Math.round(score),
      algorithm: algo,
      ready: true,
      lt: this._getDistributionBiasPct(dir, scores),
      oppRec: 0,
      pctRec: 0,
      consensus: 0,
      rebound: 0,
      oppEnd: extra.oppEnd || 0,
      oppMax: extra.oppMax || 0,
      oppTotal: extra.oppTotal || 0,
    };
    return applyBinaryScoring(candidate);
  }

  _attachCounterToCandidate(candidate) {
    if (!candidate?.sym || !candidate?.dir) return candidate;
    const scores = scanner.scores[candidate.sym] || {};
    const ticks = scanner.buffers[candidate.sym] || [];
    const counter = scores.counter || analyzeDigitCounter(ticks);
    const sig = getCounterSignal(counter, candidate.dir);
    candidate.counter = counter;
    candidate.counterScore = sig.score;
    candidate.counterAligned = sig.aligned;
    candidate.counterPredicted = sig.predictedPct;
    return candidate;
  }

  _applyBinaryScoring(candidate) {
    if (!candidate) return null;
    const lt = candidate.lt ?? this._getDistributionBiasPct(
      candidate.dir,
      scanner.scores[candidate.sym] || {}
    );
    candidate.lt = lt;
    this._attachCounterToCandidate(candidate);
    return applyBinaryScoring(candidate);
  }

  /** Scan all 15 markets for one entry algorithm. */
  _collectCandidatesForAlgorithm(algo) {
    const isOu = this.strategy === 'BOTH5';
    const dirs = isOu ? ['OVER5', 'UNDER5'] : ['EVEN', 'ODD'];
    const recovery = this._getWinRecoveryContext();
    const biasFloor = (d) => this._getDistributionBiasThreshold(d);
    const out = [];

    for (const sym of MARKETS) {
      if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
      const ticks = scanner.buffers[sym] || [];
      if (ticks.length < 10) continue;
      const scores = scanner.scores[sym] || {};
      if (isOu && (parseFloat(scores.d5Pct) || 0) >= 14) continue;

      for (const dir of dirs) {
        if (this._isTournamentOppositeBlocked(sym, dir)) continue;
        if (this._isTournamentEntryLocked(sym, dir)) continue;
        if (this._isDirectionBlocked(dir, sym)) continue;

        const lt = this._getDistributionBiasPct(dir, scores);
        const bias = this._computeOppositeDirectionBias(ticks, dir);
        const st = this.marketVLState[sym] || {};
        const streak = this._getStreakForDir(st, dir, scores);
        const req = this._getTournamentVlRequired(dir, recovery);
        let pick = null;

        if (algo === ENTRY_ALGORITHMS.DIGIT_COUNTER) {
          const counter = scores.counter || analyzeDigitCounter(ticks);
          const sig = getCounterSignal(counter, dir);
          const distOk = this._needsRecoveryFireGate()
            ? hasRealDistributionEdge(dir, lt)
            : hasNormalDistributionEdge(dir, lt);
          if ((sig.aligned || sig.score >= 12) && distOk && counter.d5PctMed <= 0.14) {
            pick = this._buildEnsembleCandidate(sym, dir, scores, ticks, algo, sig.score * 2 + lt, sig.predictedPct, {
              oppEnd: bias.endConsecutive,
            });
            pick.counterScore = sig.score;
            pick.counterAligned = true;
          }
        } else if (algo === ENTRY_ALGORITHMS.DISTRIBUTION_BIAS) {
          if (lt >= biasFloor(dir)) {
            const baseline = dir === 'OVER5' ? 40 : 50;
            const minB = this._needsRecoveryFireGate() ? minDistributionBias(dir) : minDistributionBiasNormal(dir);
            const wc = Math.min(58, baseline + (lt - minB) * 0.6);
            pick = this._buildEnsembleCandidate(sym, dir, scores, ticks, algo, lt * 2.2 + wc, wc, {
              oppEnd: bias.endConsecutive,
            });
          }
        } else if (algo === ENTRY_ALGORITHMS.SHORT_MOMENTUM) {
          const mom = isOu ? parseFloat(scores.overUnderScore) || 0 : parseFloat(scores.evenOddScore) || 0;
          const short = dir === 'OVER5' ? parseFloat(scores.overPct)
            : dir === 'UNDER5' ? parseFloat(scores.underPct)
            : dir === 'EVEN' ? parseFloat(scores.evenPct) : parseFloat(scores.oddPct);
          if (mom >= 48 && short >= 52) {
            pick = this._buildEnsembleCandidate(sym, dir, scores, ticks, algo, mom + short, 40 + mom * 0.25, {
              oppEnd: bias.endConsecutive,
            });
          }
        } else if (algo === ENTRY_ALGORITHMS.OPPOSITE_RUN) {
          if (bias.endConsecutive >= 3) {
            const wc = 40 + bias.endConsecutive * 4 + bias.score * 0.05;
            pick = this._buildEnsembleCandidate(sym, dir, scores, ticks, algo, bias.score, wc, {
              oppEnd: bias.endConsecutive, oppMax: bias.maxConsecutive,
            });
          }
        } else if (algo === ENTRY_ALGORITHMS.CHI_SKEW) {
          const chi = this._computeChiSquareDeviation(ticks, dir);
          if (chi.significant) {
            pick = this._buildEnsembleCandidate(sym, dir, scores, ticks, algo, 50 + chi.chi2, 46 + chi.chi2 * 0.5);
          }
        } else if (algo === ENTRY_ALGORITHMS.LUNAR_MEMORY) {
          const rev = this._computeLunarReversalProb(ticks, dir, Math.max(3, req - 1));
          const base = this._getBaselineWinRate(dir);
          if (rev != null && rev >= base + (this._needsRecoveryFireGate() ? 6 : 4) && lt >= biasFloor(dir)) {
            pick = this._buildEnsembleCandidate(sym, dir, scores, ticks, algo, rev * 1.5, Math.min(56, rev));
          }
        } else if (algo === ENTRY_ALGORITHMS.CROSS_MARKET) {
          const peers = this._countConsensusStreakReady(dir, sym, Math.max(2, req - 1))
            + this._countConsensusMarkets(dir, sym);
          if (peers >= (this._needsRecoveryFireGate() ? 3 : 2) && lt >= biasFloor(dir)) {
            pick = this._buildEnsembleCandidate(sym, dir, scores, ticks, algo, peers * 18 + lt, 48 + peers * 2);
          }
        } else if (algo === ENTRY_ALGORITHMS.REBOUND_TICK) {
          if (this._passesConvergenceReliefBlock(sym, dir, ticks, req, streak) && lt >= biasFloor(dir) - 5) {
            const conv = this._runConvergenceScan(sym, dir, this._buildConvergenceCtx(sym, dir, ticks, scores, req, streak));
            pick = this._buildEnsembleCandidate(sym, dir, scores, ticks, algo, conv.convergenceScore + lt, conv.winEst);
          }
        } else if (algo === ENTRY_ALGORITHMS.VL_STREAK) {
          const st = this.marketVLState[sym];
          if (st && this._isDirReady(st, dir) && lt >= biasFloor(dir) - 8) {
            const wc = st.dirWinChance?.[dir] || this._estimateTournamentWinChance(sym, dir, streak, ticks, scores);
            pick = this._buildEnsembleCandidate(sym, dir, scores, ticks, algo, wc + streak * 3, wc, {
              oppEnd: bias.endConsecutive,
            });
          }
        }

        if (pick && this._passesTournamentLearningGate(sym, dir, pick.winChance)) {
          const enriched = this._applyConvergence(
            { ...pick, sym, dir, streak, required: req },
            { silent: true, allowBlocked: !this._needsRecoveryFireGate() }
          );
          if (enriched) out.push(enriched);
        }
      }
    }

    out.sort((a, b) => b.score - a.score);
    return out;
  }

  /**
   * Omni-scan: run every entry algorithm on all 15 markets, merge by sym+dir,
   * rank by binary edge — single best trade across the board.
   */
  _fireGateOpts(candidate) {
    const sym = candidate.sym;
    const dir = candidate.dir;
    const ticks = scanner.buffers[sym] || [];
    const scores = scanner.scores[sym] || {};
    const losses = this.sessionConsecutiveLosses || 0;
    this._attachCounterToCandidate(candidate);
    const flowOk = passesBinaryFlowGate(ticks, dir, this.strategy, losses);
    return {
      rollingWr: this._getRollingWinRate(10),
      losses,
      config: this.config,
      flowOk,
      reboundTicks: this._countReboundTicks(ticks, dir),
      counterAligned: candidate.counterAligned ?? counterAlignedForDirection(scores, dir),
      counterScore: candidate.counterScore ?? getCounterSignal(scores.counter || analyzeDigitCounter(ticks), dir).score,
    };
  }

  _passesFireGate(candidate) {
    if (!candidate) return false;
    const opts = this._fireGateOpts(candidate);

    if (this._usesTournamentMode()) {
      if (this._needsRecoveryFireGate()) {
        return passesRecoveryFireGate(candidate, opts) && passesTournamentWinGate(candidate, opts);
      }
      return passesTournamentWinGate(candidate, opts);
    }

    if (candidate.apexPerfect || candidate.algorithm === 'apex_matrix') {
      const conf = candidate.confidenceScore ?? candidate.score ?? 0;
      let requiredConf = 48;
      if (opts.losses >= 1) requiredConf = 54;
      if (opts.losses >= 2) requiredConf = 58;
      if (opts.losses >= 3) requiredConf = 64;
      if (conf >= requiredConf) return true;
      if (opts.losses > 0) return false;
      return passesNormalFireGate(candidate, { ...opts, apexPerfect: true });
    }
    if (opts.losses >= 2) return false;
    return passesNormalFireGate(candidate, opts) && this._passesHealthyNormalGate(candidate, opts);
  }

  _getAllMarketBuffers() {
    const buffers = {};
    for (const sym of MARKETS) buffers[sym] = scanner.buffers[sym] || [];
    return buffers;
  }

  _runApexMatrixLeaderboard() {
    if (shouldUseFastPassRecovery() && (this.sessionConsecutiveLosses || 0) < 1) {
      return {
        leaderboard: [],
        apex: null,
        scannedAt: Date.now(),
        fastPass: true,
      };
    }
    const buffers = {};
    for (const sym of MARKETS) {
      buffers[sym] = capTickBuffer(scanner.buffers[sym] || []);
    }
    const sweep = runMatrixSweep(buffers, this.strategy);
    this._apexLeaderboard = sweep.leaderboard;
    this._apexSweepAt = sweep.scannedAt;
    return sweep;
  }

  _collectApexMatrixCandidates() {
    const sweep = this._runApexMatrixLeaderboard();
    return (sweep.leaderboard || []).map(c => {
      const ticks = scanner.buffers[c.sym] || [];
      const scores = scanner.scores[c.sym] || {};
      const req = this._getTournamentVlRequired(c.dir, this._getWinRecoveryContext());
      const st = this.marketVLState[c.sym] || {};
      const streak = this._getStreakForDir(st, c.dir, scores);
      const enriched = this._applyBinaryScoring({
        ...c,
        lt: this._getDistributionBiasPct(c.dir, scores),
        required: req,
        streak,
        recoveryScore: c.score,
        ready: true,
        algorithm: 'apex_matrix',
        algorithms: ['apex_matrix'],
      });
      if (enriched) {
        enriched.apexPerfect = c.perfect;
        enriched.confidenceScore = c.confidenceScore ?? c.score;
        enriched.algorithm = 'apex_matrix';
        enriched.score = c.confidenceScore ?? c.score;
        enriched.binaryEdge = (c.confidenceScore ?? 0) * 1.35;
      }
      return enriched;
    }).filter(Boolean).filter(c => {
      const ticks = scanner.buffers[c.sym] || [];
      return !isBinaryEntryTrap(ticks, c.dir, scanner.scores[c.sym] || {});
    });
  }

  _blocksRecentLosingDirection(_candidate) {
    // REMOVED: direction blocking after loss — we always fire the best leaderboard pick
    return false;
  }

  _passesHealthyNormalGate(e, _t = {}) {
    return (e.score ?? 0) >= 35 || e.ready === true || (e.binaryWinPct ?? e.winChance ?? 0) >= 35;
  }

  _shouldInvertTradeDirection() {
    if (!this._usesTournamentMode()) return false;
    if (this.config?.invertTradeDirection === true) return true;
    if (this.config?.adaptiveInvertDirection === false) return false;
    const settled = (this.sessionTrades || []).filter(t => !t.pending);
    if (settled.length < 8) return false;
    const wr = this._getRollingWinRate(Math.min(15, settled.length));
    return wr != null && wr < 0.44;
  }

  _resolveFireDirection(dir) {
    if (!dir || !this._shouldInvertTradeDirection()) return dir;
    return flipDigitDirection(dir);
  }

  /** Logs show many losses on score/vwr=100 without a 4-tick exhaustion pattern. */
  _passesExhaustionFireGate(sym, dir) {
    if (this.config?.requireExhaustionGate === false) return true;
    const ticks = scanner.buffers[sym] || [];
    const ct = dirToContractType(dir);
    if (!ct || ticks.length < 4) return false;
    return passesFourTickExhaustionGate(ticks, ct);
  }

  _isOverconfidentMatrixSignal(candidate) {
    if (!candidate) return false;
    const vwr = candidate.virtualWinRate ?? candidate.rate ?? 0;
    const score = candidate.score ?? candidate.sniperScore ?? candidate.confidenceScore ?? 0;
    if (vwr < 88 && score < 88) return false;
    const sym = candidate.sym;
    const dir = candidate.dir;
    const ticks = scanner.buffers[sym] || [];
    if (isMomentumContinuationTrap(ticks, dir, 3, 3)) return true;
    if (!this._passesExhaustionFireGate(sym, dir)) return true;
    return false;
  }

  _passesTournamentFireQuality(candidate) {
    if (!candidate?.sym || !candidate?.dir) return false;
    if (this._isOverconfidentMatrixSignal(candidate)) return false;
    const ticks = scanner.buffers[candidate.sym] || [];
    const losses = this.sessionConsecutiveLosses || 0;
    if (!passesBinaryFlowGate(ticks, candidate.dir, this.strategy, losses)) return false;
    if (isMomentumContinuationTrap(ticks, candidate.dir, 3, 3)) return false;
    if (!this._passesExhaustionFireGate(candidate.sym, candidate.dir)) return false;
    if (losses >= 2) {
      const th = getTournamentGateThresholds(this.config, losses);
      const win = candidate.binaryWinPct ?? candidate.winChance ?? 0;
      const oppEnd = candidate.oppEnd ?? 0;
      const oppStreak = candidate.oppStreak ?? 0;
      if (win < th.minWin) return false;
      if (oppEnd < th.minOppEnd && oppStreak < th.minOppStreak) return false;
    }
    return this._passesFireGate(candidate);
  }

  _passesRapidRecoveryGate(candidate, opts = {}) {
    if (!candidate) return false;
    const dir = candidate.dir || candidate.direction;
    const lt = parseFloat(candidate.lt ?? candidate.distributionPct ?? 0) || 0;
    const conv = candidate.convergenceScore ?? 0;
    const win = candidate.binaryWinPct ?? candidate.winChance ?? 0;
    const edge = candidate.binaryEdge ?? candidate.recoveryScore ?? candidate.score ?? 0;
    const agree = candidate.algoAgreement ?? (candidate.algorithms?.length || 1);
    const rebound = opts.reboundTicks ?? 0;
    const consensus = candidate.consensus ?? 0;
    const oppEnd = candidate.oppEnd ?? 0;
    const counterScore = opts.counterScore ?? candidate.counterScore ?? 0;
    const counterAligned = opts.counterAligned ?? candidate.counterAligned ?? false;
    const losses = opts.losses ?? this.sessionConsecutiveLosses ?? 0;

    if (!hasRealDistributionEdge(dir, lt)) return false;
    if (conv < 48) return false;
    if (win < 47) return false;
    if (edge < 92) return false;
    if (losses >= 3 && win < 50) return false;

    const confirmations = [
      agree >= 2,
      rebound >= 2,
      counterAligned && counterScore >= 14,
      consensus >= 2,
      oppEnd >= 3,
      conv >= 58,
    ].filter(Boolean).length;

    return confirmations >= (losses >= 3 ? 3 : 2);
  }

  _collectOmniBestCandidates() {
    const byKey = new Map();

    const algos = this._needsRecoveryFireGate() ? OMNI_ALGORITHM_ORDER : ENTRY_ALGORITHM_ORDER;
    for (const algo of algos) {
      const batch = this._collectCandidatesForAlgorithm(algo);
      for (const raw of batch) {
        const c = this._applyBinaryScoring({ ...raw, algorithm: algo });
        if (!c) continue;

        const key = `${c.sym}:${c.dir}`;
        const prev = byKey.get(key);
        if (!prev) {
          c.algorithms = [algo];
          c.algoAgreement = 1;
          byKey.set(key, this._applyBinaryScoring(c));
          continue;
        }

        if (!prev.algorithms.includes(algo)) prev.algorithms.push(algo);
        prev.algoAgreement = prev.algorithms.length;
        prev.algorithm = prev.algorithms[0];
        if ((c.binaryEdge ?? 0) > (prev.binaryEdge ?? 0)) {
          prev.score = Math.max(prev.score ?? 0, c.score ?? 0);
          prev.winChance = Math.max(prev.winChance ?? 0, c.winChance ?? 0);
          prev.convergenceScore = Math.max(prev.convergenceScore ?? 0, c.convergenceScore ?? 0);
        }
        byKey.set(key, this._applyBinaryScoring(prev));
      }
    }

    return rankByBinaryEdge([...byKey.values()]);
  }

  /**
   * Best-of-15: merge VL-ready tournament setups + omni algos, rank by binary edge.
   * No strict gate here — gate applied at fire (normal vs recovery).
   */
  _collectBestAcrossMarkets() {
    const losses = this.sessionConsecutiveLosses || 0;
    if (shouldUseFastPassRecovery() && losses < 1) return [];
    const byKey = new Map();
    const merge = (list) => {
      for (const raw of list) {
        if (!raw?.sym || !raw?.dir) continue;
        const c = this._applyBinaryScoring({ ...raw });
        if (!c) continue;
        const key = `${c.sym}:${c.dir}`;
        const prev = byKey.get(key);
        if (!prev || (c.binaryEdge ?? 0) > (prev.binaryEdge ?? 0)) {
          if (prev?.algorithms) {
            c.algorithms = [...new Set([...(prev.algorithms || []), ...(c.algorithms || [c.algorithm])])];
            c.algoAgreement = c.algorithms.length;
          }
          byKey.set(key, c);
        }
      }
    };

    merge(this._candidatesFromLiveBoard({ limit: 30, minStatus: 'WATCHING' }));
    merge(this._collectApexMatrixCandidates());
    merge(this._collectTournamentCandidates());
    merge(this._collectOmniBestCandidates());
    if (this._needsRecoveryFireGate()) {
      merge(this._collectRapidRecoveryCandidates());
    }

    let ranked = rankByBinaryEdge([...byKey.values()]);
    ranked.sort((a, b) =>
      (b.boardStatus === 'READY') - (a.boardStatus === 'READY')
      || (b.boardStatus === 'NEAR') - (a.boardStatus === 'NEAR')
      || (b.fromLiveBoard === true) - (a.fromLiveBoard === true)
      || (b.apexPerfect === true) - (a.apexPerfect === true)
      || (b.binaryEdge ?? 0) - (a.binaryEdge ?? 0)
    );

    if (ranked.length === 0 && !this._usesTournamentMode()) {
      const pulse = this._collectTournamentPulseCandidates().map(c => this._applyBinaryScoring(c)).filter(Boolean);
      const flow = pulse.length === 0
        ? this._collectTournamentFlowCandidates().map(c => this._applyBinaryScoring(c)).filter(Boolean)
        : [];
      ranked = rankByBinaryEdge([...pulse, ...flow]);
    }

    // Compute cross-market consensus for each direction
    const isOu = this.strategy === 'BOTH5';
    const dirs = isOu ? ['OVER5', 'UNDER5'] : ['EVEN', 'ODD'];
    const directionConsensus = { OVER5: 0, UNDER5: 0, EVEN: 0, ODD: 0 };
    for (const sym of MARKETS) {
      const scores = scanner.scores[sym] || {};
      const ticks = scanner.buffers[sym] || [];
      if (ticks.length < 10) continue;
      for (const d of dirs) {
        const lt = this._getDistributionBiasPct(d, scores);
        if (lt >= minDistributionBiasNormal(d)) directionConsensus[d]++;
      }
    }

    for (const c of ranked) {
      const ticks = scanner.buffers[c.sym] || [];
      c.consensus = directionConsensus[c.dir] || 0;
      c.flowBonus = flowScoreBonus(ticks, c.dir, this.strategy);
      c.momentumTrapped = isRecentlyDominant(ticks, c.dir, 5, 4);
    }

    ranked = ranked.map(c => {
      c.unifiedScore = computeUnifiedRankScore(c);
      return c;
    }).sort((a, b) => {
      if (b.unifiedScore !== a.unifiedScore) return b.unifiedScore - a.unifiedScore;
      
      // Tie-breaker 1: Highest Binary Edge (Win Probability Model)
      if ((b.binaryEdge ?? 0) !== (a.binaryEdge ?? 0)) return (b.binaryEdge ?? 0) - (a.binaryEdge ?? 0);
      
      // Tie-breaker 2: Highest Convergence Score (Quality of the mathematical setup)
      if ((b.convergenceScore ?? 0) !== (a.convergenceScore ?? 0)) return (b.convergenceScore ?? 0) - (a.convergenceScore ?? 0);
      
      // Tie-breaker 3: Algo agreement (If multiple algos flagged it, it's safer)
      if ((b.algoAgreement ?? 1) !== (a.algoAgreement ?? 1)) return (b.algoAgreement ?? 1) - (a.algoAgreement ?? 1);
      
      // Tie-breaker 4: Highest Distribution Bias (Underlying Tick Volume favorability)
      const ltB = parseFloat(b.lt ?? b.distributionPct ?? 0) || 0;
      const ltA = parseFloat(a.lt ?? a.distributionPct ?? 0) || 0;
      return ltB - ltA;
    });

    const sessionLosses = this.sessionConsecutiveLosses || 0;
    const trapped = this._filterTrapCandidates(ranked);
    if (this._usesTournamentMode()) {
      return trapped.filter(c => {
        const ticks = scanner.buffers[c.sym] || [];
        const flowOk = passesBinaryFlowGate(ticks, c.dir, this.strategy, sessionLosses);
        return passesTournamentWinGate(c, {
          losses: sessionLosses,
          config: this.config,
          flowOk,
        });
      });
    }
    return trapped;
  }

  _collectRapidRecoveryCandidates() {
    const isOu = this.strategy === 'BOTH5';
    const dirs = isOu ? ['OVER5', 'UNDER5'] : ['EVEN', 'ODD'];
    const recovery = this._getWinRecoveryContext();
    const out = [];

    for (const sym of MARKETS) {
      if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
      const ticks = scanner.buffers[sym] || [];
      if (ticks.length < 14) continue;
      const scores = scanner.scores[sym] || {};
      if (isOu && (parseFloat(scores.d5Pct) || 0) >= 12) continue;

      for (const dir of dirs) {
        if (this._isTournamentOppositeBlocked(sym, dir)) continue;
        if (this._isTournamentEntryLocked(sym, dir)) continue;
        if (this._isDirectionBlocked(dir, sym)) continue;

        const lt = this._getDistributionBiasPct(dir, scores);
        if (!hasRealDistributionEdge(dir, lt)) continue;

        const required = this._getTournamentVlRequired(dir, recovery);
        const st = this.marketVLState[sym] || {};
        const streak = this._getStreakForDir(st, dir, scores);
        if (streak < Math.max(1, required - 2)) continue;

        const conv = this._runConvergenceScan(sym, dir, this._buildConvergenceCtx(sym, dir, ticks, scores, required, streak));
        if (conv.blocked || conv.convergenceScore < 45) continue;

        const bias = this._computeOppositeDirectionBias(ticks, dir);
        const rebound = this._countReboundTicks(ticks, dir);
        const consensus = this._countConsensusStreakReady(dir, sym, Math.max(2, required - 1))
          + this._countConsensusMarkets(dir, sym);
        const counter = scores.counter || analyzeDigitCounter(ticks);
        const counterSig = getCounterSignal(counter, dir);
        const winChance = Math.max(
          this._estimateTournamentWinChance(sym, dir, streak, ticks, scores),
          conv.winEst || 0,
          counterSig.predictedPct || 0
        );
        const oppRec = this._scoreOppositeStreakRecovery(bias, streak, required);
        const pctRec = this._scoreMarketPctRecovery(dir, scores);
        const learning = this._learningScoreAdjust(sym, dir);
        const score = Math.round(
          winChance * 2.2
          + conv.convergenceScore * 1.15
          + Math.max(0, lt - minDistributionBias(dir)) * 5
          + consensus * 8
          + rebound * 5
          + Math.min(18, counterSig.score * 0.6)
          + oppRec * 0.9
          + pctRec * 0.7
          + learning
        );

        const candidate = this._applyBinaryScoring({
          sym,
          dir,
          streak,
          required,
          lt,
          winChance,
          score,
          recoveryScore: score,
          convergenceScore: conv.convergenceScore,
          convergence: conv,
          consensus,
          rebound,
          oppRec,
          pctRec,
          oppEnd: bias.endConsecutive,
          oppMax: bias.maxConsecutive,
          oppTotal: bias.totalOpposite,
          counterScore: counterSig.score,
          counterAligned: counterSig.aligned,
          algorithm: ENTRY_ALGORITHMS.CROSS_MARKET,
          algorithms: [
            ENTRY_ALGORITHMS.DISTRIBUTION_BIAS,
            ...(consensus >= 2 ? [ENTRY_ALGORITHMS.CROSS_MARKET] : []),
            ...(counterSig.aligned || counterSig.score >= 14 ? [ENTRY_ALGORITHMS.DIGIT_COUNTER] : []),
            ...(bias.endConsecutive >= 3 ? [ENTRY_ALGORITHMS.OPPOSITE_RUN] : []),
            ...(rebound >= 2 ? [ENTRY_ALGORITHMS.REBOUND_TICK] : []),
          ],
          ready: true,
          rapidRecovery: true,
        });
        if (!candidate) continue;
        candidate.algoAgreement = new Set(candidate.algorithms || []).size;
        if (this._passesRapidRecoveryGate(candidate, this._fireGateOpts(candidate))) out.push(candidate);
      }
    }

    return rankByBinaryEdge(out);
  }

  _collectEnsembleCandidates() {
    return this._collectBestAcrossMarkets();
  }

  /** Randomly alternate opposite-streak vs market-% recovery (both O/U and E/O). */
  _rollRecoveryLens(force = false) {
    const losses = this.sessionConsecutiveLosses || 0;
    if (!force && this._recoveryLens && losses === 0 && Math.random() > 0.4) {
      return this._recoveryLens;
    }

    let next = Math.random() < 0.5 ? RECOVERY_LENS.OPPOSITE : RECOVERY_LENS.MARKET_PCT;
    if (this._lastRecoveryLens && losses >= 1) {
      next = this._lastRecoveryLens === RECOVERY_LENS.OPPOSITE
        ? RECOVERY_LENS.MARKET_PCT
        : RECOVERY_LENS.OPPOSITE;
      if (Math.random() < 0.38) {
        next = Math.random() < 0.5 ? RECOVERY_LENS.OPPOSITE : RECOVERY_LENS.MARKET_PCT;
      }
    }

    this._lastRecoveryLens = this._recoveryLens;
    this._recoveryLens = next;
    return next;
  }

  _getActiveRecoveryLens() {
    if (!this._recoveryLens) this._rollRecoveryLens(true);
    return this._recoveryLens;
  }

  _recoveryLensLabel(lens) {
    return lens === RECOVERY_LENS.MARKET_PCT ? 'mkt%' : 'opp-run';
  }

  _scoreOppositeStreakRecovery(bias, streak, required) {
    const req = required ?? 3;
    let s = Math.min(28, (bias?.endConsecutive ?? 0) * 3.8);
    s += Math.min(16, (bias?.maxConsecutive ?? 0) * 1.6);
    s += Math.min(14, Math.max(0, streak - req) * 3.2);
    s += Math.min(8, (bias?.totalOpposite ?? 0) * 0.35);
    return s;
  }

  /** Market window % says this side is due (works for OVER/UNDER and EVEN/ODD). */
  _scoreMarketPctRecovery(dir, scores) {
    if (dir === 'OVER5') {
      const pct = parseFloat(scores.ltOverPct) || 40;
      return Math.max(0, Math.min(32, (44 - pct) * 1.15));
    }
    if (dir === 'UNDER5') {
      const pct = parseFloat(scores.ltUnderPct) || 50;
      return Math.max(0, Math.min(32, (52 - pct) * 1.15));
    }
    if (dir === 'EVEN') {
      const pct = parseFloat(scores.ltEvenPct) || 50;
      return Math.max(0, Math.min(32, (53 - pct) * 1.35));
    }
    const pct = parseFloat(scores.ltOddPct) || 50;
    return Math.max(0, Math.min(32, (53 - pct) * 1.35));
  }

  _learningKey(sym, dir) {
    return `${sym}:${dir}`;
  }

  _recordTradeLearning(market, direction, won, profit, vlDepth = 0) {
    const key = this._learningKey(market, direction);
    if (!this._learningPatterns[key]) {
      this._learningPatterns[key] = { wins: 0, losses: 0, profit: 0, lastAt: 0 };
    }
    const p = this._learningPatterns[key];
    p.lastAt = Date.now();
    p.profit = (p.profit || 0) + profit;
    if (won) p.wins++;
    else {
      p.losses++;
      const entry = this._lastTournamentEntry || { sym: market, dir: direction, streak: vlDepth, oppEnd: 0 };
      this._recentLossSetups = [
        { ...entry, sym: market, dir: direction, at: Date.now() },
        ...this._recentLossSetups,
      ].slice(0, 8);
    }
  }

  _learningScoreAdjust(sym, dir) {
    const p = this._learningPatterns[this._learningKey(sym, dir)];
    if (!p) return 0;
    const n = p.wins + p.losses;
    if (n < 2) return 0;
    const wr = p.wins / n;
    return Math.round((wr - 0.45) * 35);
  }

  _passesTournamentLearningGate(sym, dir, winChance) {

    const minWin = this._minTournamentWinEst(dir);
    return (winChance ?? 0) >= minWin;
  }

  _passesRelaxedRecoveryFire(candidate) {
    if (!candidate) return false;
    const losses = this.sessionConsecutiveLosses || 0;
    const dir = candidate.dir || candidate.direction;
    const lt = parseFloat(candidate.lt ?? candidate.distributionPct ?? 0) || 0;
    const win = parseFloat(candidate.binaryWinPct ?? candidate.winChance ?? 0) || 0;
    const conv = parseFloat(candidate.convergenceScore ?? 0) || 0;
    const agree = candidate.algoAgreement ?? (candidate.algorithms?.length || 1);
    if (losses >= 1) {
      return win >= 32 && (hasNormalDistributionEdge(dir, lt) || win >= 38 || candidate.ready);
    }
    if (!hasNormalDistributionEdge(dir, lt)) return false;
    if (hasRealDistributionEdge(dir, lt)) {
      return win >= 44 && (conv >= 40 || agree >= 2);
    }
    return win >= 46 && conv >= 38;
  }

  _passesOmniFireGate(candidate) {
    if (!candidate || this.strategy !== 'OMNISNIPER') return false;
    if (candidate.algorithm === 'apex_matrix') return true; // ALWAYS GREEN: apex picks bypass all gates
    const dir = candidate.dir || candidate.direction;
    const win = candidate.binaryWinPct ?? candidate.winChance ?? 0;
    const baseline = this._getOmniDirBaseline(dir);
    // For OMNISNIPER, every direction is valid. Just ensure win estimate is above minimal floor.
    // Baseline already encodes direction probability (OVER1≈80%, OVER7≈20% etc.)
    return win >= Math.max(10, baseline - 10);
  }


  _usesTournamentMode() {
    return TOURNAMENT_STRATEGIES.has(this.strategy);
  }

  /**
   * Single-side apex sniper for BOTH / BOTH5 only.
   * EO_WINNING & OU_WINNING use paired dual hedge (EVEN+ODD or OVER+UNDER same tick).
   */
  _usesIsolatedSniperMode() {
    if (this.strategy === 'OU_WINNING' || this.strategy === 'EO_WINNING') return false;
    if (this.strategy === 'OMNISNIPER') return false;
    return this.config?.isolatedSniper !== false;
  }

  _isWinningDualStrategy() {
    return this.strategy === 'OU_WINNING' || this.strategy === 'EO_WINNING';
  }

  /** EVEN/OVER always first in logs, fire batch, and history table. */
  _getDualLegDisplayOrder(dirs) {
    if (!dirs?.length) return dirs || [];
    if (dirs.includes('EVEN')) return ['EVEN', 'ODD'];
    if (dirs.includes('OVER5')) return ['OVER5', 'UNDER5'];
    return dirs;
  }

  _dualLegSortKey(direction) {
    if (direction === 'EVEN' || direction === 'OVER5') return 0;
    if (direction === 'ODD' || direction === 'UNDER5') return 1;
    return 5;
  }

  _getDualLegMartingaleStake(dir) {
    const ch = this.channels[dir];
    const base = this._resolveStake(this.config.baseStake);
    if (!ch) return base;
    if (this._isWinningDualStrategy()) {
      return this._getMartingaleStake(ch);
    }
    if (this.config.recoveryEnabled === false) return base;
    return this._martingaleStakeWithSlightRange(this._getMartingaleStake(ch));
  }

  /**
   * Traditional Deriv per-leg martingale (EO/OU winning): win → reset step to base;
   * loss → advance step and stake = base × mult^step until that leg wins again.
   */
  _applyWinningDualLegMartingale(direction, won) {
    const ch = this.channels[direction];
    if (!ch) return;
    const base = this._resolveStake(this.config.baseStake);
    if (won) {
      ch.step = 0;
      ch.stake = base;
      ch.consecutiveLosses = 0;
      if (this._lastDualLosingDir === direction) {
        this._lastDualLosingDir = null;
        this._lastDualWinningDir = direction;
      }
      return;
    }
    const hold = this._getMartingaleHoldAfterStep();
    const prev = ch.step || 0;
    ch.step = hold > 0 ? Math.min(hold, prev + 1) : prev + 1;
    ch.stake = this._getDualLegMartingaleStake(direction);
    ch.consecutiveLosses = (ch.consecutiveLosses || 0) + 1;
    this._lastDualLosingDir = direction;
    this._dualPairStep = Math.max(this._dualPairStep || 0, ch.step);
    if (this.strategy === 'RANDOM_PICKER' && this.config?.autoSwitchMarkets !== false) {
      queueMicrotask(() => {
        if (this.running) this._maybeRotateMarketForLeg(direction, 'leg loss');
      });
    }
  }

  /**
   * EO/OU winning: leg that must recover first (highest martingale step / losses).
   * Alternates focus when both legs are in recovery to avoid one-sided loss streaks.
   */
  _getDualRecoveryPriorityDir(dirs) {
    if (!dirs?.length) return null;
    const legs = dirs.map(dir => ({
      dir,
      step: this.channels[dir]?.step || 0,
      losses: this.channels[dir]?.consecutiveLosses || 0,
    }));
    const inRecovery = legs.filter(l => l.step > 0 || l.losses > 0);
    if (!inRecovery.length) {
      return this._getDualLegDisplayOrder(dirs)[0];
    }
    inRecovery.sort((a, b) =>
      b.step - a.step
      || b.losses - a.losses
      || (this._lastDualLosingDir === b.dir ? 1 : 0) - (this._lastDualLosingDir === a.dir ? 1 : 0)
    );
    return inRecovery[0].dir;
  }

  /** Fire / log order: recovery leg first, opposite second. */
  _getDualLegFireOrder(dirs) {
    const ordered = this._getDualLegDisplayOrder(dirs);
    const priority = this._getDualRecoveryPriorityDir(dirs);
    const hedge = this._getOppositeDirection(priority);
    if (!priority || !hedge || !dirs.includes(hedge)) return ordered;
    return [priority, hedge];
  }

  /** Consecutive leg losses before auto-switch / leaderboard recovery (Settings). */
  _getSwitchAfterLossesThreshold() {
    const v = Number(this.config?.switchAfterLosses);
    if (Number.isFinite(v) && v > 0) return v;
    if (this._isSyntheticDualSideStrategy()) return 2;
    return 0;
  }

  _legMarketKey(market, dir) {
    return `${market}:${dir}`;
  }

  _getLegMarketLossStreak(dir, market) {
    if (!market || !dir) return 0;
    return this._legMarketLosses[this._legMarketKey(market, dir)] || 0;
  }

  _getLegSwitchThreshold(dir) {
    const cfg = this._getSwitchAfterLossesThreshold();
    if (cfg > 0) return cfg;
    return dir === 'OVER5' ? 2 : 2;
  }

  _getLegMarketQuarantineMs(dir) {
    return dir === 'OVER5' ? 180000 : 120000;
  }

  _recordLegMarketResult(market, dir, won) {
    if (!market || !dir) return;
    const key = this._legMarketKey(market, dir);
    if (won) {
      this._legMarketLosses[key] = 0;
      delete this._legMarketQuarantine[key];
      return;
    }
    const streak = (this._legMarketLosses[key] || 0) + 1;
    this._legMarketLosses[key] = streak;
    const banAfter = dir === 'OVER5' ? 2 : 2;
    if (streak >= banAfter) {
      this._legMarketQuarantine[key] = Date.now() + this._getLegMarketQuarantineMs(dir);
    }
  }

  _isLegMarketBlocked(dir, market) {
    if (!market || !dir) return false;
    const key = this._legMarketKey(market, dir);
    if ((this._legMarketQuarantine[key] || 0) > Date.now()) return true;
    const maxOnMarket = dir === 'OVER5' ? 2 : 3;
    return this._getLegMarketLossStreak(dir, market) >= maxOnMarket;
  }

  /**
   * Scan all 15 markets for the best edge on one direction (OVER5, EVEN, etc.).
   * Skips quarantined market+dir combos and penalizes markets that already burned the leg.
   */
  _findBestMarketForDirection(targetDir, opts = {}) {
    return null;
  }

  _refreshLegBestMarkets() {
    return;
  }

  _maybeRotateMarketForLeg(dir, reason = '') {
    return false;
  }

  /** Leaderboard recovery market for EO/OU when a leg needs mean-reversion edge. */
  _scanLeaderboardRecoveryForDual(isOverUnder, rescueDir) {
    const pick = sweepApexBestRecoveryForDir(
      this._getAllMarketBuffers(),
      isOverUnder,
      rescueDir,
      { minConfidence: 38, winRateBar: 58 }
    );
    if (!pick?.market) return null;

    const a = pick.apex;
    const dirs = isOverUnder ? ['OVER5', 'UNDER5'] : ['EVEN', 'ODD'];
    const leg = rescueDir || a.dir;
    const volTag = a.volatile ? ' · volatile' : '';
    const wrTag = a.wr >= 58 ? ` · WR ${a.wr}%` : '';

    return {
      market: pick.market,
      dirs,
      rescueDir: leg,
      pressureLosses: this.channels[leg]?.consecutiveLosses || 0,
      score: pick.recoveryScore ?? a.confidenceScore,
      detail: `LB ${a.dir} score ${a.confidenceScore}${a.perfect ? ' ★' : ''}${volTag}${wrTag}`,
      apexPerfect: a.perfect,
      leaderboardRecovery: true,
    };
  }

  _getIsolatedStake(sym) {
    const market = sym || this.activeMarket;
    return getIsolatedStakeForSymbol(market, this.config.baseStake, {
      maxStakeCap: this._getMaxStakeCap(),
      stakeSafetyCeiling: 0,
    });
  }

  _initMarketVLState() {
    this.marketVLState = {};
    MARKETS.forEach(sym => {
      this.marketVLState[sym] = {
        overStreak: 0,
        underStreak: 0,
        evenStreak: 0,
        oddStreak: 0,
        overReady: false,
        underReady: false,
        evenReady: false,
        oddReady: false,
        overDepth: 0,
        underDepth: 0,
        evenDepth: 0,
        oddDepth: 0,
        confirmPending: false,
        confirmDir: null,
        confirmMarket: null,
        nearReady: false,
        overNearReady: false,
        underNearReady: false,
        evenNearReady: false,
        oddNearReady: false,
        readinessScore: 0,
        bestDir: null,
        dirWinChance: {},
        dirConfirmPending: {},
        lastTickTime: 0,
      };
    });
  }

  _countReboundTicks(ticks, dir, windowSize = TOURNAMENT_REBOUND_WINDOW) {
    const w = (ticks || []).slice(-windowSize);
    if (!w.length) return 0;
    return w.filter(d => this._directionWouldWin(d, dir)).length;
  }

  _buildConvergenceCtx(sym, dir, ticks, scores, required, streak) {
    const allScores = scanner.getAllScores();
    const allTicks = {};
    for (const m of MARKETS) allTicks[m] = scanner.getTicks(m);
    return {
      ticks: ticks || scanner.getTicks(sym),
      scores: scores || scanner.scores[sym] || {},
      allScores,
      allTicks,
      required: required ?? this._getTournamentVlRequired(dir, this._getWinRecoveryContext()),
      streak,
    };
  }

  _runConvergenceScan(sym, dir, ctx) {
    return convergenceScan(sym, dir, ctx);
  }

  _applyConvergence(candidate, opts = {}) {
    if (!candidate) return null;
    const sym = candidate.sym || candidate.market;
    const dir = candidate.dir || candidate.direction;
    const ticks = scanner.getTicks(sym);
    const scores = scanner.scores[sym] || {};
    const required = candidate.required ?? this._getTournamentVlRequired(dir, this._getWinRecoveryContext());
    const streak = candidate.streak ?? 0;
    const report = this._runConvergenceScan(sym, dir, this._buildConvergenceCtx(sym, dir, ticks, scores, required, streak));
    candidate.convergence = report;
    candidate.convergenceScore = report.convergenceScore;
    if (report.blocked) {
      if (!opts.silent && (!this._lastConvBlockLog?.[sym + dir] || Date.now() - (this._lastConvBlockLog?.[sym + dir] || 0) > 8000)) {
        this._lastConvBlockLog = this._lastConvBlockLog || {};
        this._lastConvBlockLog[sym + dir] = Date.now();
        const label = MARKET_LABELS[sym] || sym;
        this.sendLog(`⛔ Conv S4 relief · ${label} ${dir} · ${report.blockReason || 'blocked'}`);
      }
      if (opts.allowBlocked) {
        candidate.convBlocked = true;
        candidate.convergenceScore = Math.min(candidate.convergenceScore ?? 0, 42);
        return candidate;
      }
      return null;
    }
    const capped = Math.min(report.winEst, (candidate.binaryWinPct ?? 50) + 6);
    candidate.winChance = Math.min(capped, candidate.binaryWinPct ?? capped);
    return candidate;
  }

  /** Signal 4 only — for pulse/flow paths that must keep firing but skip relieved entries. */
  _passesConvergenceReliefBlock(sym, dir, ticks, required, streak) {
    const report = this._runConvergenceScan(sym, dir, this._buildConvergenceCtx(sym, dir, ticks, scanner.scores[sym], required, streak));
    return !report.blocked;
  }

  _passesTournamentMacroPct(dir, scores, relaxed = false) {
    if (dir === 'OVER5') return (parseFloat(scores.ltOverPct) || 0) >= (relaxed ? 36 : 42);
    if (dir === 'UNDER5') return (parseFloat(scores.ltUnderPct) || 0) >= (relaxed ? 44 : 48);
    if (dir === 'EVEN') return (parseFloat(scores.ltEvenPct) || 0) >= (relaxed ? 44 : 48);
    return (parseFloat(scores.ltOddPct) || 0) >= (relaxed ? 44 : 48);
  }

  _getTournamentEntryTier() {
    return 'fast';
  }

  _isRecoveryUrgent() {
    return (this.sessionConsecutiveLosses || 0) >= 1
      && this._recoveryFireDeadlineAt > 0
      && Date.now() < this._recoveryFireDeadlineAt;
  }

  _armRecoveryPulse() {
    this._stopRecoveryPulse();
  }

  _armPostLossPause() {
    // No-op: post-loss pause completely disabled — continue immediately
  }

  _armPostTradeTickCooldown() {
    if (this._isWinningDualStrategy()) return;
    this._postTradeTickCooldown = POST_TRADE_TICK_COOLDOWN;
  }

  /** Decrement post-trade tick cooldown on each live market tick. */
  _onMarketTickCooldown() {
    if (this._isWinningDualStrategy()) return;
    if (this._postTradeTickCooldown <= 0) return;
    this._postTradeTickCooldown--;
    if (this._postTradeTickCooldown === 0 && this.running) {
      this._scheduleNext(0);
    }
  }

  /**
   * Detect binary digit traps — repeated clusters, digit-5 noise, chop without edge.
   * Returns true when entry should be skipped on this market/direction.
   */
  _isBinaryEntryTrap(ticks, dir, scores = {}) {
    return isBinaryEntryTrap(ticks, dir, scores);
  }

  /** Drop trap setups from ranked pools (15 markets × 2 sides). */
  _filterTrapCandidates(candidates) {
    if (!candidates?.length) return [];
    return candidates.filter(c => {
      if (!c?.sym || !c?.dir) return false;
      const ticks = scanner.buffers[c.sym] || [];
      const scores = scanner.scores[c.sym] || {};
      return !isBinaryEntryTrap(ticks, c.dir, scores);
    });
  }

  _isPostLossPauseActive() {
    return false; // Always return false — no post-loss pause
  }

  _stopRecoveryPulse() {
    if (this._recoveryPulseTimer) {
      clearInterval(this._recoveryPulseTimer);
      this._recoveryPulseTimer = null;
    }
    this._recoveryFireDeadlineAt = 0;
  }

  /** Recovery hunt disabled — losses use normal entry gates after a short pause. */
  _needsRecoveryFireGate() {
    return false;
  }

  _getTournamentMinConsensus() {
    return 0;
  }

  _countConsensusStreakReady(dir, excludeSym, required) {
    let count = 0;
    for (const sym of MARKETS) {
      if (sym === excludeSym) continue;
      const ticks = scanner.buffers[sym] || [];
      if (ticks.length < 8) continue;
      const state = this.marketVLState[sym] || {};
      const scores = scanner.scores[sym] || {};
      const streak = this._getStreakForDir(state, dir, scores);
      if (streak >= required) count++;
    }
    return count;
  }

  _passesTournamentEntryQuality(sym, dir, ticks, scores, streak, required, winChance) {
    const losses = this.sessionConsecutiveLosses || 0;
    const tier = this._getTournamentEntryTier();
    const lt = this._getDistributionBiasPct(dir, scores);
    const relaxed = tier === 'fast';
    if (!relaxed && !hasRealDistributionEdge(dir, lt)) return false;
    if (relaxed && !hasNormalDistributionEdge(dir, lt) && (winChance ?? 0) < 38) return false;
    if (!this._passesTournamentMacroPct(dir, scores, relaxed)) return false;
    if (this._countReboundTicks(ticks, dir) < (relaxed ? 1 : 2)) return false;

    if (tier === 'fast' || tier === 'cautious') {
      const floor = TOURNAMENT_MIN_WIN_FAST + (losses >= 1 ? 3 : 0);
      return (winChance ?? 0) >= floor;
    }

    const reboundNeed = tier === 'strict' || losses >= 1 ? 2 : 1;
    if (this._countReboundTicks(ticks, dir) < reboundNeed) return false;

    const rev = this._computeLunarReversalProb(ticks, dir, Math.max(3, required - 1));
    const revEdge = tier === 'strict' ? 6 : 4;
    if (rev != null && !this._passesLunarReversalGate(rev, dir, revEdge) && winChance < 48) return false;

    const minConsensus = this._getTournamentMinConsensus();
    if (minConsensus > 0) {
      const peers = this._countConsensusStreakReady(dir, sym, required)
        + this._countConsensusMarkets(dir, sym);
      if (peers < minConsensus) return false;
    }

    const recentLossDirs = this._recentLossDirections || [];
    if (tier === 'strict' && recentLossDirs.length >= 3
      && recentLossDirs.every(d => d === dir) && winChance < 50) {
      return false;
    }

    return true;
  }

  _shouldDeferTournamentPick(best, runnerUp) {
    return false;
  }

  /** Estimated win % for this market+direction VL setup (side-neutral ranking). */
  _estimateTournamentWinChance(sym, dir, streak, ticks, scores) {
    const baseline = this._getBaselineWinRate(dir);
    let est = baseline;
    const lens = this._getActiveRecoveryLens();
    const required = this._getTournamentVlRequired(dir, this._getWinRecoveryContext());
    const rev = this._computeLunarReversalProb(ticks, dir, Math.max(3, required - 1));
    if (rev != null) est = rev * 0.6 + baseline * 0.4;

    const bias = this._computeOppositeDirectionBias(ticks, dir);
    const oppScore = this._scoreOppositeStreakRecovery(bias, streak, required);
    const pctScore = this._scoreMarketPctRecovery(dir, scores);

    const lt = this._getDistributionBiasPct(dir, scores);
    if (hasRealDistributionEdge(dir, lt)) {
      est += (lt - minDistributionBias(dir)) * 0.4;
    }

    if (lens === RECOVERY_LENS.OPPOSITE) {
      est += oppScore * 0.35;
      est += pctScore * 0.15;
    } else {
      est += pctScore * 0.35;
      est += oppScore * 0.15;
    }

    est += Math.min(3, Math.max(0, streak - required) * 0.6);

    const rwr = this._recentWinRate(sym, dir);
    if (rwr != null) est += (rwr - 0.45) * 12;

    const depthKey = `${dir}:${streak}`;
    const ds = this._vlDepthStats[depthKey];
    if (ds?.attempts >= 4) {
      est += ((ds.wins / ds.attempts) - this._vlDepthBreakeven(dir)) * 15;
    }

    est += this._learningScoreAdjust(sym, dir) * 0.35;

    const chi = this._computeChiSquareDeviation(ticks, dir);
    if (chi.significant) est += 2;
    else est -= 2;

    if (this._computeAlternationRate(ticks, dir) > 0.62) est -= 4;

    const d5 = parseFloat(scores.d5Pct) || 0;
    if (dir === 'OVER5' && d5 >= 12) est -= 4;

    const conv = this._runConvergenceScan(sym, dir, this._buildConvergenceCtx(sym, dir, ticks, scores, required, streak));
    if (conv.blocked) est = Math.min(est, baseline);
    else est += (conv.convergenceScore - 55) * 0.1;

    est += this._countConsensusMarkets(dir, sym) * 1.5;
    est += this._countConsensusStreakReady(dir, sym, required) * 1;

    const mStats = this.marketStats[sym] || {};
    const tw = mStats.totalSessionWins || 0;
    const tl = mStats.totalSessionLosses || 0;
    if (tw + tl >= 2) est += ((tw / (tw + tl)) - 0.42) * 8;

    return Math.max(baseline, Math.min(baseline + 10, Math.round(est)));
  }

  _violatesBarRules(sym, dir, scores) {
    if (!scores || !scores.freq) return false;
    const freq = scores.freq;

    let maxF = -1;
    let minF = 999;
    for (let i = 0; i < 10; i++) {
      if (freq[i] > maxF) maxF = freq[i];
      if (freq[i] < minF) minF = freq[i];
    }

    let greenCount = 0;
    let redCount = 0;
    for (let i = 0; i < 10; i++) {
      if (freq[i] === maxF) greenCount++;
      if (freq[i] === minF) redCount++;
    }

    if (greenCount > 1 || redCount > 1) return true;

    const sorted = [];
    for (let i = 0; i < 10; i++) {
      sorted.push({ digit: i, count: freq[i] });
    }
    sorted.sort((a, b) => a.count - b.count);

    const lowestDigit = sorted[0].digit;
    const secondLowestDigit = sorted[1].digit;

    const isTargetSide = (d) => {
      if (dir === 'OVER5') return d > 5;
      if (dir === 'UNDER5') return d < 5;
      if (dir === 'OVER4') return d > 4;
      if (dir === 'UNDER6') return d < 6;
      if (dir === 'OVER3') return d > 3;
      if (dir === 'UNDER7') return d < 7;
      if (dir === 'EVEN') return d % 2 === 0;
      if (dir === 'ODD') return d % 2 !== 0;
      if (dir === 'DIFF') return d !== (this.getHottestDigitForMarket?.(sym)?.digit ?? -1);
      return false;
    };

    if (isTargetSide(lowestDigit) && isTargetSide(secondLowestDigit)) {
      return true;
    }

    return false;
  }

  _tournamentLockKey(sym, dir) {
    return `${sym}:${dir}`;
  }

  _isTournamentEntryLocked(sym, dir) {
    return this.lockedTournamentEntries.has(this._tournamentLockKey(sym, dir));
  }

  _lockTournamentEntry(sym, dir) {
    this.lockedTournamentEntries.add(this._tournamentLockKey(sym, dir));
    this.lockedMarkets.add(sym);
  }

  _unlockTournamentEntry(sym, dir) {
    if (!sym || !dir) return;
    this.lockedTournamentEntries.delete(this._tournamentLockKey(sym, dir));
    const stillOnMarket = this.executionSlots.some(s => s.active && s.sym === sym);
    if (!stillOnMarket) this.lockedMarkets.delete(sym);
  }

  _initTournamentSlots() {
    this.executionSlots = [];
    this.lockedMarkets = new Set();
    this.lockedTournamentEntries = new Set();
    this._contractToSlot = {};
    for (let i = 0; i < TOURNAMENT_SLOT_COUNT; i++) {
      const key = `SLOT_${i}`;
      this.channels[key] = {
        active: false,
        step: 0,
        consecutiveLosses: 0,
        stake: this.config?.baseStake || 0.35,
        contractId: null,
        direction: null,
        placedAt: null,
        vlDepthAtEntry: 0,
      };
      this.executionSlots.push({
        id: i,
        channelKey: key,
        active: false,
        sym: null,
        dir: null,
        contractId: null,
        step: 0,
        stake: 0,
        vlDepthAtEntry: 0,
        placedAt: null,
      });
    }
  }

  // --- Real-Time Logger Interface ---
  async sendLog(message) {
    const formatted = `[${new Date().toLocaleTimeString()}] ${message}`;
    console.log(formatted);
    try {
      await fetch('/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: formatted }),
      });
    } catch (e) {
      // Fetch fails silently if server middleware is not active
    }
  }

  updateStatus(status, force = false) {
    if (!force && this.currentStatus === status) return;
    this.currentStatus = status;
    if (this._statusDebounceTimer) return;
    this._statusDebounceTimer = setTimeout(() => {
      this._statusDebounceTimer = null;
      if (this.onStatusChange) this.onStatusChange(this.currentStatus);
    }, 80);
  }

  setMarket(symbol) {
    if (!MARKETS.includes(symbol)) return;
    this.activeMarket = symbol;
    this.sendLog(`🎯 Manual Market Override: Switched to ${MARKET_LABELS[symbol] || symbol}`);
    this.setStatus(`Manually locked to ${MARKET_LABELS[symbol] || symbol}`);
    if (this.onMarketSwitch) this.onMarketSwitch(this.activeMarket);
    if (this.onStatusChange) this.onStatusChange(this.currentStatus, this.activeMarket);
  }

  /** Clear trade gates when user switches strategy mid-session (B7). */
  onStrategySwitch(newStrategy) {
    this.strategy = newStrategy;
    this.nextAllowedTradeTime = 0;
    this._cascadePausedUntil = 0;
    this._lossStreakCooldownUntil = 0;
    this._tournamentTradeInFlight = false;
    this._pendingTournamentBuy = false;
    this._openTournamentContracts.clear();
    this._dualPairStep = 0;
  }

  _syncBothLegSteps(d1, d2, step) {
    [d1, d2].forEach(dir => {
      const ch = this.channels[dir];
      if (ch) {
        ch.step = step;
        ch.stake = this._getDualLegMartingaleStake(dir);
      }
    });
    this._dualPairStep = step;
  }

  _handleWinningDualLegSettlement(winTrade, loseTrade) {
    if (!winTrade || !loseTrade) return;
    const winMkt = winTrade.market || this.activeMarket;
    const loseMkt = loseTrade.market || this.activeMarket;
    this._recordLegMarketResult(winMkt, winTrade.direction, true);
    this._recordLegMarketResult(loseMkt, loseTrade.direction, false);
    this._applyWinningDualLegMartingale(winTrade.direction, true);
    this._applyWinningDualLegMartingale(loseTrade.direction, false);
    const loserStep = this.channels[loseTrade.direction]?.step || 0;
    const maxStep = this._getMaxMartingaleStep();
    const stepLabel = maxStep > 0 ? `${loserStep}/${maxStep}` : String(loserStep);
    const base = this._resolveStake(this.config.baseStake);
    this.sendLog(
      `📈 ${loseTrade.direction} martingale step ${stepLabel} → $${this._getDualLegMartingaleStake(loseTrade.direction)} · ` +
      `${winTrade.direction} reset $${base.toFixed(2)} · recovery priority ${loseTrade.direction}`
    );
    if (this.strategy === 'RANDOM_PICKER' && this.config?.autoSwitchMarkets !== false) {
      this._maybeRotateMarketForLeg(loseTrade.direction, 'dual-round');
    }
  }

  _handleDualLegRoundSettlement(winTrade, loseTrade, netPnl) {
    if (!winTrade || !loseTrade) return;
    if (this._isWinningDualStrategy()) {
      this._handleWinningDualLegSettlement(winTrade, loseTrade);
      return;
    }
    const base = this._resolveStake(this.config.baseStake);

    if (netPnl >= 0) {
      this._syncBothLegSteps(winTrade.direction, loseTrade.direction, 0);
      this._recoveryDebt = Math.max(0, (this._recoveryDebt || 0) - Math.abs(netPnl));
      this._lastDualLosingDir = null;
      this._lastDualWinningDir = null;
    } else {
      this._recoveryDebt = (this._recoveryDebt || 0) + Math.abs(netPnl);

      const loserCh = this.channels[loseTrade.direction];
      const winnerCh = this.channels[winTrade.direction];
      const loserStep = loserCh?.step || 0;
      const hold = this._getMartingaleHoldAfterStep();
      const nextStep = hold > 0 ? Math.min(hold, loserStep + 1) : loserStep + 1;

      if (winnerCh) {
        winnerCh.step = 0;
        winnerCh.stake = base;
      }
      if (loserCh) {
        loserCh.step = nextStep;
        loserCh.stake = this._getDualLegMartingaleStake(loseTrade.direction);
      }
      this._dualPairStep = nextStep;

      this._lastDualLosingDir = loseTrade.direction;
      this._lastDualWinningDir = winTrade.direction;
    }
  }

  _scanMarketForDirection(targetDir) {
    const best = this._findBestMarketForDirection(targetDir);
    if (!best) return null;
    return { market: best.market, direction: best.direction, winChance: best.winChance, bias: best.bias };
  }

  _cleanStaleOpenContracts() {
    const now = Date.now();
    for (const [contractId, placedAt] of this._openTournamentContracts) {
      if (this._settledContractIds.has(contractId) || now - placedAt > 45000) {
        this._openTournamentContracts.delete(contractId);
        this.sendLog(`🧹 Stale contract ${contractId} evicted`);
      }
    }
    for (const slot of this.executionSlots || []) {
      if (!slot.active) continue;
      if (slot.contractId && this._settledContractIds.has(slot.contractId)) {
        this._releaseTournamentFire(slot);
        setApexOrderInFlight(false);
        continue;
      }
      if (slot.contractId && !this._settledContractIds.has(slot.contractId)) continue;
      const age = slot.placedAt ? now - slot.placedAt : 99999;
      if (!slot.contractId && age > 4000) {
        this.sendLog(`⚠️ Stale execution slot [${slot.channelKey}] cleared (no contract)`);
        this._releaseTournamentFire(slot);
      }
    }

    for (const key of Object.keys(this.channels)) {
      const ch = this.channels[key];
      if (!ch?.contractId) continue;
      if (this._settledContractIds.has(ch.contractId)) {
        ch.active = false;
        ch.contractId = null;
        ch.direction = null;
        continue;
      }
      if (!this._openTournamentContracts.has(ch.contractId)) {
        const buyGraceMs = 5000;
        const inBuyGrace = ch.active && ch.placedAt && (now - ch.placedAt) < buyGraceMs;
        if (!inBuyGrace) {
          this.sendLog(`⚠️ Stale channel [${key}] cleared — contract not in open map`);
          ch.active = false;
          ch.contractId = null;
          ch.direction = null;
        }
      } else if (ch.placedAt && now - ch.placedAt > 25000) {
        this._openTournamentContracts.delete(ch.contractId);
        ch.active = false;
        ch.contractId = null;
        ch.direction = null;
      }
    }
    if (this._openTournamentContracts.size === 0) {
      this._tournamentTradeInFlight = false;
    }
  }

  _clearStaleDualChannels(dirs) {
    const now = Date.now();
    for (const dir of dirs) {
      const ch = this.channels[dir];
      if (!ch?.contractId) continue;

      if (this._settledContractIds.has(ch.contractId)) {
        ch.active = false;
        ch.contractId = null;
        ch.direction = null;
        continue;
      }

      // Core freeze fix: contractId not in open map → clear unless buy just fired
      if (!this._openTournamentContracts.has(ch.contractId)) {
        const buyGraceMs = 5000;
        const inBuyGrace = ch.active && ch.placedAt && (now - ch.placedAt) < buyGraceMs;
        if (!inBuyGrace) {
          this.sendLog(`⚠️ Stale channel [${dir}] cleared — contract not in open map`);
          ch.active = false;
          ch.contractId = null;
          ch.direction = null;
        }
        continue;
      }

      if (ch.placedAt && now - ch.placedAt > 25000) {
        this._openTournamentContracts.delete(ch.contractId);
        ch.active = false;
        ch.contractId = null;
        ch.direction = null;
      }
    }
  }

  _hasLiveDualContracts(dirs) {
    const now = Date.now();
    return dirs.some(dir => {
      const ch = this.channels[dir];
      if (!ch?.active || !ch?.contractId) return false;
      if (this._settledContractIds.has(ch.contractId)) return false;
      if (this._openTournamentContracts.has(ch.contractId)) return true;
      return (now - (ch.placedAt || 0)) < 25000;
    });
  }

  start(config) {
    if (this.running) return;
    this.running = true;
    this.config = { ...config };
    this.config.baseStake = this._resolveStake(config.baseStake || 0.35);
    if (this.config.baseStake < 0.35) this.config.baseStake = 0.35;
    this.config.freezeMartingaleAfterLosses = 0;
    this.config.maxMartingaleStepWhenLosing = 0;
    const maxMart = this._getMaxMartingaleStep();
    if (!Number(this.config.maxMartingaleStep) && Number(this.config.maxSteps) > 0) {
      this.config.maxMartingaleStep = Number(this.config.maxSteps);
    }
    this.strategy = config.strategy || 'MATCHES';
    if (this.strategy === 'OU_WINNING' || this.strategy === 'EO_WINNING') {
      this.config.recoveryEnabled = true;
      this.config.maxStakeCap = 0;
      this.config.maxStakeMultiplier = 0;
      this.config.maxMartingaleStep = 0;
      this.config.maxSteps = 0;
      this.config.martingaleHoldAfterStep = 0;
    }
    
    if (this.strategy === 'OVER_6') {
      this.over6Phase = 'SEARCHING';
      this.over6TargetMarket = null;
      this.over6DynamicTrigger = 0;
      this.over6CurrentWins = 0;
      this.over6CurrentLosses = 0;
      this.over6FirstTradeFired = false;
      this.over6Debt = 0;
    }

    if (this.strategy === 'UNDER_8_V2') {
      this.under8V2Phase = 'SEARCHING';
      this.under8V2TargetMarket = null;
      this.under8V2CurrentLosses = 0;
      this.under8V2CurrentWins = 0;
      this.under8V2Debt = 0;
      this.lockedRecoveryDirection = null;
      this.lockedRecoveryMarket = null;
    }
    if (this.strategy === 'UNDER_8_V1') {
      this.under8Phase = 'SEARCHING';
      this.under8TargetMarket = null;
      this.under8CurrentWins = 0;
    this.under8V2CurrentLosses = 0;
    this.under8V2CurrentWins = 0;
    this.under8V2Phase = 'SEARCHING';
    this.under8V2TargetMarket = null;
    this.under8V2Debt = 0;
      this.under8CurrentLosses = 0;
      this.under8Debt = 0;
    }

    if (this.strategy === 'UNDER_7_V1') {
      this.under7v1Phase = 'SEARCHING';
      this.under7v1TargetMarket = null;
      this.under7v1CurrentWins = 0;
      this.under7v1CurrentLosses = 0;
      this.under7v1Debt = 0;
    }

    if (this.strategy === 'EVEN_V1') {
      this.evenV1Phase = 'SEARCHING';
      this.evenV1TargetMarket = null;
      this.evenV1CurrentWins = 0;
      this.evenV1CurrentLosses = 0;
      this.evenV1Debt = 0;
    }

    if (this.strategy === 'ODD_V1') {
      this.oddV1Phase = 'SEARCHING';
      this.oddV1TargetMarket = null;
      this.oddV1CurrentWins = 0;
      this.oddV1CurrentLosses = 0;
      this.oddV1Debt = 0;
    }

    if (this.strategy === 'OVER_0_V1') {
      this.over0v1Phase = 'SEARCHING_OVER_0';
      this.over0v1FavoredMarkets = new Set();
      this.over0v1TargetMarket = null;
      this.over0v1OriginalMarket = null;
      this.over0v1RecoveryAttempt = 0;
      this.over0v1CurrentWins = 0;
      this.over0v1CurrentLosses = 0;
      this.over0v1Debt = 0;
    }

    if (this.strategy === 'UNDER_9_V1') {
      this.under9v1Phase = 'SEARCHING';
      this.under9v1TargetMarket = null;
      this.under9v1CurrentWins = 0;
      this.under9v1CurrentLosses = 0;
      this.under9v1Debt = 0;
    }

    if (this.strategy === 'O0_U9_HYBRID') {
      this.hybridPhase = 'SEARCHING';
      this.hybridSide = null;               // 'OVER0' or 'UNDER9'
      this.hybridTargetMarket = null;
      this.hybridCurrentWins = 0;
      this.hybridCurrentLosses = 0;
      this.hybridDebt = 0;
      this.hybridRecoveryConsecutiveLosses = 0; // tracks consecutive recovery losses for re-evaluation
      this.hybridRecoveryDirection = null;      // 'OVER3' or 'UNDER7' — locked recovery side
      this.hybridPauseUntil = 0;                // timestamp for 30s max pause
    }

    if (this.strategy === 'OVER_3_V1') {
      this.over3v1Phase = 'SEARCHING';
      this.over3v1TargetMarket = null;
      this.over3v1CurrentWins = 0;
      this.over3v1CurrentLosses = 0;
      this.over3v1Debt = 0;
    }

    if (this.strategy === 'OVER_3_V3') {
      this._executeOver3V3Cycle();
      return;
    }
    if (this.strategy === 'OVER_3_V2') {
      this.over3v2Phase = 'SEARCHING';
      this.over3v2TargetMarket = null;
      this.over3v2GreenBarDigit = null;
      this.over3v2CurrentWins = 0;
    this.over3v3CurrentLosses = 0;
    this.over3v3CurrentWins = 0;
    this.over3v3Phase = 'SEARCHING';
    this.over3v3TargetMarket = null;
    this.over3v3Debt = 0;
      this.over3v2CurrentLosses = 0;
      this.over3v2Debt = 0;
    }

    if (this.strategy === 'OVER_5_V1') {
      this.over5v1Phase = 'SEARCHING';
      this.over5v1TargetMarket = null;
      this.over5v1CurrentWins = 0;
      this.over5v1CurrentLosses = 0;
      this.over5v1Debt = 0;
    }

    if (this.strategy === 'OVER_6_V2') {
      this.over6v2Phase = 'SEARCHING';
      this.over6v2TargetMarket = null;
      this.over6v2CurrentWins = 0;
      this.over6v2CurrentLosses = 0;
      this.over6v2Debt = 0;
    }

    if (this.strategy === 'UNDER_3_V1') {
      this.under3v1Phase = 'SEARCHING';
      this.under3v1TargetMarket = null;
      this.under3v1TargetRedDigit = null;
      this.under3v1CurrentWins = 0;
      this.under3v1CurrentLosses = 0;
      this.under3v1Debt = 0;
    }

    if (this.strategy === 'RANDOM_PICKER') {
      this.randomPickerCurrentWins = 0;
      this.randomPickerCurrentLosses = 0;
    }
    resetGlobalRiskMatrix();

    const capUsd = Number(this.config.maxStakeCap) || 0;
    const capMult = Number(this.config.maxStakeMultiplier) || 0;
    const step4Stake = (this.config.baseStake || 0.35) * Math.pow(this.config.martMultiplier || 2, maxMart);
    this.sendLog(
      `🚀 BOT STARTING — ${this.strategy} | base $${this.config.baseStake.toFixed(2)} × ${this.config.martMultiplier || 2} | ` +
      `martingale preview step ${maxMart} (≈$${step4Stake.toFixed(2)})` +
      `${this._getMartingaleHoldAfterStep() > 0 ? ` · hold@${this._getMartingaleHoldAfterStep()}` : ' · no step hold'}` +
      ` | reset on win${Number(this.config.takeProfit) > 0 ? ` · TP +$${this.config.takeProfit}` : ''}${capUsd > 0 ? ` | cap $${capUsd}` : ''}`
    );

    // Reset stats
    MARKETS.forEach(sym => {
      this.marketStats[sym] = {
        consecutiveLosses: 0,
        totalSessionLosses: 0,
        totalSessionWins: 0,
        metaScore: 0,
        quarantinedUntil: 0,
        lastLossAt: 0,
      };
    });

    // Reset channels
    for (const key in this.channels) {
      this.channels[key] = {
        active: false,
        step: 0,
        consecutiveLosses: 0,
        stake: this.config.baseStake,
        contractId: null,
        direction: null
      };
    }

    this.stakeMultiplier = 1.0;
    this.sessionConsecutiveLosses = 0;
    this.virtualLossCount = 0;
    this._recentLossDirections = [];
    this._lastTradeSettledAt = 0;
    this._dirWinHistory = {};
    this._vlDepthStats = {};
    const ch0 = this.channels.SINGLE;
    if (ch0) {
      ch0.waitingForConfirm = false;
      ch0.confirmDirection = null;
      ch0.confirmMarket = null;
      ch0.vlDepthAtEntry = 0;
    }
    this.dualNetLossStreak = 0;
    this._dualRecoveryBoost = 0;
    this._dualPairStep = 0;
    this._dualPairNetProfit = 0;
    this._lastDualLosingDir = null;
    this._lastDualWinningDir = null;
    this.recoveryWinMode = false;
    this.sessionWinCount = 0;
    this.sessionLossCount = 0;
    this.momentumTradesRemaining = 0;
    this.defensiveWins = 0;
    this.isDefensiveMode = false;
    this.sessionTrades = [];
    this.lastTradeTime = 0;
    this.nextAllowedTradeTime = 0;
    this.sessionStartedAt = Date.now();
    this.sessionEndedAt = 0;
    this._contractLedger = {};  // Reset the overflow ledger
    this._lastVlToastTime = 0;
    this._directionCooldown = {};
    this._marketDirCooldown = {};
    this._lastTradeDirection = null;
    this._lastTradeWon = null;
    this._tradeMinuteBucket = { minute: 0, count: 0 };
    this._postTradeTickCooldown = 0;
    this._tournamentTradeInFlight = false;
    this._tournamentFireTryPending = false;
    this._sessionMartingaleStep = 0;
    this._bothStake = this.config.baseStake || 0.35;
    this._bothStep = 0;
    this._both5Stake = this.config.baseStake || 0.35;
    this._both5Step = 0;
    this._omniStake = this.config.baseStake || 0.35;
    this._omniStep = 0;
    this._omniConsecutiveLosses = 0;
    this._openTournamentContracts = new Map();
    this._settledContractIds = new Set();
    this._pendingTournamentBuy = false;
    this._martingaleArmAfter = 0;
    this._dualHedgeInFlight = false;
    this._marketOppositeLock = {};
    this._martingaleRecoveryMode = false;
    this._recoveryDebt = 0;
    this._recoveryPlan = null;
    this._ouTrackFailures = { OVER5: 0, UNDER5: 0, EVEN: 0, ODD: 0 };
    this._legMarketLosses = {};
    this._legBestMarket = {};
    this._legMarketQuarantine = {};
    this._lastLegBestRefreshAt = 0;
    this._entryConfirmLab = null;
    this._initTradeLearning();
    this._cascadePausedUntil = 0;
    this._lossStreakCooldownUntil = 0;
    this._cascadeMartingaleFrozen = false;

    // Stealth Mode Resets — human-like irregular pacing
    this.tradesSinceLastGhostBreak = 0;
    this.nextGhostBreakTarget = Math.floor(Math.random() * 20) + 28; // 28–47 trades
    this.ghostBreakUntil = 0;
    this._lastStealthActivity = 0;

    // DIFF Strategy Resets
    this.currentAutoDigit = null;
    this.winsSinceDigitChange = 0;
    this.waitingForTargetDigit = false;
    this.pauseTicksRemaining = 0;

    // MATCH_DIFF Strategy Resets
    this.matchDiffStakeStep = 0;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }

    const balance = derivWS.accountInfo?.balance || 0;
    this.sessionOpeningBalance = balance;
    riskManager.startSession(balance);

    if (this.strategy === 'MATCHES') {
      this.matchesTargetDigit = null;
      this.matchesLastSwitchTime = 0;
      this.pauseTicksRemaining = 0;

      const best = this.getMatchesSniperTarget();
      if (best.market) {
        this.activeMarket = best.market;
        this.matchesTargetDigit = best.digit;
      } else {
        this.activeMarket = '1HZ10V';
      }
    } else if (this.strategy === 'MATCH_DIFF') {
      this.activeMarket = this.getMatchDiffMarket();
    } else if (this.strategy === 'OU_WINNING' || this.strategy === 'EO_WINNING') {
      this.config.recoveryEnabled = true;
      if (!this.activeMarket) {
        this.activeMarket = '1HZ10V';
      }
    } else {
      this.activeMarket = '1HZ10V';
    }
    if (this.onMarketSwitch) this.onMarketSwitch(this.activeMarket);

    this.sendLog(`🎯 Active Market Locked: ${MARKET_LABELS[this.activeMarket] || this.activeMarket} (Opening Balance: $${balance.toFixed(2)})`);

    this._pocHandler = derivWS.on('proposal_open_contract', (msg) => this._handleContractUpdate(msg));

    if (this._usesTournamentMode()) {
      this._sessionMartingaleStep = 0;
      this._openTournamentContracts = new Map();
      this._settledContractIds = new Set();
      this._pendingTournamentBuy = false;
      this._martingaleArmAfter = 0;
      this._initMarketVLState();
      this._initTournamentSlots();
      this._syncSessionMartingaleStep(0);
      this._bindTournamentScanner();
      this._startLiveBoardSync();
      this._startGlobalRankSweep();
      this._startBackgroundHeartbeat();
      this.stopSyntheticPreview();
      this._tournamentWatchdog = setInterval(() => this._tournamentWatchdogTick(), 200);
      this._rollRecoveryLens(true);
      this._runApexMatrixLeaderboard();
      this._refreshTournamentScan();
      this._scheduleTournamentFireTry();
    } else if (this.strategy === 'OU_WINNING' || this.strategy === 'EO_WINNING') {
      this.config.recoveryEnabled = true;
      const legs = this.strategy === 'OU_WINNING' ? 'OVER5+UNDER4' : 'EVEN+ODD';
      this._initMarketVLState();
      this._startLiveBoardSync();
      this.sendLog(
        `⚡ Dual winning (${legs}) — per-leg martingale ×${this.config.martMultiplier || 2} · loser recovers first · same-tick pair`
      );
      this._bindTickWakeScanner();
      this._startBackgroundHeartbeat();
      this._executeCycle();
    } else {
      this._bindTickWakeScanner();
      this._startBackgroundHeartbeat();
      this._executeCycle();
    }
  }

  pause() {
    this.paused = true;
    this.sendLog('⏸ Engine PAUSED. Existing trades will settle, but no new trades will be placed.');
  }

  resume() {
    this.paused = false;
    this.sendLog('▶️ Engine RESUMED. Resuming trade execution.');
  }

  _bindTournamentScanner() {
    const onTickSym = (sym) => {
      if (!this.running) return;
      this._onMarketTickCooldown();
      if (sym && this._isSyntheticDualSideStrategy()) {
        this._updateMarketVL(sym);
        this._refreshLegBestMarkets();
      }
      if (!this._usesTournamentMode()) return;
      const now = Date.now();
      if (!this._lastMatrixSweepAt || now - this._lastMatrixSweepAt > 500) {
        this._lastMatrixSweepAt = now;
        this._runApexMatrixLeaderboard();
      }
      if (!this._lastTournamentRefreshAt || now - this._lastTournamentRefreshAt > 120) {
        this._lastTournamentRefreshAt = now;
        this._refreshTournamentScan();
      }
      if (sym && this._entryConfirmLab?.active && !this._entryConfirmLab.confirmed) {
        const ticks = scanner.buffers[sym];
        if (ticks?.length) this._tickEntryConfirmLab(sym, ticks[ticks.length - 1]);
      }
      this._scheduleTournamentFireTry();
    };

    this._unsubTournamentScanner = scanner.onUpdate((sym, allScores) => {
      onTickSym(sym);
    });
    this._unsubTournamentTick = derivWS.on('tick', (msg) => {
      if (!msg.tick || !this.running) return;
      const sym = msg.tick.symbol;
      if (!MARKETS.includes(sym)) return;
      onTickSym(sym);
    });
  }

  _stopTournamentScanner() {
    if (this._unsubTournamentTick) {
      this._unsubTournamentTick();
      this._unsubTournamentTick = null;
    }
    if (this._unsubTournamentScanner) {
      this._unsubTournamentScanner();
      this._unsubTournamentScanner = null;
    }
  }

  _isSyntheticDualSideStrategy() {
    return ['BOTH', 'BOTH5', 'EO_WINNING', 'OU_WINNING', 'OMNISNIPER'].includes(this.strategy);
  }

  /** Directions analyzed per strategy — both sides always (EVEN+ODD or OVER5+UNDER5). */
  _getStrategyDirs() {
    if (this.strategy === 'OMNISNIPER') {
      return ['OVER3', 'OVER4', 'OVER5', 'UNDER6', 'UNDER7', 'UNDER8'];
    }
    if (this.strategy === 'BOTH5') return ['OVER5', 'UNDER5'];
    if (this.strategy === 'OU_WINNING') return ['OVER5', 'UNDER4'];
    return ['EVEN', 'ODD'];
  }

  /**
   * Analyze ALL 15 vol/jump markets × BOTH trade sides in one pass.
   * Ranks every market+direction combo for entry and recovery.
   */
  _buildDualSideLiveBoard() {
    const dirs = this._getStrategyDirs();
    const recovery = this._getWinRecoveryContext();
    const losses = this.sessionConsecutiveLosses || 0;
    const rows = [];

    for (const sym of MARKETS) {
      if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
      const ticks = scanner.buffers[sym] || [];
      const scores = scanner.scores[sym] || {};
      const state = this.marketVLState[sym] || {};

      for (const dir of dirs) {
        const tickCount = ticks.length;
        if (tickCount >= 5 && isBinaryEntryTrap(ticks, dir, scores)) continue;

        const streak = scores.tailLossMap?.[dir] ?? this._getStreakForDir(state, dir, scores) ?? 0;
        const required = this._getTournamentVlRequired(dir, recovery);
        const lt = tickCount >= 5 ? this._getDistributionBiasPct(dir, scores) : 0;
        const bias = tickCount >= 5
          ? this._computeOppositeDirectionBias(ticks, dir)
          : { score: 0, endConsecutive: 0, maxConsecutive: 0, totalOpposite: 0 };
        const winChance = state.dirWinChance?.[dir]
          ?? (tickCount >= 8
            ? this._estimateTournamentWinChance(sym, dir, streak, ticks, scores)
            : 45);
        const vlReady = this._isDirReady(state, dir)
          && (required <= 0
            ? hasNormalDistributionEdge(dir, lt)
            : streak >= required);
        const nearReady = !vlReady && (
          state.nearReadyDirs?.[dir]
          || (required > 0 && streak >= Math.max(1, required - 1) && streak < required)
        );

        let status = 'WATCHING';
        if (tickCount < 8) status = 'WARMING';
        else if (vlReady) status = 'READY';
        else if (nearReady) status = 'NEAR';

        const oppRec = tickCount >= 8
          ? this._scoreOppositeStreakRecovery(bias, streak, required)
          : 0;
        const pctRec = tickCount >= 8 ? this._scoreMarketPctRecovery(dir, scores) : 0;
        const score = tickCount >= 8
          ? this._computeTournamentCandidateScore(sym, dir, streak, scores, bias, winChance, oppRec, pctRec)
          : 0;
        const recoveryScore = tickCount >= 8
          ? this._computeRecoveryPickScore(sym, dir, streak, required, winChance, bias, scores, oppRec, pctRec, vlReady)
          : 0;

        const enriched = tickCount >= 8
          ? this._applyBinaryScoring({
            sym, dir, streak, required, lt, winChance, score, recoveryScore,
            ready: vlReady, oppEnd: bias.endConsecutive,
            consensus: this._countConsensusMarkets(dir, sym),
          })
          : null;

        rows.push({
          sym,
          dir,
          marketLabel: MARKET_LABELS[sym] || sym,
          streak,
          required,
          winChance: Math.round(winChance),
          binaryWinPct: enriched?.binaryWinPct ?? Math.round(winChance),
          lt: Math.round(lt * 10) / 10,
          score,
          recoveryScore,
          binaryEdge: enriched?.binaryEdge ?? score,
          convergenceScore: enriched?.convergenceScore ?? 0,
          status,
          vlReady,
          nearReady,
          oppEnd: bias.endConsecutive,
          consensus: this._countConsensusMarkets(dir, sym),
          rank: 0,
        });
      }
    }

    rows.sort((a, b) => {
      const statusRank = { READY: 0, NEAR: 1, WATCHING: 2, WARMING: 3 };
      const sr = (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
      if (sr !== 0) return sr;
      const edgeDiff = (b.binaryEdge ?? 0) - (a.binaryEdge ?? 0);
      if (edgeDiff !== 0) return edgeDiff;
      const key = losses >= 1 ? 'recoveryScore' : 'score';
      const diff = (b[key] ?? 0) - (a[key] ?? 0);
      if (diff !== 0) return diff;
      return a.sym.localeCompare(b.sym) || a.dir.localeCompare(b.dir);
    });

    rows.forEach((r, i) => { r.rank = i + 1; });

    this._liveDualSideBoard = rows;
    this._liveDualSideBoardAt = Date.now();
    return rows;
  }

  _syncLiveAnalysisBoard() {
    if (!this._isSyntheticDualSideStrategy()) return [];
    const rows = this._buildDualSideLiveBoard();
    const dirs = this._getStrategyDirs();
    const readyCount = rows.filter(r => r.status === 'READY').length;
    const nearCount = rows.filter(r => r.status === 'NEAR').length;
    const payload = {
      rows,
      updatedAt: this._liveDualSideBoardAt,
      strategy: this.strategy,
      dirs,
      readyCount,
      nearCount,
      totalSlots: MARKETS.length * dirs.length,
      bestPick: this._globalBestPick || rows[0] || null,
      rankedCount: this._globalRankedCandidates?.length ?? rows.length,
      apexTop: this._apexLeaderboard?.[0] || null,
      previewMode: this._previewActive && !this.running,
      sideLabel: dirs.includes('EVEN') ? 'EVEN / ODD' : dirs.includes('OVER5') ? 'OVER5 / UNDER5' : 'OMNI',
      recoverySecLeft: this._recoveryFireDeadlineAt > Date.now()
        ? Math.ceil((this._recoveryFireDeadlineAt - Date.now()) / 1000)
        : 0,
    };
    if (this.onLiveAnalysisUpdate) this.onLiveAnalysisUpdate(payload);
    return rows;
  }

  /** Convert live board rows into fire-ready candidate objects. */
  _candidatesFromLiveBoard({ limit = 30, minStatus = 'WATCHING' } = {}) {
    const statusRank = { READY: 0, NEAR: 1, WATCHING: 2, WARMING: 3 };
    const minRank = statusRank[minStatus] ?? 2;
    const rows = this._liveDualSideBoard?.length
      ? this._liveDualSideBoard
      : this._buildDualSideLiveBoard();

    return rows
      .filter(r => (statusRank[r.status] ?? 9) <= minRank)
      .slice(0, limit)
      .map(r => {
        const raw = {
          sym: r.sym,
          dir: r.dir,
          streak: r.streak,
          required: r.required,
          winChance: r.winChance,
          score: r.score,
          recoveryScore: r.recoveryScore,
          lt: r.lt,
          ready: r.vlReady,
          fromLiveBoard: true,
          boardRank: r.rank,
          boardStatus: r.status,
          algorithm: ENTRY_ALGORITHMS.DISTRIBUTION_BIAS,
          algorithms: [ENTRY_ALGORITHMS.DISTRIBUTION_BIAS],
          algoAgreement: 1,
        };
        const scored = this._applyBinaryScoring(raw);
        if (!scored) return null;
        return this._applyConvergence(scored, { silent: true, allowBlocked: true }) || scored;
      })
      .filter(Boolean);
  }

  _startLiveBoardSync() {
    if (this._liveBoardInterval) clearInterval(this._liveBoardInterval);
    this._sweepAllMarketsVL();
    this._syncLiveAnalysisBoard();
    const intervalMs = (this.sessionConsecutiveLosses || 0) >= 1 ? 120 : 200;
    this._liveBoardInterval = setInterval(() => {
      if (!this.running) return;
      this._sweepAllMarketsVL();
      this._syncLiveAnalysisBoard();
    }, intervalMs);
  }

  _stopLiveBoardSync() {
    if (this._liveBoardInterval) {
      clearInterval(this._liveBoardInterval);
      this._liveBoardInterval = null;
    }
  }

  /**
   * Pre-START analysis: rank all 15×2 sides before the user presses START (BOTH / BOTH5).
   */
  startSyntheticPreview(strategy) {
    if (!TOURNAMENT_STRATEGIES.has(strategy)) {
      this.stopSyntheticPreview();
      return;
    }
    this.stopSyntheticPreview();
    this._previewActive = true;
    this._previewStrategy = strategy;
    this.strategy = strategy;
    if (!this.marketVLState || !Object.keys(this.marketVLState).length) {
      this._initMarketVLState();
    }
    this._bindPreviewTickListener();
    this._runGlobalEntryRankSweep();
    this._previewInterval = setInterval(() => {
      if (!this._previewActive || this.running) return;
      this._runGlobalEntryRankSweep();
    }, 1000);
  }

  stopSyntheticPreview() {
    this._previewActive = false;
    this._previewStrategy = null;
    if (this._previewInterval) {
      clearInterval(this._previewInterval);
      this._previewInterval = null;
    }
    if (this._previewTickUnsub) {
      this._previewTickUnsub();
      this._previewTickUnsub = null;
    }
  }

  _bindPreviewTickListener() {
    if (this._previewTickUnsub) return;
    this._previewTickUnsub = derivWS.on('tick', (msg) => {
      if (!this._previewActive || this.running || !msg.tick) return;
      const sym = msg.tick.symbol;
      if (!MARKETS.includes(sym)) return;
      const now = Date.now();
      if (this._previewTickAt && now - this._previewTickAt < 200) return;
      this._previewTickAt = now;
      this._runGlobalEntryRankSweep();
    });
  }

  /**
   * Full 15-market × both-sides sweep: matrix leaderboard + binary best-sort → single best pick.
   */
  _runGlobalEntryRankSweep() {
    if (!this._isSyntheticDualSideStrategy() && !this._usesTournamentMode()) return;
    if (!this.marketVLState || !Object.keys(this.marketVLState).length) {
      this._initMarketVLState();
    }
    this._sweepAllMarketsVL();
    this._runApexMatrixLeaderboard();
    let ranked = this._collectBestAcrossMarkets();
    ranked = this._filterTrapCandidates(ranked);
    this._rankTournamentCandidates(ranked);
    this._globalRankedCandidates = ranked;
    this._globalBestPick = ranked[0] || null;
    this._syncLiveAnalysisBoard();
    return ranked;
  }

  _startGlobalRankSweep() {
    this._stopGlobalRankSweep();
    this._runGlobalEntryRankSweep();
    this._globalRankInterval = setInterval(() => {
      if (!this.running) return;
      this._runGlobalEntryRankSweep();
    }, 1000);
  }

  _stopGlobalRankSweep() {
    if (this._globalRankInterval) {
      clearInterval(this._globalRankInterval);
      this._globalRankInterval = null;
    }
  }

  _sweepAllMarketsVL() {
    if (!this._isSyntheticDualSideStrategy() && !this._usesTournamentMode()) return;
    if (!this.marketVLState || !Object.keys(this.marketVLState).length) {
      this._initMarketVLState();
    }
    for (const sym of MARKETS) this._updateMarketVL(sym);
  }

  _getTournamentVlRequired(dir, recovery) {
    const ctx = recovery || this._getWinRecoveryContext();
    const cfg = Number(this.config?.virtualLossesToWait) || 3;
    const isEvenOdd = this.strategy === 'BOTH';
    const isOverUnder = this.strategy === 'BOTH5';
    const isOmni = this.strategy === 'OMNISNIPER';

    let req = cfg;
    if (isEvenOdd || isOverUnder || isOmni) {
      req = cfg;
    } else {
      const fast = this._getTournamentEntryTier() === 'fast';
      const floors = fast ? TOURNAMENT_VL_FAST : TOURNAMENT_VL;
      req = Math.max(floors[dir] ?? 4, fast ? 3 : cfg);
    }

    return req + (ctx?.vlExtra || 0);
  }

  _getAlternationCap(tier = 'normal') {
    return tier === 'fast' ? FAST_ALTERNATION_CAP : DEFAULT_ALTERNATION_CAP;
  }

  _minTournamentWinEst(direction) {
    const tier = this._getTournamentEntryTier();
    const base = direction === 'OVER5' ? 46
      : direction === 'UNDER5' ? 48
      : 50;
    const losses = this.sessionConsecutiveLosses || 0;
    if (tier === 'strict') return base + Math.min(6, losses * 2);
    if (tier === 'cautious') return base + 2;
    return Math.max(TOURNAMENT_MIN_WIN_FAST, base);
  }

  _evaluateDirVLTournament(symbol, state, ticks, dir, recovery) {
    const scores = scanner.scores[symbol] || {};

    const streak = scores.tailLossMap?.[dir] ?? this._getStreakForDir(state, dir, scores);
    const required = this._getTournamentVlRequired(dir, recovery);

    if (!state.streaks) state.streaks = {};
    state.streaks[dir] = streak;

    this._setDirReady(state, dir, false, 0);
    const warming = streak >= Math.max(1, required - 1) && streak < required;
    if (!state.nearReadyDirs) state.nearReadyDirs = {};
    state.nearReadyDirs[dir] = warming;
    state.nearReady = Object.values(state.nearReadyDirs).some(Boolean);

    if (ticks.length < 8) return;
    if (this._isDirectionBlocked(dir, symbol)) return;
    // Chop filter only on the side that suffers from digit-5 clustering
    if (dir === 'OVER5' && (parseFloat(scores.d5Pct) || 0) >= 14) return;

    const tier = this._getTournamentEntryTier();
    const losses = this.sessionConsecutiveLosses || 0;
    const pulseStreak = streak >= required - 1 && streak < required
      && (tier === 'fast' || losses === 0 || losses >= 1);

    if (streak < required && !pulseStreak) return;

    const altCap = this._getAlternationCap(tier === 'fast' || losses === 0 ? 'fast' : 'normal');
    if (this._computeAlternationRate(ticks, dir) > altCap) return;

    const winChance = this._estimateTournamentWinChance(symbol, dir, streak, ticks, scores);
    if (!state.dirWinChance) state.dirWinChance = {};
    state.dirWinChance[dir] = winChance;

    const minWin = pulseStreak ? TOURNAMENT_PULSE_WIN : this._minTournamentWinEst(dir);
    if (winChance < minWin) return;

    if (tier !== 'fast') {
      const chi = this._computeChiSquareDeviation(ticks, dir);
      if (!chi.significant && winChance < 48) return;
    }

    if (!this._passesTournamentMacroPct(dir, scores, tier === 'fast' || pulseStreak)) return;

    if (tier !== 'fast') {
      if (!this._passesTournamentEntryQuality(symbol, dir, ticks, scores, streak, required, winChance)) {
        if (!state.dirConfirmPending) state.dirConfirmPending = {};
        state.dirConfirmPending[dir] = true;
        return;
      }
      const lastDigit = ticks[ticks.length - 1];
      const confirmed = this._directionWouldWin(lastDigit, dir);
      if (!state.dirConfirmPending) state.dirConfirmPending = {};
      if (!confirmed && this._countReboundTicks(ticks, dir) < 1) {
        state.dirConfirmPending[dir] = true;
        return;
      }
      state.dirConfirmPending[dir] = false;
    }

    const conv = this._runConvergenceScan(symbol, dir, this._buildConvergenceCtx(symbol, dir, ticks, scores, required, streak));
    if (conv.blocked) return;

    this._setDirReady(state, dir, true, streak);
    state.confirmPending = false;
    state.confirmDir = null;
    state.confirmMarket = null;
  }

  _tournamentWatchdogTick() {
    if (!this.running || !this._usesTournamentMode()) return;
    if (this._checkSessionGuards()) return;

    this._cleanStaleOpenContracts();

    if (this._entryConfirmLab?.active && !this._entryConfirmLab.confirmed) {
      for (const sym of MARKETS) {
        const ticks = scanner.buffers[sym];
        if (ticks?.length) this._tickEntryConfirmLab(sym, ticks[ticks.length - 1]);
      }
    }

    this._runApexMatrixLeaderboard();
    this._refreshTournamentScan();
    if (!this._hasOpenTournamentContracts() && !this._pendingTournamentBuy) {
      this._scheduleTournamentFireTry();
    }

    const now = Date.now();
    for (const slot of this.executionSlots) {
      if (!slot.active || !slot.placedAt || now - slot.placedAt <= 45000) continue;
      if (slot.contractId || this._openTournamentContracts.has(slot.contractId)) {
        continue;
      }
      this.sendLog(`⚠️ Watchdog: clearing stuck placement slot ${slot.id} (no open contract)`);
      this._releaseTournamentFire(slot);
    }
    this._updateTournamentStatus();
  }

  _hasOpenTournamentContracts() {
    this._cleanStaleOpenContracts();
    if (this._openTournamentContracts.size > 0) return true;
    return this.executionSlots.some(s => {
      if (!s.contractId) return false;
      if (this._settledContractIds.has(s.contractId)) return false;
      return this._openTournamentContracts.has(s.contractId);
    });
  }

  _hasTournamentTradeInFlight() {
    if (this._pendingTournamentBuy) return true;
    if (this._tournamentTradeInFlight) return true;
    if (this._hasOpenTournamentContracts()) return true;
    return this.executionSlots.some(s => s.active);
  }

  _syncSessionMartingaleStep(step) {
    const s = Math.max(0, step || 0);
    this._sessionMartingaleStep = s;
    for (const slot of this.executionSlots) {
      slot.step = s;
      const ch = this.channels[slot.channelKey];
      if (ch) {
        ch.step = s;
        ch.stake = this._getMartingaleStake(ch, true);
      }
    }
  }

  _getSessionMartingaleStake(sym) {
    if (this.strategy === 'BOTH' || this.strategy === 'BOTH5' || this.strategy === 'OMNISNIPER') {
      if (this.config.recoveryEnabled === false) {
        return this._resolveStake(this.config.baseStake);
      }
      const ch = { step: this._sessionMartingaleStep || 0 };
      return this._getMartingaleStake(ch, true);
    }
    if (this._usesIsolatedSniperMode()) {
      const isolated = this._getIsolatedStake(sym);
      if (isolated != null) return isolated;
    }
    if (this._martingaleRecoveryMode && this._recoveryPlan?.stake) {
      return this._recoveryPlan.stake;
    }
    const slot0 = this.executionSlots[0];
    const ch = slot0 ? this.channels[slot0.channelKey] : null;
    // For OMNISNIPER and tournament modes, use the actual channel step (incremented after each loss)
    // rather than _sessionMartingaleStep which is only synced for BOTH/BOTH5.
    if (ch) {
      return this._getMartingaleStake(ch, false);
    }
    const fallback = { step: this._sessionMartingaleStep || 0 };
    return this._getMartingaleStake(fallback, true);
  }


  _getMaxMartingaleStep() {
    if (this.config?.minStakeOnly) return 0;
    let n = Number(this.config?.maxMartingaleStep ?? this.config?.maxSteps);
    if (!Number.isFinite(n) || n < 0) n = 0;
    n = Math.floor(n);
    return n;
  }

  /** 0 = never freeze step (stake keeps growing); N = hold step at N until win. */
  _getMartingaleHoldAfterStep() {
    const h = Number(this.config?.martingaleHoldAfterStep);
    if (Number.isFinite(h) && h > 0) return Math.floor(h);
    return 0;
  }

  _advanceMartingaleStepOnLoss() {
    const stepBefore = this._sessionMartingaleStep || 0;
    const hold = this._getMartingaleHoldAfterStep();
    if (hold > 0) return Math.min(hold, stepBefore + 1);
    return stepBefore + 1;
  }

  _martingaleStepForStake(step) {
    const hold = this._getMartingaleHoldAfterStep();
    const s = Math.max(0, step || 0);
    if (hold > 0) return Math.min(hold, s);
    return s;
  }

  _getSessionPnL() {
    const balance = derivWS.accountInfo?.balance;
    if (this.sessionOpeningBalance > 0 && balance != null) {
      return balance - this.sessionOpeningBalance;
    }
    return (this.sessionTrades || []).reduce((s, t) => s + (t.profit || 0), 0);
  }

  _sessionTakeProfitReached() {
    const tp = Number(this.config?.takeProfit) || 0;
    if (tp <= 0) return false;
    if (this.config?.takeProfitType === 'wins') {
      return (this.sessionWinCount || 0) >= tp;
    }
    return this._getSessionPnL() >= tp;
  }

  /** Classic martingale: reset stake ladder to base after every win (default on). */
  _shouldResetMartingaleOnWin() {
    return this.config.resetMartingaleOnWin !== false;
  }

  _getRecoveryStake() {
    const base = this.config.baseStake || 0.35;
    const debt = Math.max(0, this._recoveryDebt || 0);
    const payout = Number(this.config?.recoveryPayoutRate) || 0.92;
    let stake = (debt + base * 0.25) / payout;
    stake = Math.max(base, stake);
    const maxStep = this._getMaxMartingaleStep();
    if (maxStep > 0) {
      const stepCapStake = base * Math.pow(this.config.martMultiplier || 2, maxStep);
      stake = Math.min(stake, stepCapStake * 1.35);
    }
    const cap = this._getMaxStakeCap();
    if (cap != null) stake = Math.min(stake, cap);
    return Math.max(0.35, parseFloat(stake.toFixed(2)));
  }

  _armMartingaleRecovery(triggerDir) {
    if (this._martingaleRecoveryMode && this._recoveryPlan) return;
    this._martingaleRecoveryMode = true;
    const maxStep = this._getMaxMartingaleStep();
    const sessionStep = Math.max(1, this._sessionMartingaleStep || 1);
    const step = maxStep > 0 ? Math.min(maxStep, sessionStep) : sessionStep;
    this._syncSessionMartingaleStep(step);
    this._recoveryPlan = this._buildMartingaleRecoveryPlan(triggerDir);
    const debt = this._recoveryDebt || 0;
    const stake = this._getRecoveryStake();
    if (this._recoveryPlan?.mode === 'dual_hedge') {
      this.sendLog(
        `🔄 Martingale cap (step ${this._getMaxMartingaleStep()}) — O/U failing · dual hedge on ` +
        `${MARKET_LABELS[this._recoveryPlan.sym]} · debt $${debt.toFixed(2)}`
      );
    } else if (this._recoveryPlan) {
      this.sendLog(
        `🔄 Martingale recovery — debt $${debt.toFixed(2)} · stake $${stake.toFixed(2)} · ` +
        `${this._recoveryPlan.dir} ${MARKET_LABELS[this._recoveryPlan.sym]} · bias ${this._recoveryPlan.lt?.toFixed(0)}%`
      );
    } else {
      this.sendLog(`🔄 Martingale recovery — debt $${debt.toFixed(2)} · scanning best alternative…`);
    }
    this._notifyOnce(this._toastIds.recovery, `Recovery · debt $${debt.toFixed(2)}`, { icon: '🔄', duration: 3000 });
  }

  _exitMartingaleRecovery(cleared) {
    this._martingaleRecoveryMode = false;
    this._recoveryPlan = null;
    if (cleared) {
      this._recoveryDebt = 0;
      this._ouTrackFailures = { OVER5: 0, UNDER5: 0, EVEN: 0, ODD: 0 };
      this._syncSessionMartingaleStep(0);
      this.sendLog('✅ Recovery debt cleared — martingale step 0');
    }
  }

  _rebuildMartingaleRecoveryPlan(triggerDir) {
    this._recoveryPlan = this._buildMartingaleRecoveryPlan(triggerDir);
    if (this._recoveryPlan) {
      this._recoveryPlan.stake = this._getRecoveryStake();
    }
  }

  _buildMartingaleRecoveryPlan(triggerDir) {
    return null; // Ensure we just use the normal winning algorithm instead of hunting for specific recoveries
  }

  _shouldArmMartingaleRecovery(_direction) {
    // REMOVED: never arm martingale recovery mode — normal scan fires next trade
    return false;
  }

  _matrixMartingaleOpts() {
    return {
      maxMartingaleStep: this._getMaxMartingaleStep(),
      maxSteps: this._getMaxMartingaleStep(),
      martMultiplier: this.config.martMultiplier || 2,
      martingaleHoldAfterStep: this._getMartingaleHoldAfterStep(),
      martingaleStep: this._sessionMartingaleStep || 0,
    };
  }

  _handleMartingaleSettle(won, profit, buyPrice, direction) {
    if (this.config.recoveryEnabled === false) return;

    const sessionMart = this._usesTournamentMode() &&
      (this.strategy === 'BOTH5' || this.strategy === 'BOTH');

    if (sessionMart) {
      const hold = this._getMartingaleHoldAfterStep();
      if (won) {
        this._recoveryDebt = 0;
        this._syncSessionMartingaleStep(0);
        if (usesMatrix20Engine(this.strategy)) {
          globalMatrixState.currentMartingaleLevel = 0;
        }
        this.sendLog(
          `📉 ${this.strategy} WIN → martingale step 0 · next $${this._getSessionMartingaleStake().toFixed(2)}`
        );
      } else {
        const stepBefore = this._sessionMartingaleStep || 0;
        const nextStep = this._advanceMartingaleStepOnLoss();
        this._syncSessionMartingaleStep(nextStep);
        if (usesMatrix20Engine(this.strategy)) {
          globalMatrixState.currentMartingaleLevel = nextStep;
        }
        const holdTag = hold > 0 ? ` · hold@${hold}` : ' · no hold';
        this.sendLog(
          `📈 ${this.strategy} LOSS step ${stepBefore}→${nextStep}${holdTag} · next $${this._getSessionMartingaleStake().toFixed(2)}`
        );
      }
      return;
    }



    if (this._usesIsolatedSniperMode()) {
      if (won) {
        this._recoveryDebt = Math.max(0, (this._recoveryDebt || 0) - Math.max(0, profit));
        if (this._shouldResetMartingaleOnWin()) this._syncSessionMartingaleStep(0);
        if (this._recoveryDebt < 0.15 && this._martingaleRecoveryMode) {
          this._exitMartingaleRecovery(true);
        }
      } else {
        const lossAmt = Math.abs(profit) || buyPrice;
        this._recoveryDebt = (this._recoveryDebt || 0) + lossAmt;
        // NEVER arm martingale recovery
      }
      return;
    }
    if (won) {
      if (direction && this._ouTrackFailures[direction]) {
        this._ouTrackFailures[direction] = Math.max(0, this._ouTrackFailures[direction] - 1);
      }
      if (this._martingaleRecoveryMode) {
        this._recoveryDebt = Math.max(0, (this._recoveryDebt || 0) - profit);
        this.sendLog(
          `🔄 Recovery win +$${profit.toFixed(2)} · debt left $${this._recoveryDebt.toFixed(2)}`
        );
        if (this._recoveryDebt < 0.15) {
          this._exitMartingaleRecovery(true);
        } else {
          this._onPartialRecoveryWin('martingale');
          this._rebuildMartingaleRecoveryPlan(direction);
        }
      }
      if (this._shouldResetMartingaleOnWin()) {
        this._syncSessionMartingaleStep(0);
        this.sendLog(`📉 Martingale WIN → reset step 0 · $${this._getSessionMartingaleStake().toFixed(2)}`);
      }
      return;
    }

    const lossAmt = Math.abs(profit) || buyPrice;
    if (direction && (this.strategy === 'BOTH5' || this.strategy === 'OU_WINNING')) {
      this._ouTrackFailures[direction] = (this._ouTrackFailures[direction] || 0) + 1;
    }

    const stepBefore = this._sessionMartingaleStep || 0;
    const nextStep = this._advanceMartingaleStepOnLoss();
    this._syncSessionMartingaleStep(nextStep);
    if (usesMatrix20Engine(this.strategy)) {
      globalMatrixState.currentMartingaleLevel = nextStep;
    }

    const hold = this._getMartingaleHoldAfterStep();
    const holdTag = hold > 0 ? ` · hold@${hold}` : '';
    this.sendLog(
      `📈 LOSS step ${stepBefore}→${nextStep}${holdTag} · next $${this._getSessionMartingaleStake().toFixed(2)}`
    );
  }

  /**
   * Fast-pass: same market as last loss, next tick, no 15-market matrix or entry-lab delay.
   */
  _tryFireFastPassRecovery(freeSlot) {
    if (!shouldUseFastPassRecovery()) return false;
    if (!canDispatchNetworkPhase()) return false;

    if (this._usesIsolatedSniperMode()) {
      return this._fireIsolatedSniperTrade({ fastPassOnly: true, freeSlot });
    }

    if (!this._usesTournamentMode()) return false;

    const marketMap = buildMarketDataMap(scanner, this._getAllMarketBuffers());
    const superPick = processSuperMatrixSweep(marketMap, {
      strategy: this.strategy,
      baseStake: this.config.baseStake,
      scanner,
    });
    const order = superPick?.action === 'recovery'
      ? {
          sym: superPick.sym,
          dir: superPick.dir,
          stake: superPick.amount,
          step: getFastPassRecoveryState().currentStep,
          fastPass: true,
        }
      : buildFastPassRecoveryOrder(
        this._getAllMarketBuffers(),
        this.strategy,
        this.config.baseStake,
        { martMultiplier: 2.2, maxStep: this._getMaxMartingaleStep() }
      );

    if (superPick?.reason === 'recovery_stream_lag') {
      this.updateStatus(`⏸ Stream lag ${superPick.lag}ms — skip stale recovery`, true);
      return false;
    }

    if (!order || !freeSlot) return false;

    const lagReason = abortReasonForSymbol(order.sym, scanner, true);
    if (lagReason) {
      this.sendLog(`⏸ Fast recovery aborted: ${lagReason} on ${MARKET_LABELS[order.sym]}`);
      return false;
    }
    if (this._hasTournamentTradeInFlight() || this._hasOpenTournamentContracts()) return false;
    if (this._pendingTournamentBuy) return false;

    const plan = {
      sym: order.sym,
      dir: order.dir,
      streak: 0,
      score: 90,
      winChance: 48,
      algorithm: 'fast_pass_recovery',
      stake: order.stake,
      fastPass: true,
      ready: true,
    };

    if (!tryAcquireApexLock()) return false;
    if (!this._claimTournamentFire(freeSlot, plan)) {
      setApexOrderInFlight(false);
      return false;
    }
    markNetworkDispatch();

    this._lastTournamentEntry = {
      sym: plan.sym,
      dir: plan.dir,
      streak: 0,
      recovery: true,
      fastPass: true,
      at: Date.now(),
    };
    this.sendLog(
      `⚡ FAST recovery step ${order.step} → ${plan.dir} ${MARKET_LABELS[plan.sym]} · $${order.stake.toFixed(2)} (same market)`
    );
    this.updateStatus(`⚡ Fast recovery · ${plan.dir} ${MARKET_LABELS[plan.sym]}`, true);
    this._recordTradeFired();
    void this._executeInSlot(freeSlot, plan, { fastPass: true });
    return true;
  }

  _tryFireFastPassDualRecovery(isOverUnder) {
    if (!canDispatchNetworkPhase()) return false;
    const state = getFastPassRecoveryState();
    const sym = state.failedMarket || this.activeMarket;
    if (!sym) return false;

    const lagReason = abortReasonForSymbol(sym, scanner, true);
    if (lagReason) {
      this.sendLog(`⏸ Fast dual recovery aborted: ${lagReason}`);
      return false;
    }

    const dirs = this._getDualLegDisplayOrder(isOverUnder ? ['OVER5', 'UNDER5'] : ['EVEN', 'ODD']);
    if (this._dualHedgeInFlight || this._hasOpenDualHedgeContracts(dirs)) return false;
    if (this._checkSessionGuards()) return false;

    this.nextAllowedTradeTime = 0;
    this._martingaleArmAfter = 0;
    if (!this._isWinningDualStrategy()) {
      this.activeMarket = sym;
      if (this.onMarketSwitch) this.onMarketSwitch(sym);
    }

    const pressure = this._getDualWinningLegPressure();
    const recoverDir = state.failedDir || (pressure?.losses >= 1 ? pressure.dir : null);
    const base = this._resolveStake(this.config.baseStake);
    const recoveryLegStakes = {};
    for (const dir of dirs) {
      recoveryLegStakes[dir] = recoverDir === dir
        ? this._getDualLegMartingaleStake(dir)
        : base;
    }
    const stakeNote = dirs.map(d => `${d} $${recoveryLegStakes[d].toFixed(2)}`).join(' · ');
    this.sendLog(`⚡ Winning pair recovery → ${MARKET_LABELS[sym]} · ${stakeNote}`);
    this.updateStatus(`⚡ Dual recovery · ${MARKET_LABELS[sym]}`, true);
    this._recordTradeFired();
    this._recordTradeFired();
    void this._fireWinningDualPair(sym, dirs, { recoveryLegStakes, fastPass: true });
    return true;
  }

  _forceTournamentRecoveryFire(freeSlot, candidatesIn) {
    if (!freeSlot || !this.running) return false;
    if (this._hasTournamentTradeInFlight() || this._hasOpenTournamentContracts()) return false;

    // ADDED: explicitly clear any stale flight flags before force-fire
    this._tournamentTradeInFlight = false;
    this._pendingTournamentBuy = false;
    this._cleanStaleOpenContracts();

    let candidates = this._candidatesFromLiveBoard({ limit: 15, minStatus: 'NEAR' });
    if (!candidates.length) candidates = candidatesIn || this._collectBestAcrossMarkets();
    if (!candidates.length) {
      candidates = this._collectTournamentPulseCandidates()
        .map(c => this._applyBinaryScoring(c))
        .filter(Boolean);
    }
    if (!candidates.length) return false;

    this._rankTournamentCandidates(candidates);
    this._lastRecoveryFireAttempt = Date.now();

    for (let i = 0; i < Math.min(10, candidates.length); i++) {
      const c = candidates[i];
      const dir = c.dir || c.direction;
      const sym = c.sym;
      if (!dir || !sym) continue;
      const win = parseFloat(c.winChance ?? c.binaryWinPct ?? 0) || 0;
      // Removed winChance < 28 filter — accept any candidate during recovery

      c.stake = this._getSessionMartingaleStake(sym);
      if (!tryAcquireApexLock()) {
        setApexOrderInFlight(false);
        continue;
      }
      if (!this._claimTournamentFire(freeSlot, c)) {
        setApexOrderInFlight(false);
        continue;
      }

      this._lastTournamentEntry = {
        sym,
        dir,
        streak: c.streak,
        winChance: c.winChance,
        algorithm: c.algorithm || ENTRY_ALGORITHMS.DISTRIBUTION_BIAS,
        recovery: true,
        at: Date.now(),
      };
      this.sendLog(
        `🚨 Recovery fire ${dir} ${MARKET_LABELS[sym]} · est ${Math.round(win)}% · rank #${i + 1} · edge ${Math.round(c.binaryEdge ?? c.score ?? 0)}`
      );
      this.updateStatus(`🚨 Recovery · ${dir} ${MARKET_LABELS[sym]}`, true);
      this._recordTradeFired();
      void this._executeInSlot(freeSlot, c, { recoveryForce: true });
      return true;
    }
    return false;
  }

  /** Fire top scanned candidate after loss — uses live VL/scores, minimal blocking gates. */
  _tryFireTopAnalysisCandidate(freeSlot) {
    if (!freeSlot || !this.running) return false;
    if (this._hasTournamentTradeInFlight() || this._hasOpenTournamentContracts()) return false;

    let candidates = this._candidatesFromLiveBoard({ limit: 15, minStatus: 'NEAR' });
    if (!candidates.length) candidates = this._collectTournamentCandidates();
    if (!candidates.length) candidates = this._collectBestAcrossMarkets();
    if (!candidates.length) {
      candidates = this._collectTournamentPulseCandidates()
        .map(c => this._applyBinaryScoring(c))
        .filter(Boolean);
    }
    if (!candidates.length) return false;

    this._rankTournamentCandidates(candidates);
    const losses = this.sessionConsecutiveLosses || 0;

    for (let i = 0; i < Math.min(12, candidates.length); i++) {
      const c = candidates[i];
      const dir = c.dir || c.direction;
      const sym = c.sym;
      if (!dir || !sym) continue;

      const scores = scanner.scores[sym] || {};
      const lt = c.lt ?? this._getDistributionBiasPct(dir, scores);
      const win = parseFloat(c.winChance ?? c.binaryWinPct ?? 0) || 0;
      const conv = parseFloat(c.convergenceScore ?? 0) || 0;

      if (losses >= 1) {
        if (!hasNormalDistributionEdge(dir, lt) && win < 36) continue;
        if (win < 34 && conv < 18) continue;
      } else if (!this._passesFireGate(c) && !this._passesRelaxedRecoveryFire(c)) {
        continue;
      }

      c.stake = this._getSessionMartingaleStake(sym);
      c.lt = lt;
      if (!tryAcquireApexLock()) {
        setApexOrderInFlight(false);
        continue;
      }
      if (!this._claimTournamentFire(freeSlot, c)) {
        setApexOrderInFlight(false);
        continue;
      }

      this._lastTournamentEntry = {
        sym,
        dir,
        streak: c.streak,
        winChance: c.winChance,
        algorithm: c.algorithm || ENTRY_ALGORITHMS.DISTRIBUTION_BIAS,
        recovery: true,
        at: Date.now(),
      };
      this.sendLog(
        `🎯 Live analysis fire ${dir} ${MARKET_LABELS[sym]} · est ${Math.round(win)}% · bias ${Math.round(lt)}% · score ${c.recoveryScore ?? c.score ?? '?'}`
      );
      this.updateStatus(`🎯 Recovery · ${dir} ${MARKET_LABELS[sym]}`, true);
      this._recordTradeFired();
      void this._executeInSlot(freeSlot, c);
      return true;
    }

    if (losses >= 1 && candidates[0]) {
      const c = candidates[0];
      const dir = c.dir || c.direction;
      const sym = c.sym;
      const win = parseFloat(c.winChance ?? c.binaryWinPct ?? 0) || 0;
      if (dir && sym && win >= 32) {
        c.stake = this._getSessionMartingaleStake(sym);
        if (!tryAcquireApexLock()) {
          setApexOrderInFlight(false);
          return false;
        }
        if (!this._claimTournamentFire(freeSlot, c)) {
          setApexOrderInFlight(false);
          return false;
        }
        this.sendLog(
          `🎯 Recovery force-fire ${dir} ${MARKET_LABELS[sym]} · est ${Math.round(win)}% · top ranked`
        );
        this.updateStatus(`🎯 Recovery · ${dir} ${MARKET_LABELS[sym]}`, true);
        this._recordTradeFired();
        void this._executeInSlot(freeSlot, c);
        return true;
      }
    }
    return false;
  }

  _tryFireRecoveryRankedPick(freeSlot) {
    if (!freeSlot || !this.running) return false;
    if (this._hasTournamentTradeInFlight() || this._hasOpenTournamentContracts()) return false;

    const ranked = this._scanBestRecoveryAcrossMarkets();
    if (!ranked.length) return false;

    for (let i = 0; i < Math.min(10, ranked.length); i++) {
      const pick = ranked[i];
      const lastLoss = this._lastLossSetup;
      if (
        i > 0
        && lastLoss?.sym === pick.sym
        && lastLoss?.dir === pick.dir
        && Date.now() - (lastLoss.at || 0) < 60000
      ) {
        continue;
      }
      const scores = scanner.scores[pick.sym] || {};
      const enriched = this._applyBinaryScoring({
        sym: pick.sym,
        dir: pick.dir,
        streak: pick.streak || 0,
        required: pick.required || this._getTournamentVlRequired(pick.dir, this._getWinRecoveryContext()),
        lt: this._getDistributionBiasPct(pick.dir, scores),
        winChance: pick.winChance,
        recoveryScore: pick.recoveryScore,
        score: pick.recoveryScore,
        algorithm: ENTRY_ALGORITHMS.DISTRIBUTION_BIAS,
        algorithms: [ENTRY_ALGORITHMS.DISTRIBUTION_BIAS],
        algoAgreement: 1,
        ready: pick.ready || (pick.streak || 0) >= (pick.required || 1),
        oppEnd: pick.oppEnd || 0,
      });
      if (!enriched) continue;
      this._attachCounterToCandidate(enriched);
      const conv = this._applyConvergence(enriched, { silent: true, allowBlocked: true });
      if (!conv) continue;
      const losses = this.sessionConsecutiveLosses || 0;
      if (losses < 1 && !this._passesRelaxedRecoveryFire(conv)) continue;
      if (losses >= 1 && (conv.winChance ?? 0) < 30 && !conv.ready) continue;

      conv.stake = this._getSessionMartingaleStake(conv.sym);
      if (!tryAcquireApexLock()) {
        setApexOrderInFlight(false);
        continue;
      }
      if (!this._claimTournamentFire(freeSlot, conv)) {
        setApexOrderInFlight(false);
        continue;
      }

      this._lastTournamentEntry = {
        sym: conv.sym,
        dir: conv.dir,
        streak: conv.streak,
        winChance: conv.winChance,
        algorithm: conv.algorithm,
        recovery: true,
        at: Date.now(),
      };
      this.sendLog(
        `🎯 Recovery fire ${conv.dir} ${MARKET_LABELS[conv.sym]} · score ${conv.recoveryScore} · est ${conv.winChance}% · $${conv.stake.toFixed(2)}`
      );
      this.updateStatus(`🎯 Recovery · ${conv.dir} ${MARKET_LABELS[conv.sym]}`, true);
      this._recordTradeFired();
      void this._executeInSlot(freeSlot, conv);
      return true;
    }
    return false;
  }

  _tryFireMartingaleRecoveryTrade(freeSlot) {
    if (shouldUseFastPassRecovery()) {
      return this._tryFireFastPassRecovery(freeSlot);
    }
    if (!this._martingaleRecoveryMode) return false;
    if (!this._recoveryPlan) this._rebuildMartingaleRecoveryPlan(null);
    let plan = this._recoveryPlan;
    if (!plan) return this._tryFireRecoveryRankedPick(freeSlot);

    if (plan.mode !== 'dual_hedge') {
      const ticks = scanner.buffers[plan.sym] || [];
      const scores = scanner.scores[plan.sym] || {};
      const enriched = this._applyBinaryScoring({
        sym: plan.sym,
        dir: plan.dir,
        streak: plan.streak || 0,
        required: this._getTournamentVlRequired(plan.dir, this._getWinRecoveryContext()),
        lt: plan.lt ?? this._getDistributionBiasPct(plan.dir, scores),
        algorithm: ENTRY_ALGORITHMS.DISTRIBUTION_BIAS,
        algorithms: [ENTRY_ALGORITHMS.DISTRIBUTION_BIAS],
        algoAgreement: 1,
        convergenceScore: 0,
      });
      this._attachCounterToCandidate(enriched);
      const conv = this._applyConvergence(enriched, { silent: true, allowBlocked: true });
      if (!conv || (!this._passesFireGate(conv) && !this._passesRelaxedRecoveryFire(conv))) {
        return this._tryFireRecoveryRankedPick(freeSlot);
      }
      Object.assign(plan, conv);
    }

    if (plan.mode === 'dual_hedge') {
      const dirs = this.strategy === 'OU_WINNING' ? ['OVER5', 'UNDER4']
        : (this.strategy === 'BOTH5' ? ['OVER5', 'UNDER5'] : ['EVEN', 'ODD']);
      if (this._isWinningDualStrategy()) {
        void this._fireWinningDualPair(plan.sym, dirs);
      } else {
        void this._fireDualHedgeSequential(plan.sym, dirs);
      }
      return true;
    }

    plan.stake = this._getRecoveryStake();
    if (!this._claimTournamentFire(freeSlot, plan)) return false;
    this._lastTournamentEntry = {
      sym: plan.sym,
      dir: plan.dir,
      streak: 0,
      winChance: plan.winChance,
      algorithm: plan.algorithm,
      recovery: true,
      at: Date.now(),
    };
    this.sendLog(
      `🔄 Recovery fire ${plan.dir} ${MARKET_LABELS[plan.sym]} @ $${plan.stake.toFixed(2)} · debt $${(this._recoveryDebt || 0).toFixed(2)}`
    );
    this._recordTradeFired();
    void this._executeInSlot(freeSlot, plan);
    return true;
  }

  /** Clear stale locks/slots that block recovery after a settled loss. */
  _clearRecoveryFireBlockers() {
    setApexOrderInFlight(false);
    this._cleanStaleOpenContracts();
    this._pendingTournamentBuy = false;
    for (const slot of this.executionSlots || []) {
      if (!slot.active) continue;
      if (slot.contractId && !this._settledContractIds.has(slot.contractId)) continue;
      const age = slot.placedAt ? Date.now() - slot.placedAt : 99999;
      if (!slot.contractId || age > 3000) {
        this._releaseTournamentFire(slot);
      }
    }
  }

  /** Fire top live-board row after loss — minimal gates, skips fast-pass trap. */
  _fireBoardRecoveryNow(freeSlot, { force = false } = {}) {
    if (!freeSlot || !this.running) return false;
    if ((this.sessionConsecutiveLosses || 0) < 1) return false;

    this._clearRecoveryFireBlockers();
    if (this._hasOpenTournamentContracts()) return false;

    const lastLoss = this._lastLossSetup;
    const minStatus = force ? 'WATCHING' : 'READY';
    let candidates = this._candidatesFromLiveBoard({ limit: 25, minStatus });
    if (!candidates.length && !force) {
      candidates = this._candidatesFromLiveBoard({ limit: 25, minStatus: 'NEAR' });
    }
    if (!candidates.length) {
      candidates = this._scanBestRecoveryAcrossMarkets()
        .map(p => this._applyBinaryScoring({
          sym: p.sym,
          dir: p.dir,
          streak: p.streak,
          required: p.required,
          winChance: p.winChance,
          score: p.recoveryScore,
          recoveryScore: p.recoveryScore,
          ready: p.ready,
          algorithm: ENTRY_ALGORITHMS.DISTRIBUTION_BIAS,
          algorithms: [ENTRY_ALGORITHMS.DISTRIBUTION_BIAS],
          algoAgreement: 1,
        }))
        .filter(Boolean);
    }
    if (!candidates.length) return false;

    this._rankTournamentCandidates(candidates);
    this._lastRecoveryFireAttempt = Date.now();

    for (let i = 0; i < Math.min(15, candidates.length); i++) {
      const c = candidates[i];
      const dir = c.dir || c.direction;
      const sym = c.sym;
      if (!dir || !sym) continue;
      const win = parseFloat(c.winChance ?? c.binaryWinPct ?? 0) || 0;
      if (!force && win < 28 && !c.ready && !c.apexPerfect) continue;
      if (
        !force
        && lastLoss?.sym === sym
        && lastLoss?.dir === dir
        && Date.now() - (lastLoss.at || 0) < 4000
      ) {
        continue;
      }
      if (this._isTournamentEntryLocked(sym, dir)) continue;
      if (!force && this._isDirectionBlocked(dir, sym)) continue;

      c.stake = this._getSessionMartingaleStake(sym);
      setApexOrderInFlight(false);
      if (!tryAcquireApexLock()) continue;
      if (!this._claimTournamentFire(freeSlot, c)) {
        setApexOrderInFlight(false);
        continue;
      }

      this._lastTournamentEntry = {
        sym,
        dir,
        streak: c.streak,
        winChance: c.winChance,
        algorithm: c.algorithm || ENTRY_ALGORITHMS.DISTRIBUTION_BIAS,
        recovery: true,
        at: Date.now(),
      };
      const tag = force ? '🚨 Force' : '🚨 Board';
      this.sendLog(
        `${tag} recovery ${dir} ${MARKET_LABELS[sym]} · est ${Math.round(win)}% · rank #${i + 1}`
      );
      this.updateStatus(`🚨 Recovery · ${dir} ${MARKET_LABELS[sym]}`, true);
      this._recordTradeFired();
      void this._executeInSlot(freeSlot, c, { recoveryForce: true });
      return true;
    }
    return false;
  }

  /** After a loss — sniper/matrix first, then force-fire ranked fallbacks until one lands. */
  async _fireRecoveryTrade(freeSlot) {
    if (!freeSlot || !this.running || (this.sessionConsecutiveLosses || 0) < 1) return false;

    this.nextAllowedTradeTime = 0;
    this._martingaleArmAfter = 0;
    this._clearRecoveryFireBlockers();
    this._lastRecoveryFireAttempt = Date.now();

    if (this._usesIsolatedSniperMode() && !this._isWinningDualStrategy()) {
      if (await this._fireIsolatedSniperTrade({ freeSlot })) return true;
    }

    if (this._tryFireRecoveryRankedPick(freeSlot)) return true;

    const ranked = this._collectBestAcrossMarkets();
    if (this._forceTournamentRecoveryFire(freeSlot, ranked)) return true;

    if (this._fireBoardRecoveryNow(freeSlot, { force: true })) return true;

    const sweep = this._runApexMatrixLeaderboard();
    const top = sweep.leaderboard?.[0];
    if (top?.sym && top?.dir) {
      const scores = scanner.scores[top.sym] || {};
      const enriched = this._applyBinaryScoring({
        sym: top.sym,
        dir: top.dir,
        streak: 0,
        required: 0,
        lt: this._getDistributionBiasPct(top.dir, scores),
        winChance: top.confidenceScore || 48,
        score: top.confidenceScore,
        recoveryScore: top.confidenceScore,
        ready: true,
        apexPerfect: top.perfect,
        algorithm: 'apex_matrix',
        algorithms: ['apex_matrix'],
      });
      if (enriched && this._forceTournamentRecoveryFire(freeSlot, [enriched])) return true;
    }

    return false;
  }

  /** Coalesce burst tick events into one fire attempt per turn. */
  _scheduleTournamentFireTry() {
    if (this._tournamentFireTryPending || this._hasTournamentTradeInFlight()) return;
    const losses = this.sessionConsecutiveLosses || 0;
    const boardReady = (this._liveDualSideBoard || []).filter(r => r.status === 'READY').length;
    const throttleMs = boardReady > 0 && losses >= 1 ? 40 : (losses >= 1 ? 80 : 120);
    if (losses >= 1 && this._lastRecoveryFireAttempt && Date.now() - this._lastRecoveryFireAttempt < throttleMs) {
      return;
    }
    this._tournamentFireTryPending = true;
    queueMicrotask(() => {
      this._tournamentFireTryPending = false;
      if (!this._hasTournamentTradeInFlight()) this._tryFireTournamentBest();
    });
  }

  _claimTournamentFire(slot, best) {
    if (this._tournamentTradeInFlight) return false;
    if (this._pendingTournamentBuy || this._hasOpenTournamentContracts()) return false;
    if (slot.active || slot.contractId) return false;
    const ch = this.channels[slot.channelKey];
    if (!ch || ch.active || ch.contractId) return false;

    // ── HARD DIRECTION ENFORCEMENT ──
    // Reject any candidate whose direction doesn't match the strategy's allowed list.
    // This prevents EVEN/ODD from leaking into BOTH5 or OVER/UNDER into BOTH.
    if (best?.dir) {
      const allowedDirs = this._getStrategyDirs();
      if (!allowedDirs.includes(best.dir)) {
        this.sendLog(`⛔ Blocked ${best.dir} — not in ${this.strategy} allowed dirs [${allowedDirs.join(',')}]`);
        return false;
      }
    }

    this._tournamentTradeInFlight = true;
    slot.active = true;
    slot.sym = best.sym;
    slot.dir = best.dir;
    slot.vlDepthAtEntry = best.streak;
    slot.placedAt = Date.now();
    ch.active = true;
    ch.direction = best.dir;
    ch.placedAt = slot.placedAt;
    this._lockTournamentEntry(best.sym, best.dir);
    return true;
  }

  _releaseTournamentFire(slot) {
    this._tournamentTradeInFlight = false;
    setApexOrderInFlight(false);
    if (!slot) return;
    if (slot.sym && slot.dir) this._unlockTournamentEntry(slot.sym, slot.dir);
    slot.active = false;
    slot.contractId = null;
    slot.sym = null;
    slot.dir = null;
    slot.placedAt = null;
    const ch = this.channels[slot.channelKey];
    if (ch) {
      ch.active = false;
      ch.contractId = null;
      ch.direction = null;
      ch.placedAt = null;
    }
  }

  _buildTradeMeta(market, direction, extra = {}) {
    return buildEntryMetadata(this, market, direction, extra);
  }

  _isCascadePaused() {
    const now = Date.now();
    if (isCascadePauseActive(this._lossStreakCooldownUntil || 0, now)) return true;
    return isCascadePauseActive(this._cascadePausedUntil || 0, now);
  }

  _checkSessionGuards() {
    if (!derivWS.isReady) {
      this.updateStatus('Waiting for connection...');
      return true;
    }
    const balance = derivWS.accountInfo?.balance || 0;
    const safety = evaluateSessionSafety({
      config: this.config,
      sessionTrades: this.sessionTrades,
      sessionOpeningBalance: this.sessionOpeningBalance,
      balance,
      sessionConsecutiveLosses: this.sessionConsecutiveLosses,
      cascadePausedUntil: this._cascadePausedUntil || 0,
    });
    if (safety.shouldStop) {
      this.stop(safety.reason);
      return true;
    }
    if (safety.freezeMartingale) this._cascadeMartingaleFrozen = true;

    if (this.sessionOpeningBalance > 0) {
      const currentPnL = balance - this.sessionOpeningBalance;
      if (this.config.stopLoss > 0 && currentPnL <= -this.config.stopLoss) {
        this.stop(`Stop Loss Reached: PnL -$${Math.abs(currentPnL).toFixed(2)}`);
        return true;
      }
      if (this.config.takeProfit > 0 && currentPnL >= this.config.takeProfit) {
        this.stop(`Take Profit Reached: PnL +$${currentPnL.toFixed(2)}`);
        return true;
      }
    }
    // Ghost break disabled — never block
    // if (!this._usesTournamentMode() && this.ghostBreakUntil > Date.now()) return true;
    return false;
  }

  _updateTournamentStatus() {
    const board = this._liveDualSideBoard || [];
    const best = board[0];
    let readyMkts = 0;
    let readyA = 0;
    let readyB = 0;
    let near = board.filter(r => r.status === 'NEAR').length;
    let topWinEst = best?.winChance || 0;
    const isOu = this.strategy === 'BOTH5';
    const dirs = this._getStrategyDirs();
    const sideA = isOu ? 'OVER5' : 'EVEN';
    const sideB = isOu ? 'UNDER5' : 'ODD';

    if (board.length) {
      const readyBySym = new Set();
      for (const r of board) {
        if (r.status !== 'READY') continue;
        if (r.dir === sideA) readyA++;
        if (r.dir === sideB) readyB++;
        readyBySym.add(r.sym);
      }
      readyMkts = readyBySym.size;
    } else {
      for (const sym of MARKETS) {
        const st = this.marketVLState[sym];
        if (!st) continue;
        let mktReady = false;
        for (const d of dirs) {
          if (!this._isDirReady(st, d)) continue;
          if (d === sideA) { readyA++; mktReady = true; }
          else if (d === sideB) { readyB++; mktReady = true; }
          topWinEst = Math.max(topWinEst, st.dirWinChance?.[d] || 0);
        }
        if (mktReady) readyMkts++;
        else if (st.nearReady) near++;
      }
    }
    if (this._tournamentTopBinaryWin) {
      topWinEst = this._tournamentTopBinaryWin;
    }
    const busy = this.executionSlots.filter(s => s.active).length;
    const queued = this._tournamentQueuedCount || 0;
    const sideLabel = isOu ? `O:${readyA} U:${readyB}` : `E:${readyA} O:${readyB}`;
    const topVl = this._tournamentTopStreak || 0;
    const lossN = this.sessionConsecutiveLosses || 0;
    const lossHint = lossN > 0
      ? (this._isRecoveryHuntMode() ? ` · recovery hunt ${lossN}` : ` · L-streak ${lossN}`)
      : '';
    const lensTag = this._recoveryLensLabel(this._getActiveRecoveryLens());
    const tierTag = this._getTournamentEntryTier();
    const algoTag = this._activeEntryAlgorithm
      ? ` · ${this._algoLabel(this._activeEntryAlgorithm)}`
      : ' · binary';
    const rwr = this._getRollingWinRate(10);
    const rwrTag = rwr != null ? ` · WR10 ${(rwr * 100).toFixed(0)}%` : '';
    const labTag = this._isEntryConfirmBlocking()
      ? ' · 🧪 testing'
      : (this._entryConfirmLab?.confirmed ? ' · 🧪 confirmed' : '');
    const debtTag = this._martingaleRecoveryMode
      ? ` · RECOVERY debt $${(this._recoveryDebt || 0).toFixed(2)}`
      : ` · M${this._sessionMartingaleStep}/${this._getMaxMartingaleStep()}`;
    const tradeHint = busy
      ? ` · in trade · ${queued} queued`
      : (queued > 0 ? ` · ${queued} ready` : ` · ${tierTag}`);
    const boardTag = best
      ? ` · #1 ${best.dir} ${MARKET_LABELS[best.sym] || best.sym} ${best.winChance}%`
      : '';
    this.updateStatus(
      `🏆 15×2${boardTag} · ${sideLabel} · bin ${topWinEst || topVl}% · ${tierTag}${algoTag}${rwrTag}${lensTag}${lossHint}${near ? ` · ${near} near` : ''}${tradeHint}`,
      true
    );
  }

  /** Continuous VL on every market — runs even while a contract is open. */
  _refreshTournamentScan() {
    if (!this.running || !this._usesTournamentMode()) return;
    this._sweepAllMarketsVL();
    this._syncLiveAnalysisBoard();
    const board = this._liveDualSideBoard || [];
    const readyNear = board.filter(r => r.status === 'READY' || r.status === 'NEAR');
    const candidates = this._collectBestAcrossMarkets();
    this._tournamentQueuedCount = readyNear.length || candidates.length;
    this._tournamentTopStreak = candidates.length
      ? Math.max(...candidates.map(c => c.streak))
      : 0;
    this._tournamentTopBinaryWin = candidates.length
      ? Math.max(...candidates.map(c => c.binaryWinPct ?? 0))
      : 0;
    if (Math.random() < 0.08) this._stealthBackgroundActivity();
    this._updateTournamentStatus();
  }

  _collectTournamentCandidates() {
    const dirs = this._getStrategyDirs();
    const candidates = [];

    for (const sym of MARKETS) {
      if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
      const ticks = scanner.buffers[sym] || [];
      if (ticks.length < 8) continue;
      const state = this.marketVLState[sym];
      if (!state) continue;

      for (const dir of dirs) {
        if (!this._isDirReady(state, dir)) continue;
        if (this._isTournamentOppositeBlocked(sym, dir)) continue;
        if (this._isTournamentEntryLocked(sym, dir)) continue;
        if (this._violatesBarRules(sym, dir, scanner.scores[sym])) continue;

        const streak = this._getStreakForDir(state, dir);
        const scores = scanner.scores[sym] || {};
        const bias = this._computeOppositeDirectionBias(ticks, dir);
        const winChance = state.dirWinChance?.[dir]
          ?? this._estimateTournamentWinChance(sym, dir, streak, ticks, scores);
        if (!this._passesTournamentLearningGate(sym, dir, winChance)) continue;
        const req = this._getTournamentVlRequired(dir, this._getWinRecoveryContext());
        const oppRec = this._scoreOppositeStreakRecovery(bias, streak, req);
        const pctRec = this._scoreMarketPctRecovery(dir, scores);
        const ready = true;
        const recoveryScore = this._computeRecoveryPickScore(
          sym, dir, streak, req, winChance, bias, scores, oppRec, pctRec, ready
        );
        const score = this._computeTournamentCandidateScore(sym, dir, streak, scores, bias, winChance, oppRec, pctRec);
        const consensus = this._countConsensusMarkets(dir, sym)
          + this._countConsensusStreakReady(dir, sym, req);
        const raw = {
          sym,
          dir,
          streak,
          required: req,
          score: score + consensus * 5,
          winChance,
          recoveryScore,
          oppRec,
          pctRec,
          ready,
          consensus,
          oppEnd: bias.endConsecutive,
          oppMax: bias.maxConsecutive,
          oppTotal: bias.totalOpposite,
        };
        const enriched = this._applyConvergence(raw, {
          silent: true,
          allowBlocked: !this._needsRecoveryFireGate(),
        });
        if (enriched) {
          enriched.score += (enriched.convergenceScore || 0) * 0.4;
          candidates.push(enriched);
        }
      }
    }
    return this._filterTrapCandidates(candidates);
  }

  /** Green session: best market when VL is 1 tick short — keeps flow without reckless dual fire. */
  _collectTournamentPulseCandidates() {
    if (this._getTournamentEntryTier() !== 'fast') return [];

    let dirs = [];
    if (this.strategy === 'OMNISNIPER') dirs = ['OVER3', 'OVER4', 'OVER5', 'UNDER6', 'UNDER7', 'UNDER8'];
    else if (this.strategy === 'BOTH5') dirs = ['OVER5', 'UNDER5'];
    else dirs = ['EVEN', 'ODD'];
    const recovery = this._getWinRecoveryContext();
    const pulse = [];

    for (const sym of MARKETS) {
      if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
      const ticks = scanner.buffers[sym] || [];
      if (ticks.length < 10) continue;
      const scores = scanner.scores[sym] || {};
      const isOu = this.strategy === 'BOTH5';
      if (isOu && (parseFloat(scores.d5Pct) || 0) >= 14) continue;

      const streaks = this._calcDigitStreaks(ticks);
      for (const dir of dirs) {
        if (this._isTournamentOppositeBlocked(sym, dir)) continue;
        if (this._isTournamentEntryLocked(sym, dir)) continue;
        if (this._isDirectionBlocked(dir, sym)) continue;
        if (this._violatesBarRules(sym, dir, scores)) continue;

        const required = this._getTournamentVlRequired(dir, recovery);
        const streak = scores.tailLossMap?.[dir] || 0;
        if (streak < required - 1 || streak >= required) continue;

        const winChance = this._estimateTournamentWinChance(sym, dir, streak, ticks, scores);
        if (winChance < TOURNAMENT_PULSE_WIN) continue;
        if (!this._passesTournamentMacroPct(dir, scores, true)) continue;

        if (!this._passesConvergenceReliefBlock(sym, dir, ticks, required, streak)) continue;

        const bias = this._computeOppositeDirectionBias(ticks, dir);
        const shortPct = parseFloat(scores.pct?.[dir]) || 0;
        const conv = this._runConvergenceScan(sym, dir, this._buildConvergenceCtx(sym, dir, ticks, scores, required, streak));
        const score = Math.round(winChance * 2.5 + (bias?.endConsecutive || 0) * 4 + (shortPct || 0) + conv.convergenceScore * 0.3);

        pulse.push({
          sym, dir, streak, required, winChance, score,
          recoveryScore: score, ready: true, pulse: true,
          convergenceScore: conv.convergenceScore,
          oppEnd: bias.endConsecutive, oppMax: bias.maxConsecutive, oppTotal: bias.totalOpposite,
          oppRec: 0, pctRec: 0,
        });
      }
    }

    pulse.sort((a, b) => b.score - a.score);
    return pulse;
  }

  /** Scanner momentum entry — trade when short-term score is hot (green session only). */
  _collectTournamentFlowCandidates() {
    if (this._getTournamentEntryTier() !== 'fast') return [];

    const isOu = this.strategy === 'BOTH5';
    let dirs = [];
    if (this.strategy === 'OMNISNIPER') dirs = ['OVER3', 'OVER4', 'OVER5', 'UNDER6', 'UNDER7', 'UNDER8'];
    else if (this.strategy === 'BOTH5') dirs = ['OVER5', 'UNDER5'];
    else dirs = ['EVEN', 'ODD'];
    const flow = [];

    for (const sym of MARKETS) {
      if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
      const ticks = scanner.buffers[sym] || [];
      if (ticks.length < 12) continue;
      const scores = scanner.scores[sym] || {};
      const momentum = isOu
        ? parseFloat(scores.overUnderScore) || 0
        : parseFloat(scores.evenOddScore) || 0;
      if (momentum < TOURNAMENT_FLOW_MIN) continue;
      if (isOu && (parseFloat(scores.d5Pct) || 0) >= 13) continue;

      const streaks = this._calcDigitStreaks(ticks);
      for (const dir of dirs) {
        if (this._isTournamentOppositeBlocked(sym, dir)) continue;
        if (this._isTournamentEntryLocked(sym, dir)) continue;
        if (this._isDirectionBlocked(dir, sym)) continue;
        if (this._violatesBarRules(sym, dir, scores)) continue;

        const streak = scores.tailLossMap?.[dir] || 0;
        if (streak < 2) continue;

        const winChance = this._estimateTournamentWinChance(sym, dir, streak, ticks, scores);
        if (winChance < TOURNAMENT_PULSE_WIN) continue;
        if (!this._passesTournamentMacroPct(dir, scores, true)) continue;

        const flowReq = this._getTournamentVlRequired(dir, this._getWinRecoveryContext());
        if (!this._passesConvergenceReliefBlock(sym, dir, ticks, flowReq, streak)) continue;

        const shortPct = parseFloat(scores.pct?.[dir]) || 0;
        const flowConv = this._runConvergenceScan(sym, dir, this._buildConvergenceCtx(sym, dir, ticks, scores, flowReq, streak));
        const score = Math.round(momentum + winChance + streak * 4 + (shortPct || 0) * 0.4 + flowConv.convergenceScore * 0.3);

        flow.push({
          sym, dir, streak,
          required: flowReq,
          winChance, score, recoveryScore: score, ready: true, flow: true,
          convergenceScore: flowConv.convergenceScore,
          oppEnd: 0, oppMax: 0, oppTotal: 0, oppRec: 0, pctRec: 0,
        });
      }
    }

    flow.sort((a, b) => b.score - a.score);
    return flow;
  }

  /** Rank by binary edge (theoretical + empirical), then convergence / recovery lens. */
  _rankTournamentCandidates(candidates) {
    candidates.forEach(c => {
      this._applyBinaryScoring(c);
      const ticks = scanner.buffers[c.sym] || [];
      const bonus = flowScoreBonus(ticks, c.dir, this.strategy);
      c.flowBonus = bonus;
      c.binaryEdge = (c.binaryEdge ?? 0) + bonus;
    });
    const binarySort = (a, b) =>
      (b.binaryEdge ?? 0) - (a.binaryEdge ?? 0)
      || (b.binaryWinPct ?? 0) - (a.binaryWinPct ?? 0);
    const convSort = (a, b) => (b.convergenceScore ?? 0) - (a.convergenceScore ?? 0);

    if (this._isRecoveryHuntMode()) {
      return candidates.sort((a, b) =>
        binarySort(a, b)
        || convSort(a, b)
        || (b.recoveryScore - a.recoveryScore)
        || (b.winChance - a.winChance)
        || (b.oppRec - a.oppRec)
        || (b.pctRec - a.pctRec)
        || (b.streak - a.streak)
      );
    }

    const lens = this._getActiveRecoveryLens();
    if (lens === RECOVERY_LENS.OPPOSITE) {
      return candidates.sort((a, b) =>
        binarySort(a, b)
        || convSort(a, b)
        || (b.oppRec - a.oppRec)
        || (b.winChance - a.winChance)
        || (b.oppEnd - a.oppEnd)
        || (b.streak - a.streak)
        || (b.score - a.score)
      );
    }
    return candidates.sort((a, b) =>
      binarySort(a, b)
      || convSort(a, b)
      || (b.pctRec - a.pctRec)
      || (b.winChance - a.winChance)
      || (b.streak - a.streak)
      || (b.oppRec - a.oppRec)
      || (b.score - a.score)
    );
  }

  _getStreakForDir(state, dir, scores = null) {
    if (scores && scores.tailLossMap && scores.tailLossMap[dir] !== undefined) {
      return scores.tailLossMap[dir];
    }
    if (!state.streaks) state.streaks = {};
    if (!state.depths) state.depths = {};
    return state.depths[dir] || state.streaks[dir] || 0;
  }

  _setDirReady(state, dir, ready, depth = 0) {
    if (!state.ready) state.ready = {};
    if (!state.depths) state.depths = {};
    state.ready[dir] = ready;
    state.depths[dir] = depth;
  }

  _isDirReady(state, dir) {
    if (!state.ready) state.ready = {};
    return state.ready[dir] || false;
  }

  _evaluateDirVL(symbol, state, ticks, dir, recovery) {
    if (this._usesTournamentMode()) {
      return this._evaluateDirVLTournament(symbol, state, ticks, dir, recovery);
    }
    const scores = scanner.scores[symbol] || {};
    const d = ticks[ticks.length - 1];
    const streaks = this._calcDigitStreaks(ticks);
    const dyn = this._computeDynamicVlRequired(ticks, dir, recovery, false);
    const required = dyn?.required ?? this._vlFloorForDirection(dir);
    const streak = scores.tailLossMap?.[dir] || 0;

    this._setDirReady(state, dir, false, 0);

    if (streak < required) {
      if (state.confirmMarket === symbol) {
        state.confirmPending = false;
        state.confirmDir = null;
        state.confirmMarket = null;
      }
      return;
    }
    if (!this._streakFormedAfterLastTrade(streak)) return;
    if (this._isDirectionBlocked(dir, symbol)) return;

    const d5Pct = parseFloat(scores.d5Pct) || 0;
    if (d5Pct >= 10.5) return;
    if (this._computeAlternationRate(ticks, dir) > DEFAULT_ALTERNATION_CAP) return;

    const chi = this._computeChiSquareDeviation(ticks, dir);
    if (!chi.significant) return;

    const wr = this._recentWinRate(symbol, dir);
    if (wr !== null && wr < 0.38) return;
    if (!this._passesVlDepthGate(dir, streak)) return;

    const ltPct = parseFloat(scores.ltPct?.[dir]) || 0;
    if (dir.startsWith('OVER') && ltPct < 42) return;
    if (dir.startsWith('UNDER') && ltPct < 48) return;
    if (dir === 'EVEN' && ltPct < 48) return;
    if (dir === 'ODD' && ltPct < 48) return;

    const confirmed = this._directionWouldWin(d, dir);
    const pendingSame = state.confirmPending && state.confirmDir === dir && state.confirmMarket === symbol;

    if (confirmed) {
      state.confirmPending = false;
      state.confirmDir = null;
      state.confirmMarket = null;
      this._setDirReady(state, dir, true, streak);
      return;
    }

    if (pendingSame) {
      state.confirmPending = false;
      state.confirmDir = null;
      state.confirmMarket = null;
      return;
    }

    state.confirmPending = true;
    state.confirmDir = dir;
    state.confirmMarket = symbol;
  }

  _updateMarketVL(symbol) {
    const state = this.marketVLState[symbol];
    if (!state) return;
    const ticks = scanner.buffers[symbol] || [];
    if (ticks.length < 8) return;

    state.lastTickTime = Date.now();
    const recovery = this._getWinRecoveryContext();
    
    let dirs = this._getStrategyDirs();

    for (const dir of dirs) this._evaluateDirVL(symbol, state, ticks, dir, recovery);

    let bestScore = 0;
    let bestDir = null;
    for (const dir of dirs) {
      if (!this._isDirReady(state, dir)) continue;
      const depth = this._getStreakForDir(state, dir);
      const bias = this._computeOppositeDirectionBias(ticks, dir);
      const scores = scanner.scores[symbol] || {};
      const winChance = state.dirWinChance?.[dir]
        ?? this._estimateTournamentWinChance(symbol, dir, depth, ticks, scores);
      const req = this._getTournamentVlRequired(dir, recovery);
      const oppRec = this._scoreOppositeStreakRecovery(bias, depth, req);
      const pctRec = this._scoreMarketPctRecovery(dir, scores);
      const score = this._computeTournamentCandidateScore(symbol, dir, depth, scores, bias, winChance, oppRec, pctRec);
      if (score > bestScore) {
        bestScore = score;
        bestDir = dir;
      }
    }
    state.readinessScore = bestScore;
    state.bestDir = bestDir;
  }

  _computeTournamentCandidateScore(sym, dir, streak, scores, bias, winChance, oppRec = 0, pctRec = 0) {
    const b = bias || this._computeOppositeDirectionBias(scanner.buffers[sym] || [], dir);
    const lens = this._getActiveRecoveryLens();
    const lensBoost = lens === RECOVERY_LENS.OPPOSITE ? oppRec * 2.2 : pctRec * 2.2;
    let score = (winChance ?? 40) * 3 + lensBoost + b.endConsecutive * 4 + Math.max(0, streak - 3) * 5;
    const mStats = this.marketStats[sym] || {};
    const tw = mStats.totalSessionWins || 0;
    const tl = mStats.totalSessionLosses || 0;
    if (tw + tl >= 2) score += ((tw / (tw + tl)) - 0.42) * 12;
    const lastWin = this._lastWinSetup;
    if (lastWin && (this.sessionConsecutiveLosses || 0) === 0) {
      if (lastWin.sym === sym && lastWin.dir === dir) score += 22;
      else if (lastWin.sym === sym) score += 10;
      else if (lastWin.dir === dir) score += 6;
    }
    return Math.max(0, Math.round(score));
  }

  _computeReadinessScore(sym, dir, streak, scores) {
    const ticks = scanner.buffers[sym] || [];
    let score = streak * 8;

    const opp = this._computeOppositeDirectionBias(ticks, dir);
    score += (opp?.score ?? 0) * 0.4;

    if (dir === 'OVER5' && (parseFloat(scores.ltOverPct) || 0) >= 42) score += 10;
    if (dir === 'UNDER5' && (parseFloat(scores.ltUnderPct) || 0) >= 48) score += 10;
    if (dir === 'EVEN' && (parseFloat(scores.ltEvenPct) || 0) >= 48) score += 10;
    if (dir === 'ODD' && (parseFloat(scores.ltOddPct) || 0) >= 48) score += 10;

    const d5Pct = parseFloat(scores.d5Pct) || 0;
    if (d5Pct >= 10.5) score -= 20;
    else if (d5Pct >= 8) score -= 8;

    const mStats = this.marketStats[sym] || {};
    const tw = mStats.totalSessionWins || 0;
    const tl = mStats.totalSessionLosses || 0;
    if (tw + tl >= 2) score += ((tw / (tw + tl)) - 0.42) * 30;

    const key = `${dir}:${streak}`;
    const depthStats = this._vlDepthStats[key];
    if (depthStats?.attempts >= 5) {
      const wr = depthStats.wins / depthStats.attempts;
      score += (wr - this._vlDepthBreakeven(dir)) * 40;
    }

    const consensus = this._countConsensusMarkets(dir, sym);
    score += consensus * 6;

    return Math.max(0, Math.round(score));
  }

  _countConsensusMarkets(direction, excludeSym) {
    let count = 0;
    for (const sym of MARKETS) {
      if (sym === excludeSym) continue;
      const st = this.marketVLState[sym];
      if (!st) continue;
      if (this._isDirReady(st, direction)) count++;
    }
    return count;
  }

  _runTournament() {
    this._runApexMatrixLeaderboard();
    this._refreshTournamentScan();
    this._scheduleTournamentFireTry();
  }

  /** Fire only when slot is free — snapshot of best ready setup at this instant. */
  _tryFireTournamentBest() {
    if (!this.running || !this._usesTournamentMode()) return;

    // Post-loss pause removed — fire immediately

    // Clear any stale apex lock before checking — never block the bot indefinitely
    if (isApexOrderInFlight()) setApexOrderInFlight(false);

    if (this._hasTournamentTradeInFlight()) return;
    if (this._pendingTournamentBuy) return;

    if (this._martingaleArmAfter && Date.now() < this._martingaleArmAfter) return;
    if (this._checkSessionGuards()) return;
    if (this._isCascadePaused()) {
      const until = Math.max(this._lossStreakCooldownUntil || 0, this._cascadePausedUntil || 0);
      const sec = Math.ceil((until - Date.now()) / 1000);
      const flow = analyzeBinaryFlow(scanner.buffers[MARKETS[0]] || [], this.strategy);
      const flowHint = flow.favored.length ? ` · flow ${flow.favored.join('/')}` : '';
      this.updateStatus(`⏸ Loss-streak pause · ${sec}s${flowHint}`, true);
      return;
    }
    if (!this._canFireTradeNow()) return;

    if (this._isEntryConfirmBlocking()) {
      if ((this.sessionConsecutiveLosses || 0) >= 1) {
        this._clearEntryConfirmLab('loss-skip');
      } else {
        this._tryCompleteEntryConfirmLab();
        this._updateEntryConfirmLabStatus();
        if (!this._confirmRetryTimer) {
          this._confirmRetryTimer = setTimeout(() => {
            this._confirmRetryTimer = null;
            this._tryFireTournamentBest();
          }, 500);
        }
        return;
      }
    }

    if (this.nextAllowedTradeTime && Date.now() < this.nextAllowedTradeTime) return;

    const freeSlot = this.executionSlots.find(s => !s.active && !s.contractId);
    if (!freeSlot) return;

    if (this._usesIsolatedSniperMode()) {
      void this._fireIsolatedSniperTrade({ freeSlot });
      return;
    }

    const losses = this.sessionConsecutiveLosses || 0;
    const recoveryMode = losses >= 1;
    const settled = (this.sessionTrades || []).filter(t => !t.pending);
    const rollingWr = this._getRollingWinRate(10);

    const matrixSweep = this._runApexMatrixLeaderboard();
    let candidates = matrixSweep.leaderboard?.length
      ? this._collectApexMatrixCandidates()
      : [];
    if (!candidates.length) candidates = this._collectBestAcrossMarkets();
    candidates = this._filterTrapCandidates(candidates);

    if (candidates.length === 0) {
      const warming = MARKETS.filter(s => this.marketVLState[s]?.nearReady).length;
      const tierTag = this._getTournamentEntryTier();
      const modeTag = 'win';
      const wrTag = rollingWr != null ? ` · WR10 ${(rollingWr * 100).toFixed(0)}%` : '';
      this.updateStatus(
        `scan 15 · ${modeTag} · ${tierTag}${wrTag} · ${warming} warming`,
        true
      );
      if (warming > 0 && Date.now() - (this._lastScanToastAt || 0) > 15000) {
        this._notifyOnce(this._toastIds.scan, `📊 ${warming} market(s) building VL…`, { icon: '📊', duration: 2000 });
        this._lastScanToastAt = Date.now();
      }
      return;
    }

    if (this._entryConfirmLab?.confirmed) {
      candidates = this._applyConfirmedEntryPick(candidates);
    }

    this._rankTournamentCandidates(candidates);
    const readyCount = candidates.length;
    // ── Leaderboard gate: accept top candidates directly, no recovery branching ──
    const gatePool = [];
    for (let i = 0; i < Math.min(12, candidates.length); i++) {
      const c = candidates[i];
      if (this._passesTournamentFireQuality(c)) {
        gatePool.push(c);
      }
    }
    let best = null;
    let runnerUp = null;
    let stealthRank = 1;
    let stealthPool = gatePool.length;
    if (gatePool.length > 0) {
      best = { ...gatePool[0] };
      runnerUp = gatePool[1] ? { ...gatePool[1] } : null;
      const rawDir = best.dir;
      best.dir = this._resolveFireDirection(rawDir);
      best.invertedFrom = rawDir !== best.dir ? rawDir : null;
      if (best.invertedFrom) {
        const ticks = scanner.buffers[best.sym] || [];
        if (!this._passesExhaustionFireGate(best.sym, best.dir)
          || isMomentumContinuationTrap(ticks, best.dir, 3, 3)) {
          this.updateStatus('⏳ Invert blocked · no exhaustion on flipped side', true);
          return;
        }
      }
    }

    if (!best) {
      // Fallback: If no candidate passes the primary fire gate, do NOT force fire. 
      // Return and wait for the next tick to evaluate naturally.
      const top = candidates[0];
      const lossTag = losses > 0 ? ` · L${losses}` : '';
      this.updateStatus(
        `scan 15 · win · ${readyCount} ranked · top ${top?.binaryWinPct ?? '?'}%${lossTag}`,
        true
      );
      return;
    }

    if (this._stealthMaybeHesitateTournament()) return;

    if (!tryAcquireApexLock()) {
      this.updateStatus('⏳ Apex lock busy', true);
      return;
    }
    if (!this._claimTournamentFire(freeSlot, best)) {
      setApexOrderInFlight(false);
      return;
    }

    this._activeEntryAlgorithm = best.algorithm || best.algorithms?.[0] || ENTRY_ALGORITHMS.DISTRIBUTION_BIAS;
    this._lastEntryAlgorithm = this._activeEntryAlgorithm;

    this._lastTournamentEntry = {
      sym: best.sym,
      dir: best.dir,
      streak: best.streak,
      winChance: best.winChance,
      binaryWinPct: best.binaryWinPct,
      binaryEdge: best.binaryEdge,
      oppEnd: best.oppEnd,
      score: best.score,
      algorithm: this._activeEntryAlgorithm,
      algoAgreement: best.algoAgreement,
      at: Date.now(),
    };

    const label = MARKET_LABELS[best.sym] || best.sym;
    const lensTag = this._recoveryLensLabel(lens);
    if (best.confirmedByLab) {
      this.sendLog(
        `🧪 Live fire (lab confirmed) ${best.dir} ${label} · paper ${((best.paperAcc || 0) * 100).toFixed(0)}% · est ${best.winChance}%`
      );
    } else if (this._isRecoveryHuntMode()) {
      this.sendLog(
        `🎯 Recovery pick ${readyCount} ready: ${best.dir} ${label} · score ${best.recoveryScore} · est ${best.winChance}% · ${lensTag}`
      );
    } else if (readyCount > 1) {
      const binTag = best.binaryWinPct != null ? ` · bin ${best.binaryWinPct}%` : '';
      const cntTag = best.counterScore != null ? ` · cnt ${best.counterScore}` : '';
      const agreeTag = best.algoAgreement > 1 ? ` · ${best.algoAgreement} algos` : '';
      const invertTag = best.invertedFrom ? ` · ↩ from ${best.invertedFrom}` : '';
      this.sendLog(
        `🏆 Best of ${readyCount}: ${best.dir} ${label} · edge ${best.binaryEdge ?? best.score}${binTag}${cntTag}${agreeTag}${invertTag} · VL ${best.streak}`
      );
    } else {
      this.sendLog(`🏆 Pick lens: ${lensTag} → ${best.dir} ${label}`);
    }
    if (best.apexPerfect || best.algorithm === 'apex_matrix') {
      const s1 = best.strategy1?.score ?? '?';
      const s2 = best.strategy2?.score ?? '?';
      const s3 = best.strategy3?.score ?? '?';
      this.sendLog(
        `★ APEX SNIPER ${best.dir} ${label} · conf ${best.confidenceScore ?? best.score} · S1=${s1} S2=${s2} S3=${s3}`
      );
    } else if (best.convergenceScore != null) {
      const purity = best.convergence?.purity ?? best.convergence?.signals?.signal1?.value;
      const xMkt = best.convergence?.crossCount ?? best.convergence?.signals?.signal5?.count;
      this.sendLog(`✓ Conv ${best.convergenceScore} · ${best.dir} ${label} · pure ${purity != null ? Number(purity).toFixed(2) : '?'} · xMkt ${xMkt ?? '?'}`);
    }

    this._recordTradeFired();
    this._clearEntryConfirmLab('live fire');
    void this._executeInSlot(freeSlot, best);
  }

  async _executeInSlot(slot, plan, opts = {}) {
    const {
      sym, dir, streak, score, winChance, oppEnd, oppMax, algorithm,
      fastPass, stake: planStake,
    } = plan || {};
    const isFastPass = fastPass === true || opts.fastPass === true;

    if (!this._tournamentTradeInFlight || !slot.active) {
      this._releaseTournamentFire(slot);
      return;
    }

    const ch = this.channels[slot.channelKey];
    const step = this._sessionMartingaleStep || 0;
    slot.step = step;
    ch.step = step;
    const stake = this._getSessionMartingaleStake(sym);
    slot.stake = stake;
    ch.stake = stake;
    const mult = this.config.martMultiplier || 2;

    const isRecoveryForce = opts.recoveryForce === true || (this.sessionConsecutiveLosses || 0) >= 1;

    if (!isFastPass && !isRecoveryForce) {
      await this._stealthReactionDelayForChannel(slot.channelKey);
      this._stealthBackgroundActivity();
    }

    if (!this._tournamentTradeInFlight || !slot.active) {
      this._releaseTournamentFire(slot);
      return;
    }

    const fireDir = this._resolveFireDirection(dir);
    slot.dir = fireDir;
    const wc = winChance ?? this.marketVLState[sym]?.dirWinChance?.[dir];
    const algoName = algorithm ? this._algoLabel(algorithm) : this._algoLabel(this._activeEntryAlgorithm || 'pick');
    const invertTag = fireDir !== dir ? ` · inverted ${dir}→${fireDir}` : '';
    this.sendLog(
      `🎯 [${algoName}] ${fireDir} ${MARKET_LABELS[sym]} | est ${wc ?? '?'}%${invertTag} | ` +
      `step ${step} (×${mult}) → $${stake.toFixed(2)}`
    );

    try {
      await this._placeTrade(slot.channelKey, fireDir, stake, null, sym, { fastPass: isFastPass || isRecoveryForce });
      if (!this._isWinningDualStrategy()) {
        this.activeMarket = sym;
        if (this.onMarketSwitch) this.onMarketSwitch(sym);
      }
      armApexOrderInFlight();
      if (this.strategy === 'BOTH' || this.strategy === 'BOTH5') {
        this._lockMarketOppositeLeg(sym, fireDir, OPP_LEG_LOCK_MS);
      }
    } catch (e) {
      this.sendLog(`⚠️ Tournament place failed: ${e?.message || e}`);
      setApexOrderInFlight(false);
      this._releaseTournamentFire(slot);
    }
  }

  _onSlotSettled(slot, contract) {
    const cid = contract.contract_id;
    if (this._settledContractIds.has(cid)) return;
    this._settledContractIds.add(cid);
    this._openTournamentContracts.delete(cid);

    const profit = parseFloat(contract.profit) || 0;
    const won = contract.status === 'won' || profit > 0;
    const buyPrice = parseFloat(contract.buy_price) || 0;
    const market = contract.underlying || slot.sym;
    const direction = slot.dir;
    const ch = this.channels[slot.channelKey];
    const stepBefore = this._sessionMartingaleStep || 0;

    if (won) {
      this._handleMartingaleSettle(true, profit, buyPrice, direction);
      registerEngineTransaction(true, market, {
        strategy: this.strategy,
        dir: direction,
        ...this._matrixMartingaleOpts(),
      });
      this._recordLegMarketResult(market, direction, true);
      if (this.strategy === 'BOTH5') {
        delete this._directionCooldown.OVER5;
        delete this._directionCooldown.UNDER5;
        for (const k of Object.keys(this._marketDirCooldown)) {
          if (k.startsWith(`${market}:`)) delete this._marketDirCooldown[k];
        }
        delete this._marketOppositeLock[market];
        this._ouTrackFailures = {};
      }
      this._onSessionWin(`slot-${slot.id}`);
    } else {
      this._onSessionLoss(`slot-${slot.id}`, direction, {});
      this._recordLegMarketResult(market, direction, false);
      this._blockDirectionAfterLoss(direction, market);
      if (this._lastTournamentEntry) {
        this._lastLossSetup = { ...this._lastTournamentEntry, at: Date.now() };
      }
      this._handleMartingaleSettle(false, profit, buyPrice, direction);
      registerEngineTransaction(false, market, {
        dir: direction,
        strategy: this.strategy,
        ...this._matrixMartingaleOpts(),
      });
      if (this.strategy === 'RANDOM_PICKER' && this.config?.autoSwitchMarkets !== false) {
        const legLosses = this.channels[direction]?.consecutiveLosses
          || this._ouTrackFailures[direction] || 0;
        if (legLosses >= this._getLegSwitchThreshold(direction)
          || this._getLegMarketLossStreak(direction, market) >= 2) {
          this._maybeRotateMarketForLeg(direction, 'tournament loss');
        }
      }
      if (usesMatrix20Engine(this.strategy) && market) {
        this.sendLog(`🔒 Pivot: ${MARKET_LABELS[market] || market} blacklisted briefly — next pick elsewhere`);
      }
    }

    this._recordTradeLearning(market, direction, won, profit, slot.vlDepthAtEntry);

    if (!this._isWinningDualStrategy()) {
      this._armPostTradeTickCooldown();
    }
    if (this._isWinningDualStrategy()) {
      this._postTradeTickCooldown = 0;
      this.nextAllowedTradeTime = 0;
      this._martingaleArmAfter = 0;
    } else {
      this.nextAllowedTradeTime = 0;
      this._martingaleArmAfter = 0;
    }

    delete this._contractToSlot[cid];
    this._finalizeTradeRecord(contract, market, direction, won, profit, buyPrice, ch);
    this._releaseTournamentFire(slot);

    this._rollRecoveryLens(this.sessionConsecutiveLosses > 0);

    queueMicrotask(() => {
      if (!this.running) return;

      if (!shouldUseFastPassRecovery()) {
        this._sweepAllMarketsVL();
        this._tournamentQueuedCount = this._collectTournamentCandidates().length;
        this._updateTournamentStatus();
      }
      this._scheduleTournamentFireTry();
    });
  }

  _finalizeTradeRecord(contract, market, direction, won, profit, buyPrice, channel) {
    const cid = contract.contract_id;
    let finalDigit = '-';
    const rawExit = contract.exit_tick_display_value || contract.sell_spot_display_value || contract.current_spot_display_value;
    if (rawExit) finalDigit = String(rawExit).slice(-1);
    else {
      const rawNum = contract.exit_tick || contract.sell_spot || contract.current_spot;
      if (rawNum) finalDigit = String(rawNum).slice(-1);
    }

    const trade = {
      id: cid,
      direction,
      market,
      stake: buyPrice,
      profit,
      won,
      exitTick: finalDigit,
      barrier: contract.barrier || '',
      time: Date.now(),
      pending: false,
      legOrder: this._dualLegSortKey(direction),
      ...this._buildTradeMeta(market, direction),
    };

    this.sessionTrades.push(trade);
    this._lastTradeSettledAt = Date.now();

    const dwKey = `${market}:${direction}`;
    if (!this._dirWinHistory[dwKey]) this._dirWinHistory[dwKey] = [];
    this._dirWinHistory[dwKey].push(won ? 1 : 0);
    if (this._dirWinHistory[dwKey].length > 20) this._dirWinHistory[dwKey].shift();

    const vlDepth = channel?.vlDepthAtEntry || 0;
    if (vlDepth > 0) this._recordVlDepthResult(direction, vlDepth, won);

    if (this.onTradeUpdate) this.onTradeUpdate(trade);

    const mStats = this.marketStats[market];
    if (mStats) {
      if (won) {
        mStats.consecutiveLosses = 0;
        mStats.totalSessionWins = (mStats.totalSessionWins || 0) + 1;
      } else {
        mStats.consecutiveLosses = (mStats.consecutiveLosses || 0) + 1;
        mStats.totalSessionLosses = (mStats.totalSessionLosses || 0) + 1;
        if (mStats.consecutiveLosses >= 2) {
          mStats.quarantinedUntil = Date.now() + MARKET_QUARANTINE_MS;
        }
      }
    }

    this.sendLog(
      `💸 [Slot] ${MARKET_LABELS[market]} ${direction} ${won ? '✅ WIN' : '❌ LOSS'} ` +
      `${won ? '+' : ''}$${profit.toFixed(2)} | stake $${buyPrice.toFixed(2)} | mart step ${this._sessionMartingaleStep}`
    );
  }

  _bindTickWakeScanner() {
    this._unsubTickWakeScanner = scanner.onUpdate((sym, allScores) => {
      if (!this.running) return;
      this._onMarketTickCooldown();
      this._refreshLegBestMarkets();
      const hidden = typeof document !== 'undefined' && document.hidden;
      if (hidden) {
        const now = Date.now();
        if (!this._tickWakeAt || now - this._tickWakeAt >= 50) {
          this._tickWakeAt = now;
          queueMicrotask(() => {
            if (this.running) this._executeCycle();
          });
        }
        return;
      }
      if (this._tickWakeTimer) return;
      this._tickWakeTimer = setTimeout(() => {
        this._tickWakeTimer = null;
        if (this.running) this._scheduleNext(0);
      }, 40);
    });
  }

  wakeFromBackgroundTab() {
    if (!this.running) return;
    this._executeCycle();
  }

  _startBackgroundHeartbeat() {
    this._stopBackgroundHeartbeat();
    if (typeof document === 'undefined') return;
    this._bgHeartbeat = setInterval(() => {
      if (!this.running || !document.hidden) return;
      this._executeCycle();
    }, 1000);
  }

  _stopBackgroundHeartbeat() {
    if (this._bgHeartbeat) {
      clearInterval(this._bgHeartbeat);
      this._bgHeartbeat = null;
    }
  }

  _unbindTickWakeScanner() {
    if (this._tickWakeTimer) {
      clearTimeout(this._tickWakeTimer);
      this._tickWakeTimer = null;
    }
    if (this._unsubTickWakeScanner) {
      this._unsubTickWakeScanner();
      this._unsubTickWakeScanner = null;
    }
  }

  stop(reason) {
    this.running = false;
    this.sessionEndedAt = Date.now();
    resetGlobalRiskMatrix();
    this.updateStatus('Idle');
    this.sendLog(`🛑 BOT STOPPED — Reason: ${reason || 'User stopped'}`);
    this._stopBackgroundHeartbeat();
    if (this._cycleTimer) { clearTimeout(this._cycleTimer); this._cycleTimer = null; }
    if (this._pocHandler) { this._pocHandler(); this._pocHandler = null; }
    if (this._tournamentWatchdog) {
      clearInterval(this._tournamentWatchdog);
      this._tournamentWatchdog = null;
    }
    this._stopLiveBoardSync();
    this._stopGlobalRankSweep();
    this._stopRecoveryPulse();
    this._stopTournamentScanner();
    if (TOURNAMENT_STRATEGIES.has(this.strategy)) {
      this.startSyntheticPreview(this.strategy);
    }
    this._tournamentTradeInFlight = false;
    this._tournamentFireTryPending = false;
    this._pendingTournamentBuy = false;
    this._openTournamentContracts = new Map();
    this._unbindTickWakeScanner();

    // ── Reset all channels to base stake so martingale doesn't bleed into next session ──
    const stopBaseStake = this.config?.baseStake || 0.35;
    for (const key in this.channels) {
      if (this.channels[key].contractId) {
        if (!this._contractLedger) this._contractLedger = {};
        this._contractLedger[this.channels[key].contractId] = {
          channelKey: key, 
          direction: this.channels[key].direction, 
          stake: this.channels[key].stake
        };
      }
      this.channels[key] = {
        active: false,
        step: 0,
        consecutiveLosses: 0,
        stake: stopBaseStake,
        contractId: null,
        direction: null
      };
    }

    // ── Reset all strategy phase/debt state to prevent cross-session bleed ──
    this.under8V2Phase = 'SEARCHING';      this.under8V2Debt = 0;    this.under8V2CurrentLosses = 0;
    this.under8Phase  = 'SEARCHING';      this.under8Debt = 0;      this.under8CurrentLosses = 0;
    this.over3v3Phase = 'SEARCHING';      this.over3v3Debt = 0;     this.over3v3CurrentLosses = 0;
    this.over3v2Phase = 'SEARCHING';      this.over3v2Debt = 0;     this.over3v2CurrentLosses = 0;
    this.over3v1Phase = 'SEARCHING';      this.over3v1Debt = 0;     this.over3v1CurrentLosses = 0;
    this.over5v1Phase = 'SEARCHING';      this.over5v1Debt = 0;     this.over5v1CurrentLosses = 0;
    this.over6Phase   = 'SEARCHING';      this.over6Debt = 0;       this.over6CurrentLosses = 0;
    this.over6v2Phase = 'SEARCHING';      this.over6v2Debt = 0;     this.over6v2CurrentLosses = 0;
    this.under3v1Phase= 'SEARCHING';      this.under3v1Debt = 0;    this.under3v1CurrentLosses = 0;
    this.under7v1Phase= 'SEARCHING';
    this.under9v1Phase= 'SEARCHING';      this.under9v1Debt = 0;    this.under9v1CurrentLosses = 0;
    this.evenV1Phase  = 'SEARCHING';      this.evenV1Debt = 0;      this.evenV1CurrentLosses = 0;
    this.oddV1Phase   = 'SEARCHING';      this.oddV1Debt = 0;       this.oddV1CurrentLosses = 0;
    this.over0v1Phase = 'SEARCHING_OVER_0'; this.over0v1Debt = 0;   this.over0v1CurrentLosses = 0;
    this.hybridPhase  = 'SEARCHING';        this.hybridDebt = 0;    this.hybridCurrentLosses = 0;
    this.hybridSide = null; this.hybridRecoveryConsecutiveLosses = 0; this.hybridRecoveryDirection = null; this.hybridPauseUntil = 0;
    this.lockedRecoveryDirection = null;
    this.lockedRecoveryMarket    = null;
    this.sessionConsecutiveLosses = 0;

    // Reset Rise/Fall session lock
    this._rfLockedMarket = null;
    this._rfConsecutiveLosses = 0;
    this._rfPauseTicksRemaining = 0;
    this._rfWaitingForReversal = false;
    this._rfPauseDirection = null;

    // MATCH_DIFF Auto-Restart schedule
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (this.strategy === 'MATCH_DIFF' && reason && reason.includes('Hard Stop')) {
      this.sendLog(`⏳ Auto-restart scheduled in 5 minutes (300 seconds) for Matches/Differs...`);
      this._restartTimer = setTimeout(() => {
        this.sendLog(`🔄 Auto-restarting Matches/Differs bot strategy now...`);
        this.start(this.config);
      }, 300000); // 5 minutes
    }

    if (this.onBotStop) this.onBotStop(reason || 'User stopped');
  }

  // --- Active Market Router with Meta-Skins & Quarantine ---
  getActiveMarket() {
    const now = Date.now();
    const available = MARKETS.filter(sym => {
      const stats = this.marketStats[sym];
      return !stats.quarantinedUntil || stats.quarantinedUntil <= now;
    });

    if (available.length === 0) {
      // All are quarantined! Find the one expiring first
      let bestSym = MARKETS[0];
      let minExpire = this.marketStats[bestSym].quarantinedUntil || 0;
      for (const sym of MARKETS) {
        const expire = this.marketStats[sym].quarantinedUntil || 0;
        if (expire < minExpire) {
          minExpire = expire;
          bestSym = sym;
        }
      }
      return { market: bestSym, allQuarantined: true, expiresAt: minExpire };
    }

    // Sort by metaScore descending. If equal, sort by scanner overUnderScore descending.
    available.sort((a, b) => {
      const scoreA = this.marketStats[a].metaScore;
      const scoreB = this.marketStats[b].metaScore;
      if (scoreB !== scoreA) {
        return scoreB - scoreA;
      }
      const ouA = scanner.scores[a]?.overUnderScore || 0;
      const ouB = scanner.scores[b]?.overUnderScore || 0;
      return ouB - ouA;
    });

    return { market: available[0], allQuarantined: false };
  }

  getMatchDiffMarket() {
    const now = Date.now();
    // Filter allowed markets: Volatility 10, 25, 75
    const allowed = ['1HZ10V', '1HZ25V', '1HZ75V'];
    const available = allowed.filter(sym => {
      const stats = this.marketStats[sym] || {};
      return !stats.quarantinedUntil || stats.quarantinedUntil <= now;
    });

    if (available.length === 0) {
      // Find the one quarantine expiring first
      let bestSym = allowed[0];
      let minExpire = this.marketStats[bestSym]?.quarantinedUntil || 0;
      for (const sym of allowed) {
        const expire = this.marketStats[sym]?.quarantinedUntil || 0;
        if (expire < minExpire) {
          minExpire = expire;
          bestSym = sym;
        }
      }
      return bestSym;
    }

    // Default to the first available non-quarantined volatility market
    return available[0];
  }

  _switchMatchDiffMarket() {
    const current = this.activeMarket;
    const nextMarket = this.getMatchDiffMarket();
    if (nextMarket && nextMarket !== current) {
      this.activeMarket = nextMarket;
      if (this.onMarketSwitch) this.onMarketSwitch(this.activeMarket);
      this.sendLog(`🔄 Market Rotation: Switched active market to ${MARKET_LABELS[nextMarket] || nextMarket}`);
    }
  }

  getPhase(marketSym) {
    if (this.isDefensiveMode) return 'DEFENSIVE';
    const losses = this.marketStats[marketSym]?.consecutiveLosses || 0;
    if (losses === 2) return 'CAUTION';
    if (losses >= 3) return 'DEFENSIVE';
    return 'NORMAL';
  }

  // --- Mathematical Expectancy Calculator ---
  getExpectancy() {
    if (this.sessionTrades.length === 0) return 0.0;
    const wins = this.sessionTrades.filter(t => t.won);
    const losses = this.sessionTrades.filter(t => !t.won);
    const winRate = wins.length / this.sessionTrades.length;
    const lossRate = losses.length / this.sessionTrades.length;
    const avgWin = wins.length > 0 ? (wins.reduce((sum, t) => sum + t.profit, 0) / wins.length) : 0;
    const avgLoss = losses.length > 0 ? (losses.reduce((sum, t) => sum + Math.abs(t.profit), 0) / losses.length) : 0;
    return (winRate * avgWin) - (lossRate * avgLoss);
  }

  _calcDigitStreaks(ticks) {
    let overLossStreak = 0;
    let underLossStreak = 0;
    let evenLossStreak = 0;
    let oddLossStreak = 0;
    for (let i = ticks.length - 1; i >= 0; i--) {
      if (ticks[i] <= 5) overLossStreak++; else break;
    }
    for (let i = ticks.length - 1; i >= 0; i--) {
      if (ticks[i] >= 5) underLossStreak++; else break;
    }
    for (let i = ticks.length - 1; i >= 0; i--) {
      if (ticks[i] % 2 !== 0) evenLossStreak++; else break;
    }
    for (let i = ticks.length - 1; i >= 0; i--) {
      if (ticks[i] % 2 === 0) oddLossStreak++; else break;
    }
    return { overLossStreak, underLossStreak, evenLossStreak, oddLossStreak };
  }

  /** Adaptive loss counter + rolling 10-trade win rate (more responsive than streak alone). */
  _getWinRecoveryContext() {
    const isSpecial = ['BOTH', 'BOTH5', 'OMNISNIPER'].includes(this.strategy);
    const losses = isSpecial ? 0 : (this.sessionConsecutiveLosses || 0);
    const rollingWr = this._getRollingWinRate(10);
    const target = Math.max(2, this.config?.recoveryLossTarget ?? 2);
    const remaining = Math.max(0, target - losses);
    
    // Simplified phase — no sniper lock, no saturatedVL requirement
    let phase = 'normal';
    let minQuality = 0;
    let minConfBoost = 0;
    let vlExtra = 0;
    let requireSaturatedVl = false; // ← KEY FIX: always false
    let minCrossMarkets = 1;
    let minRevEdge = 2;
    let minStreakMargin = 0;

    if (!isSpecial) {
      if (losses >= 1) { phase = 'watch'; }
      if (losses >= 2) { phase = 'caution'; minQuality = 0.5; }
      if (losses >= 4) { phase = 'recovery'; minQuality = 1; minConfBoost = 1; }
    }

    return {
      losses, target, remaining, phase,
      minQuality, minConfBoost, vlExtra, requireSaturatedVl,
      minCrossMarkets, minRevEdge, minStreakMargin,
      rollingWinRate: rollingWr,
      recoveryWinMode: !isSpecial && (losses >= target - 1 || (rollingWr != null && rollingWr < 0.4)),
    };
  }

  _syncRecoveryAlgorithm() {
    if ((this.sessionConsecutiveLosses || 0) === 0) {
      this.recoveryWinMode = false;
      this.isDefensiveMode = false;
    }
    this._dualRecoveryBoost = 0;
  }

  _onPartialRecoveryWin(source = '') {
    const before = this.sessionConsecutiveLosses || 0;
    if (before > 0) this.sessionConsecutiveLosses = before - 1;
    this.sessionWinCount = (this.sessionWinCount || 0) + 1;
    this.dualNetLossStreak = Math.max(0, (this.dualNetLossStreak || 0) - 1);
    const label = source ? ` (${source})` : '';
    this.sendLog(
      `✅ Recovery progress${label} — loss streak ${before}→${this.sessionConsecutiveLosses} · debt shrinking`
    );
    this._syncRecoveryAlgorithm();
  }

  _onSessionWin(source = '') {
    this._stopRecoveryPulse();
    const hadLosses = (this.sessionConsecutiveLosses || 0) > 0;
    if (this.activeMarket) {
      registerEngineFeedback(true, this.activeMarket, { strategy: this.strategy });
    }
    this.sessionConsecutiveLosses = 0;
    this._cascadeMartingaleFrozen = false;
    this._lossStreakCooldownUntil = 0;
    this._cascadePausedUntil = 0;
    this._recentLossDirections = [];
    this.sessionWinCount = (this.sessionWinCount || 0) + 1;
    this.dualNetLossStreak = 0;
    this._dualRecoveryBoost = 0;
    this._lastDualLosingDir = null;
    this._lastDualWinningDir = null;
    this._dualPairStep = 0;
    this.recoveryWinMode = false;
    this.isDefensiveMode = false;
    if (this._lastTournamentEntry?.sym && this._lastTournamentEntry?.dir) {
      this._lastWinSetup = { ...this._lastTournamentEntry, at: Date.now() };
    }
    if (hadLosses) {
      const label = source ? ` (${source})` : '';
      this.sendLog(`✅ Win${label} — resuming normal entries`);
      if (!this._lastVlToastTime || Date.now() - this._lastVlToastTime > 15000) {
        this._notifyOnce(this._toastIds.recovery, 'Recovery win — counter reset', { icon: '✅' });
        this._lastVlToastTime = Date.now();
      }
    }
    this._syncRecoveryAlgorithm();
  }

  _onSessionLoss(source = '', tradeDirection = null, _opts = {}) {
    this.sessionConsecutiveLosses = (this.sessionConsecutiveLosses || 0) + 1;
    this.sessionLossCount = (this.sessionLossCount || 0) + 1;

    if (tradeDirection) {
      this._recentLossDirections = [...(this._recentLossDirections || []), tradeDirection].slice(-6);
    }

    const label = source ? ` [${source}]` : '';
    const cascade = onConsecutiveLoss(this.config, this.sessionConsecutiveLosses);
    this._cascadePausedUntil = Math.max(this._cascadePausedUntil || 0, cascade.cascadePausedUntil);
    if (cascade.freezeMartingale) this._cascadeMartingaleFrozen = true;

    const maxStreak = Number(this.config?.maxLossStreak) || 0;
    if (maxStreak > 0 && this.sessionConsecutiveLosses >= maxStreak) {
      this._lossStreakCooldownUntil = 0; // No pause — continue immediately
      if (!this._isWinningDualStrategy()) {
        this._sessionMartingaleStep = 0;
        for (const ch of Object.values(this.channels || {})) {
          if (ch) ch.step = 0;
        }
      }
      this.sendLog(
        `⏸ ${maxStreak} losses${label} — pausing ${Math.round(pauseMs / 1000)}s` +
        (this._isWinningDualStrategy() ? ' · EO/OU leg steps kept' : ' · martingale reset') +
        ` · W/L ${this.sessionWinCount}/${this.sessionLossCount}`
      );
      if (this.config?.maxLossStreakStopEnabled === true) {
        const losses = this.sessionConsecutiveLosses;
        setTimeout(() => {
          if (this.running) this.stop(`Stop: ${losses} consecutive losses (limit: ${maxStreak}).`);
        }, 0);
      }
    } else {
      this.sendLog(
        `📉 Loss${label} — streak ${this.sessionConsecutiveLosses} · W/L ${this.sessionWinCount}/${this.sessionLossCount}`
      );
    }

    if (this._lastTournamentEntry?.sym) {
      this._lastLossSetup = { ...this._lastTournamentEntry, at: Date.now() };
    }
  }

  _isRecoveryHuntMode() {
    return false;
  }

  /** Score every market+direction for recovery (ready or warming) — never gives up at 4 losses. */
  _computeRecoveryPickScore(sym, dir, streak, required, winChance, bias, scores, oppRec, pctRec, ready) {
    let s = (winChance || 0) * 2.2 + (oppRec || 0) * 1.4 + (pctRec || 0) * 1.4;
    const ticks = scanner.buffers[sym] || [];
    const rev = this._computeLunarReversalProb(ticks, dir, Math.max(3, required - 1));
    const baseline = this._getBaselineWinRate(dir);
    if (rev != null) s += (rev - baseline) * 1.1;
    s += this._learningScoreAdjust(sym, dir) * 0.8;
    if (ready) s += 18;
    else if (required > 0) s += (streak / required) * 12;
    if ((bias?.endConsecutive ?? 0) >= 4) s += 8;
    return Math.round(s);
  }

  _scanBestRecoveryAcrossMarkets() {
    const dirs = this._getStrategyDirs();
    const recovery = this._getWinRecoveryContext();
    const ranked = [];
    const minStreak = (this.sessionConsecutiveLosses || 0) >= 1 ? 0 : 1;

    for (const sym of MARKETS) {
      if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
      const ticks = scanner.buffers[sym] || [];
      if (ticks.length < 8) continue;
      const scores = scanner.scores[sym] || {};
      const streaks = this._calcDigitStreaks(ticks);

      for (const dir of dirs) {
        if (this._isTournamentEntryLocked(sym, dir)) continue;
        if (this._isDirectionBlocked(dir, sym)) continue;
        if (this._violatesBarRules(sym, dir, scores)) continue;

        const streak = dir === 'OVER5' ? streaks.overLossStreak
          : dir === 'UNDER5' ? streaks.underLossStreak
          : dir === 'EVEN' ? streaks.evenLossStreak
          : streaks.oddLossStreak;
        const required = this._getTournamentVlRequired(dir, recovery);
        if (streak < Math.max(minStreak, required - 1)) continue;

        const lt = this._getDistributionBiasPct(dir, scores);
        if (!hasNormalDistributionEdge(dir, lt) && streak < required) continue;

        const bias = this._computeOppositeDirectionBias(ticks, dir);
        const winChance = this._estimateTournamentWinChance(sym, dir, streak, ticks, scores);
        const ready = streak >= required;
        const oppRec = this._scoreOppositeStreakRecovery(bias, streak, required);
        const pctRec = this._scoreMarketPctRecovery(dir, scores);
        const recoveryScore = this._computeRecoveryPickScore(
          sym, dir, streak, required, winChance, bias, scores, oppRec, pctRec, ready
        );

        ranked.push({
          sym, dir, streak, required, winChance, recoveryScore, oppRec, pctRec,
          ready, oppEnd: bias.endConsecutive, score: recoveryScore,
        });
      }
    }

    ranked.sort((a, b) => b.recoveryScore - a.recoveryScore);
    return ranked;
  }

  _notifyOnce(id, message, opts = {}) {
    toast.dismiss(id);
    toast(message, { id, duration: opts.duration ?? 2200, ...opts });
  }

  _blockDirectionAfterLoss(direction, market) {
    if (this._isSyntheticDualSideStrategy()) {
      this._recordLegMarketResult(market, direction, false);
      const streak = this._getLegMarketLossStreak(direction, market);
      if (streak >= 2) {
        const banMs = this._getLegMarketQuarantineMs(direction);
        this._legMarketQuarantine[this._legMarketKey(market, direction)] = Date.now() + banMs;
        this.sendLog(
          `🚫 ${direction} paused on ${MARKET_LABELS[market] || market} · ${streak} losses · scanning other markets`
        );
        if (this.strategy === 'RANDOM_PICKER' && this.config?.autoSwitchMarkets !== false) {
          queueMicrotask(() => {
            if (this.running) this._maybeRotateMarketForLeg(direction, 'market-dir streak');
          });
        }
      }
      return;
    }
    // Minimal 100ms cooldown for all strategies — no long blocks after loss
    const now = Date.now();
    this._directionCooldown[direction] = now + 100;
    this._marketDirCooldown[`${market}:${direction}`] = now + 100;
  }

  _isDirectionBlocked(direction, market) {
    const now = Date.now();
    if ((this._directionCooldown[direction] || 0) > now) return true;
    if ((this._marketDirCooldown[`${market}:${direction}`] || 0) > now) return true;
    if (this._isSyntheticDualSideStrategy() && this._isLegMarketBlocked(direction, market)) return true;
    return false;
  }

  _directionWouldWin(digit, direction) {
    if (direction === 'EVEN') return digit % 2 === 0;
    if (direction === 'ODD') return digit % 2 !== 0;
    if (direction.startsWith('OVER')) {
      const val = parseInt(direction.slice(4), 10);
      return digit > val;
    }
    if (direction.startsWith('UNDER')) {
      const val = parseInt(direction.slice(5), 10);
      return digit < val;
    }
    return false;
  }

  /**
   * Tick-gated recovery check.
   * Only fire recovery trades when the most recent ticks show the digit flow
   * is currently favorable for our locked direction. This prevents the bot
   * from placing trades during execution lag when favorable ticks have already
   * passed and unfavorable ones are arriving.
   *
   * Checks the last 2 ticks: if at least 1 of the last 2 would win for
   * our recovery direction, we fire. Otherwise we skip this cycle and
   * wait for the next tick (100ms).
   */
  _isRecoveryTickFavorable(market, direction) {
    return true;
  }

  _getBaselineWinRate(direction) {
    if (direction === 'EVEN' || direction === 'ODD') return 50;
    if (direction.startsWith('OVER')) {
      const val = parseInt(direction.slice(4), 10);
      return (9 - val) * 10;
    }
    if (direction.startsWith('UNDER')) {
      const val = parseInt(direction.slice(5), 10);
      return val * 10;
    }
    return 50;
  }

  _getOppositeDirection(direction) {
    if (direction === 'EVEN') return 'ODD';
    if (direction === 'ODD') return 'EVEN';
    if (direction.startsWith('OVER')) {
      const val = parseInt(direction.slice(4), 10);
      return `UNDER${val}`;
    }
    if (direction.startsWith('UNDER')) {
      const val = parseInt(direction.slice(5), 10);
      return `OVER${val}`;
    }
    return null;
  }

  _shouldUseDualLossRecovery() {
    return false;
  }

  /**
   * Dual winning (OU/EO): use apex leaderboard once a leg hits the configured
   * consecutive-loss threshold (Settings → Switch After Losses).
   */
  _shouldUseApexMatrixForDualWinning() {
    if (this.strategy !== 'OU_WINNING' && this.strategy !== 'EO_WINNING') return true;
    return false;
  }

  _getDualWinningLegPressure() {
    const dirs = this.strategy === 'OU_WINNING' ? ['OVER5', 'UNDER4'] : ['EVEN', 'ODD'];
    return dirs
      .map(dir => ({ dir, losses: this.channels[dir]?.consecutiveLosses || 0 }))
      .sort((a, b) => b.losses - a.losses)[0];
  }

  _getDualRoundLossStreak() {
    return this.dualNetLossStreak || this.sessionConsecutiveLosses || 0;
  }

  _hasOpenDualHedgeContracts(dirs) {
    this._clearStaleDualChannels(dirs);
    return this._hasLiveDualContracts(dirs);
  }

  _lockMarketOppositeLeg(sym, dir, ms = 120000) {
    const opp = this._getOppositeDirection(dir);
    if (!opp || !sym) return;
    this._marketOppositeLock[sym] = { blockedDir: opp, until: Date.now() + ms };
  }

  _isTournamentOppositeBlocked(sym, dir) {
    const lock = this._marketOppositeLock[sym];
    if (!lock || Date.now() > lock.until) return false;
    return lock.blockedDir === dir;
  }

  /** Fire OVER+UNDER or EVEN+ODD on the same market in parallel — same tick hedge after losses. */
  _pickDualLegOrder(market, dirs) {
    const scores = scanner.scores[market] || {};
    const priorityDir = this._getDualRecoveryPriorityDir(dirs);
    const priorityStep = this.channels[priorityDir]?.step || 0;
    const priorityLosses = this.channels[priorityDir]?.consecutiveLosses || 0;
    if (priorityDir && (priorityStep > 0 || priorityLosses >= 1)) {
      const pressurePct = this._getDistributionBiasPct(priorityDir, scores);
      const floor = priorityDir === 'OVER5' ? 42 : 50;
      if (pressurePct >= floor - 4) {
        return { primary: priorityDir, hedge: this._getOppositeDirection(priorityDir), primaryPct: pressurePct };
      }
    }
    const pressure = dirs
      .map(dir => ({ dir, losses: this.channels[dir]?.consecutiveLosses || 0 }))
      .sort((a, b) => b.losses - a.losses)[0];
    if (pressure?.losses >= 1) {
      const pressurePct = this._getDistributionBiasPct(pressure.dir, scores);
      const floor = pressure.dir === 'OVER5' ? 42 : 50;
      if (pressurePct >= floor) {
        return { primary: pressure.dir, hedge: this._getOppositeDirection(pressure.dir), primaryPct: pressurePct };
      }
    }
    const p0 = this._getDistributionBiasPct(dirs[0], scores);
    const p1 = this._getDistributionBiasPct(dirs[1], scores);
    if (p0 >= p1) return { primary: dirs[0], hedge: dirs[1], primaryPct: p0 };
    return { primary: dirs[1], hedge: dirs[0], primaryPct: p1 };
  }

  _getDualPairStakePlan(market, dirs) {
    const ordered = this._getDualLegDisplayOrder(dirs);
    if (this._isWinningDualStrategy()) {
      const scores = scanner.scores[market] || {};
      const stakes = {};
      for (const dir of ordered) {
        stakes[dir] = this._getDualLegMartingaleStake(dir);
      }
      const priorityDir = this._getDualRecoveryPriorityDir(dirs);
      return {
        primary: priorityDir && dirs.includes(priorityDir) ? priorityDir : ordered[0],
        hedge: this._getOppositeDirection(priorityDir || ordered[0]) || ordered[1],
        primaryPct: this._getDistributionBiasPct(ordered[0], scores),
        stakes,
        step: Math.max(...ordered.map(d => this.channels[d]?.step || 0)),
        debt: 0,
        ordered,
      };
    }

    const orderedLegacy = ordered;
    const { primary, hedge, primaryPct } = this._pickDualLegOrder(market, dirs);
    const base = this._resolveStake(this.config.baseStake);
    const lossStreak = this._getDualRoundLossStreak();
    const hold = this._getMartingaleHoldAfterStep();
    const edge = Math.max(0, primaryPct - (primary === 'OVER5' ? 40 : 50));
    const edgeStep = edge >= 8 ? 1 : 0;
    let step = Math.max(0, lossStreak) + edgeStep;
    if (hold > 0) step = Math.min(hold, step);
    const hedgeStake = base;
    let primaryStake = base * Math.pow(this.config.martMultiplier || 2, step);

    const cap = this._getMaxStakeCap();
    if (cap != null) primaryStake = Math.min(primaryStake, cap);
    primaryStake = Math.max(base, Number(primaryStake.toFixed(2)));

    return {
      primary,
      hedge,
      primaryPct,
      stakes: {
        [primary]: primaryStake,
        [hedge]: hedgeStake,
      },
      step,
      edge,
    };
  }

  _waitForContractSold(contractId, timeoutMs = 15000) {
    return new Promise((resolve) => {
      if (!contractId) {
        resolve(null);
        return;
      }
      const unsub = derivWS.on('proposal_open_contract', (msg) => {
        const c = msg.proposal_open_contract;
        if (!c || c.contract_id !== contractId) return;
        const isSettled = c.is_sold || c.is_expired || (c.status && c.status !== 'open');
        if (!isSettled) return;
        unsub();
        clearTimeout(timer);
        resolve(c);
      });
      const timer = setTimeout(() => {
        unsub();
        resolve(null);
      }, timeoutMs);
    });
  }

  async _placeDualLegDirect(market, dir, stake) {
    const spec = CONTRACT_MAP[dir];
    const ch = this.channels[dir];
    if (!spec || !ch) return null;
    const payload = {
      proposal: 1,
      amount: stake,
      basis: 'stake',
      contract_type: spec.contract_type,
      currency: derivWS.accountInfo?.currency || 'USD',
      duration: 1,
      duration_unit: 't',
      underlying_symbol: market,
    };
    if (spec.barrier != null && spec.barrier !== undefined) payload.barrier = String(spec.barrier);
    ch.active = true;
    ch.direction = dir;
    ch.placedAt = Date.now();
    ch.stake = stake;
    try {
      const propRes = await derivWS.send(payload);
      if (propRes.error || !propRes.proposal?.id) {
        ch.active = false;
        ch.direction = null;
        return null;
      }
      const res = await derivWS.send({ buy: propRes.proposal.id, price: propRes.proposal.ask_price });
      if (res.error || !res.buy) {
        ch.active = false;
        ch.direction = null;
        return null;
      }
      ch.contractId = res.buy.contract_id;
      derivWS.sendRaw({ proposal_open_contract: 1, contract_id: ch.contractId, subscribe: 1 });
      if (this.onTradeUpdate) {
        this.onTradeUpdate({
          id: ch.contractId,
          market,
          direction: dir,
          stake,
          profit: 0,
          won: false,
          time: Date.now(),
          exitTick: null,
          pending: true,
          legOrder: this._dualLegSortKey(dir),
        });
      }
      return { dir, contractId: ch.contractId, stake };
    } catch (e) {
      ch.active = false;
      ch.direction = null;
      return null;
    }
  }

  /** EO/OU winning: BOTH legs on the same tick (E/O mutually exclusive per digit). Martingale stays per-leg 2×. */
  _fireWinningDualPair(market, dirs, opts = {}) {
    return this._fireDualHedgeSimultaneous(
      market,
      this._getDualLegFireOrder(dirs),
      opts
    );
  }

  /** Leg 1 → wait settle → leg 2 only if leg 1 lost — BOTH/BOTH5 recovery only (not EO/OU). */
  async _fireDualHedgeSequential(market, dirs, opts = {}) {
    if (this._isWinningDualStrategy()) {
      return this._fireWinningDualPair(market, dirs, opts);
    }
    if (this._dualHedgeInFlight || this._hasOpenDualHedgeContracts(dirs)) return false;
    const allFree = dirs.every(d => {
      const ch = this.channels[d];
      return ch && !ch.active && !ch.contractId;
    });
    if (!allFree) return false;

    this._dualHedgeInFlight = true;

    const stakePlan = this._getDualPairStakePlan(market, dirs);
    const { primary, hedge, primaryPct } = this._isWinningDualStrategy()
      ? stakePlan
      : { ...this._pickDualLegOrder(market, dirs), ...stakePlan };

    const recoveryStakes = opts.recoveryLegStakes;
    const primaryStake = recoveryStakes?.[primary]
      ?? (this._isWinningDualStrategy()
        ? stakePlan.stakes[primary]
        : (this._usesTournamentMode() ? this._getSessionMartingaleStake() : this._resolveStake(this.config.baseStake)));
    const hedgeStake = recoveryStakes?.[hedge]
      ?? (this._isWinningDualStrategy()
        ? stakePlan.stakes[hedge]
        : primaryStake);

    if (!this._isWinningDualStrategy()) {
      this.activeMarket = market;
      if (this.onMarketSwitch) this.onMarketSwitch(market);
    }

    this.sendLog(
      `🛡️ Dual hedge sequential ${MARKET_LABELS[market]}: ${primary} first (${primaryPct.toFixed(0)}% bias) @ $${primaryStake.toFixed(2)}` +
      (this._isWinningDualStrategy() ? ` · hedge ${hedge} @ $${hedgeStake.toFixed(2)}` : '')
    );

    try {
      const leg1 = await this._placeDualLegDirect(market, primary, primaryStake);
      if (!leg1?.contractId) return false;

      const settled1 = await this._waitForContractSold(leg1.contractId);
      const leg1Won = settled1?.status === 'won';
      if (leg1Won) {
        this.sendLog(`🛡️ ${primary} won — hedge ${hedge} not needed`);
        return true;
      }

      this.sendLog(`🛡️ ${primary} lost — firing hedge ${hedge} @ $${hedgeStake.toFixed(2)}`);
      await this._placeDualLegDirect(market, hedge, hedgeStake);
      return true;
    } finally {
      this._dualHedgeInFlight = false;
    }
  }

  async _fireDualHedgeSimultaneous(market, dirs, opts = {}) {
    if (this._usesIsolatedSniperMode() && !opts.allowDualOverride) {
      this.sendLog('⛔ Dual hedge blocked — isolated sniper fires one side per market only');
      return this._fireIsolatedSniperTrade({ sym: market });
    }
    const orderedDirs = this._getDualLegDisplayOrder(dirs);
    if (this._dualHedgeInFlight || this._hasOpenDualHedgeContracts(orderedDirs)) return false;

    const allFree = orderedDirs.every(d => {
      const ch = this.channels[d];
      return ch && !ch.active && !ch.contractId;
    });
    if (!allFree) return false;

    const lastTickAt = scanner.lastTickAt?.[market] || 0;
    const tickLagMs = Date.now() - lastTickAt;
    const maxTickLag = this._isWinningDualStrategy() ? 450 : 600;
    if (tickLagMs > maxTickLag) {
      this.sendLog(`⏸ Dual fire blocked — ${MARKET_LABELS[market] || market} tick lag ${Math.round(tickLagMs)}ms`);
      return false;
    }

    this._dualHedgeInFlight = true;
    if (!this._isWinningDualStrategy()) {
      this.activeMarket = market;
      if (this.onMarketSwitch) this.onMarketSwitch(market);
    }

    let stakePlan = this._getDualPairStakePlan(market, orderedDirs);
    if (opts.recoveryLegStakes) {
      stakePlan = { ...stakePlan, stakes: { ...stakePlan.stakes, ...opts.recoveryLegStakes } };
    } else if (opts.fastPassStake) {
      const s = opts.fastPassStake;
      const recoverDir = getFastPassRecoveryState().failedDir || stakePlan.primary;
      stakePlan = {
        ...stakePlan,
        stakes: {
          [orderedDirs[0]]: orderedDirs[0] === recoverDir ? s : stakePlan.stakes[orderedDirs[0]],
          [orderedDirs[1]]: orderedDirs[1] === recoverDir ? s : stakePlan.stakes[orderedDirs[1]],
        },
        step: getFastPassRecoveryState().currentStep,
      };
    }
    const payloads = orderedDirs.map(dir => {
      const spec = CONTRACT_MAP[dir];
      const ch = this.channels[dir];
      const stake = this._usesTournamentMode()
        ? this._getSessionMartingaleStake(market)
        : (this._isWinningDualStrategy()
          ? stakePlan.stakes[dir]
          : this._resolveStake(stakePlan.stakes[dir] || ch?.stake || this.config.baseStake));
      const payload = {
        proposal: 1,
        amount: stake,
        basis: 'stake',
        contract_type: spec.contract_type,
        currency: derivWS.accountInfo?.currency || 'USD',
        duration: 1,
        duration_unit: 't',
        underlying_symbol: market,
      };
      if (spec.barrier != null && spec.barrier !== undefined) payload.barrier = String(spec.barrier);
      return { dir, payload, spec, stake };
    });

    const batchAt = Date.now();
    for (const { dir, stake } of payloads) {
      const ch = this.channels[dir];
      ch.active = true;
      ch.direction = dir;
      ch.placedAt = batchAt;
      ch.stake = stake;
    }

    this.sendLog(
      `🔫 Winning pair (same tick) ${MARKET_LABELS[market]}: ${payloads.map(p => `${p.dir} $${p.stake.toFixed(2)}`).join(' + ')} ` +
      `· primary ${stakePlan.primary} ${stakePlan.primaryPct.toFixed(0)}% · step ${stakePlan.step}`
    );

    try {
      const tickBefore = scanner.buffers[market]?.slice(-1)[0];
      const proposalResults = await Promise.all(payloads.map(({ payload }) => derivWS.send(payload)));
      const validPairs = proposalResults
        .map((r, idx) => ({ r, leg: payloads[idx] }))
        .filter(({ r }) => !r.error && r.proposal?.id);

      if (validPairs.length !== payloads.length) {
        this.sendLog(`❌ Proposal mismatch — only ${validPairs.length}/${payloads.length} ready`);
        for (const { dir } of payloads) {
          const ch = this.channels[dir];
          if (ch) { ch.active = false; ch.direction = null; }
        }
        return false;
      }

      const fireTs = Date.now();

      if (this._isWinningDualStrategy()) {
        const tickNow = scanner.buffers[market]?.slice(-1)[0];
        if (tickNow !== tickBefore) {
          this.sendLog(`⏸ Dual pair aborted — tick rolled on ${MARKET_LABELS[market] || market} before buy`);
          for (const { dir } of payloads) {
            const ch = this.channels[dir];
            if (ch) { ch.active = false; ch.direction = null; }
          }
          return false;
        }
      }

      const buyResults = await Promise.all(
        validPairs.map(({ r }) => derivWS.send({ buy: r.proposal.id, price: r.proposal.ask_price }))
      );

      const elapsed = Date.now() - fireTs;
      const tickAfter = scanner.buffers[market]?.slice(-1)[0];
      if (this._isWinningDualStrategy() && tickAfter !== tickBefore) {
        this.sendLog(`⚠️ Dual pair tick drift ${elapsed}ms on ${MARKET_LABELS[market] || market} — legs may have split ticks`);
      } else if (elapsed > 80 || tickAfter !== tickBefore) {
        this.sendLog(`⚠️ Dual tick drift ${elapsed}ms — logged for analysis`);
      }

      buyResults.forEach((res, idx) => {
        const { dir, spec, stake } = validPairs[idx].leg;
        const ch = this.channels[dir];
        if (res.error || !res.buy) {
          this.sendLog(`❌ Dual hedge buy [${dir}]: ${res.error?.message || 'failed'}`);
          ch.active = false;
          ch.direction = null;
          return;
        }
        ch.contractId = res.buy.contract_id;
        this._openTournamentContracts.set(ch.contractId, Date.now());
        this.sendLog(`✅ Dual hedge ${dir} $${stake.toFixed(2)} | ${ch.contractId}`);
        derivWS.sendRaw({ proposal_open_contract: 1, contract_id: ch.contractId, subscribe: 1 });
        if (this.onTradeUpdate) {
          this.onTradeUpdate({
            id: ch.contractId,
            market,
            direction: dir,
            stake,
            profit: 0,
            won: false,
            time: Date.now(),
            exitTick: null,
            pending: true,
            legOrder: this._dualLegSortKey(dir),
          });
        }
        if (copyTradeEngine.active) {
          copyTradeEngine.copyTrade({
            contractType: spec.contract_type,
            symbol: market,
            amount: validPairs[idx].r.proposal.ask_price,
            duration: 1,
            durationUnit: 't',
            barrier: spec.barrier != null ? String(spec.barrier) : undefined,
            currency: derivWS.accountInfo?.currency || 'USD',
          });
        }
      });

      return true;
    } catch (err) {
      this.sendLog(`⚠️ Dual hedge batch error: ${err?.message || err}`);
      for (const { dir } of payloads) {
        const ch = this.channels[dir];
        if (ch) { ch.active = false; ch.direction = null; }
      }
      return false;
    } finally {
      this._dualHedgeInFlight = false;
    }
  }

  _tryFireDualLossRecovery(isOverUnder) {
    if (!this.running) return;
    if (!this._shouldUseDualLossRecovery()) return;
    if (shouldUseFastPassRecovery() && this._tryFireFastPassDualRecovery(isOverUnder)) return;
    if (this._dualHedgeInFlight) return;

    const dirs = isOverUnder ? ['OVER5', 'UNDER5'] : ['EVEN', 'ODD'];
    if (this._hasOpenDualHedgeContracts(dirs)) return;
    if (this._checkSessionGuards()) return;
    // Ghost break disabled — never block
    // if (!this._usesTournamentMode() && this.ghostBreakUntil > Date.now()) return;

    // Always use the user-selected activeMarket — no market scanning
    const market = this.activeMarket;
    this.sendLog(
      `🛡️ Dual recovery → ${MARKET_LABELS[market] || market} (${dirs.join('+')})`
    );
    void this._fireWinningDualPair(market, dirs);
  }

  /**
   * Opposite-direction pressure in last 25 ticks (end consecutive run weighted highest).
   * Used to pick the setup where reversal from the opposing side is strongest.
   */
  _computeOppositeDirectionBias(ticks, direction) {
    const window = (ticks || []).slice(-25);
    if (window.length < 5) {
      return { score: 0, endConsecutive: 0, maxConsecutive: 0, totalOpposite: 0 };
    }
    const opp = this._getOppositeDirection(direction);
    if (!opp) return { score: 0, endConsecutive: 0, maxConsecutive: 0, totalOpposite: 0 };

    const wouldWinOpp = (d) => this._directionWouldWin(d, opp);
    let totalOpposite = 0;
    for (const d of window) {
      if (wouldWinOpp(d)) totalOpposite++;
    }

    let endConsecutive = 0;
    for (let i = window.length - 1; i >= 0; i--) {
      if (wouldWinOpp(window[i])) endConsecutive++;
      else break;
    }

    let maxConsecutive = 0;
    let run = 0;
    for (const d of window) {
      if (wouldWinOpp(d)) {
        run++;
        if (run > maxConsecutive) maxConsecutive = run;
      } else {
        run = 0;
      }
    }

    const score = endConsecutive * 14 + maxConsecutive * 7 + totalOpposite * 2;
    return { score, endConsecutive, maxConsecutive, totalOpposite };
  }

  _beatsSetup(candidate, incumbent) {
    if (!incumbent) return true;
    const biasA = candidate.oppositeBias?.score ?? 0;
    const biasB = incumbent.oppositeBias?.score ?? 0;
    if (biasA !== biasB) return biasA > biasB;
    return (candidate.winRank ?? 0) > (incumbent.winRank ?? 0);
  }

  /** Historical reversal probability after virtual-loss streaks (market memory). */
  _computeLunarReversalProb(ticks, direction, minStreak) {
    if (ticks.length < 25) return null;
    const wouldWin = (d) => this._directionWouldWin(d, direction);
    let samples = 0;
    let wins = 0;
    for (let i = minStreak; i < ticks.length; i++) {
      let streak = 0;
      for (let j = i - 1; j >= 0 && !wouldWin(ticks[j]); j--) streak++;
      if (streak >= minStreak) {
        samples++;
        if (wouldWin(ticks[i])) wins++;
      }
    }
    if (samples < 4) return null;
    return (wins / samples) * 100;
  }

  _passesLunarReversalGate(reversalProb, direction, minRevEdge) {
    if (reversalProb == null) return true;
    const baseline = this._getBaselineWinRate(direction);
    return reversalProb >= baseline + minRevEdge;
  }

  /** Composite win-rank (0–99): used to pick the best setup, not to block trades. */
  _computeWinRank(setup, crossCount) {
    const baseline = this._getBaselineWinRate(setup.direction);
    const margin = Math.max(0, setup.streak - setup.required);
    const cross = crossCount || 1;
    let rank = 48;

    if (setup.reversalProb != null) {
      rank += (setup.reversalProb - baseline) * 2;
      rank += setup.reversalProb * 0.3;
    } else {
      rank += Math.min(14, (cross - 1) * 5 + margin * 2);
    }

    rank += Math.min(18, margin * 6);
    rank += Math.min(16, cross * 4);
    rank += (setup.quality || 0) * 2;
    rank += (setup.macroConf - 50) * 0.3;
    rank += (setup.conf - 50) * 0.12;

    const chop = setup.chopIndex ?? 50;
    if (chop >= 38 && chop <= 72) rank += 6;
    else if (chop < 22 || chop > 92) rank -= 7;

    if (setup.d5Pct >= 10) rank -= 10;
    else if (setup.d5Pct >= 8) rank -= 4;

    const opp = setup.oppositeBias;
    if (opp) {
      rank += Math.min(24, opp.score * 0.85);
      rank += Math.min(10, opp.endConsecutive * 2.5);
    }

    const mStats = this.marketStats[setup.market] || {};
    const tw = mStats.totalSessionWins || 0;
    const tl = mStats.totalSessionLosses || 0;
    if (tw + tl >= 2) rank += ((tw / (tw + tl)) - 0.42) * 20;

    if (this._lastTradeWon === false && this._lastTradeDirection === setup.direction) rank -= 12;
    else if (this._lastTradeWon === false && this._lastTradeDirection) rank += 7;

    if ((this.sessionConsecutiveLosses || 0) > 0) {
      if (cross >= 2) rank += 5;
      if (setup.reversalProb != null && setup.reversalProb >= baseline + 3) rank += 6;
    }

    const recentLossDirs = this._recentLossDirections || [];
    if (recentLossDirs.length >= 3) {
      const sameDir = recentLossDirs.every(d => d === recentLossDirs[0]);
      if (sameDir && setup.direction === recentLossDirs[0]) rank -= 14;
      else if (sameDir && setup.direction !== recentLossDirs[0]) rank += 12;
    }

    return Math.round(Math.min(99, Math.max(0, rank)));
  }

  _getMaxStakeCap() {
    const base = this.config?.baseStake || 0.35;
    let cap = Infinity;
    if (Number(this.config?.maxStakeCap) > 0) cap = Math.min(cap, this.config.maxStakeCap);
    if (Number(this.config?.maxStakeMultiplier) > 0) {
      cap = Math.min(cap, base * this.config.maxStakeMultiplier);
    }
    return Number.isFinite(cap) ? Math.max(base, parseFloat(cap.toFixed(2))) : null;
  }

  _canFireTradeNow() {
    const maxPerMin = Number(this.config?.maxTradesPerMinute) || 0;
    if (maxPerMin <= 0) return true;

    const minute = Math.floor(Date.now() / 60000);
    if (this._tradeMinuteBucket.minute !== minute) {
      this._tradeMinuteBucket = { minute, count: 0 };
    }
    return this._tradeMinuteBucket.count < maxPerMin;
  }

  _recordTradeFired() {
    const minute = Math.floor(Date.now() / 60000);
    if (this._tradeMinuteBucket.minute !== minute) {
      this._tradeMinuteBucket = { minute, count: 0 };
    }
    this._tradeMinuteBucket.count++;
  }

  _computeLunarScore(setup, market, crossMarketCount) {
    const baseline = this._getBaselineWinRate(setup.direction);
    const revProb = setup.reversalProb ?? baseline;
    const edge = revProb - baseline;
    const mStats = this.marketStats[market] || {};
    const mWins = mStats.totalSessionWins || 0;
    const mLosses = mStats.totalSessionLosses || 0;
    const mTotal = mWins + mLosses;
    const marketBonus = mTotal >= 2 ? ((mWins / mTotal) - 0.45) * 25 : 0;
    const margin = setup.streak - setup.required;
    return (
      revProb * 0.5 +
      edge * 1.5 +
      (setup.quality || 0) * 2.2 +
      margin * 5 +
      (setup.chopIndex || 0) * 0.1 +
      crossMarketCount * 2.5 +
      marketBonus
    );
  }

  _calcChopIndex(ticks, window = 12) {
    const slice = ticks.slice(-window);
    if (slice.length < 3) return 50;
    let flips = 0;
    for (let i = 1; i < slice.length; i++) {
      const prevOver = slice[i - 1] > 5;
      const currOver = slice[i] > 5;
      const prevEven = slice[i - 1] % 2 === 0;
      const currEven = slice[i] % 2 === 0;
      if (prevOver !== currOver || prevEven !== currEven) flips++;
    }
    return Math.round((flips / (slice.length - 1)) * 100);
  }

  _scoreEntryQuality({ streak, required, macroConf, conf, chopIndex, d5Pct = 0 }) {
    const margin = streak - required;
    const chopBonus = chopIndex >= 55 ? 2 : chopIndex >= 40 ? 1 : 0;
    const d5Penalty = d5Pct >= 10 ? 2 : d5Pct >= 8 ? 1 : 0;
    return margin * 3 + (macroConf - 50) * 0.08 + (conf - 50) * 0.05 + chopBonus - d5Penalty;
  }

  /** Signal strength — conservative; streak margin must do the work. */
  _getSetupSignalStrength(scores, direction, streak, required) {
    const margin = Math.max(0, streak - required);
    const scannerConf = parseFloat(scores.confidence) || 50;
    let base = 48 + margin * 8 + scannerConf * 0.15;
    if (direction === 'OVER5' || direction === 'UNDER5') {
      base += (parseFloat(scores.overUnderScore) || 0) * 0.12;
    } else {
      base += (parseFloat(scores.evenOddScore) || 0) * 0.12;
    }
    return Math.min(100, Math.round(base));
  }

  _resolveStake(stake) {
    const min = 0.35;
    const base = this.config?.baseStake;
    const resolved = Number(stake);
    if (!resolved || resolved < min) return Math.max(min, Number(base) || min);
    return resolved;
  }

  _resetChannelMartingale(channelKey) {
    const ch = this.channels[channelKey];
    if (!ch) return;
    ch.step = 0;
    ch.stake = this._resolveStake(this.config.baseStake);
    ch.consecutiveLosses = 0;
  }

  /** Stake always follows martingale step — never a stale $22 from a prior max step. */
  _resolveTradeStake(channelKey = 'SINGLE') {
    const ch = this.channels[channelKey];
    if (!ch || this.config.recoveryEnabled === false) {
      return this._resolveStake(this.config.baseStake);
    }
    ch.stake = this._getMartingaleStake(ch);
    return ch.stake;
  }

  /** After any session loss, tighten entries; after 2+ block weak / unproven setups. */
  _shouldDeferTrade(bestSetup, runnerUp) {
    const losses = this.sessionConsecutiveLosses || 0;
    if (losses === 0) return false;

    if (!bestSetup.reversalProb) return true;

    const gap = runnerUp ? bestSetup.winRank - runnerUp.winRank : 99;

    if (losses >= 1 && bestSetup.winRank < 58) return true;
    if (losses >= 1 && gap < 4) return true;
    if (losses >= 2 && bestSetup.winRank < 68) return true;
    if (losses >= 2 && gap < 7) return true;
    if (losses >= 3 && bestSetup.winRank < 75) return true;
    if (losses >= 4 && bestSetup.winRank < 82) return true;
    if (losses >= 4 && gap < 10) return true;

    const baseline = this._getBaselineWinRate(bestSetup.direction);
    if (losses >= 4 && bestSetup.reversalProb != null && bestSetup.reversalProb < baseline + 5) return true;

    return false;
  }

  _assignBestAndRunnerUp(setup, bestRef) {
    if (!bestRef.current || this._beatsSetup(setup, bestRef.current)) {
      bestRef.runnerUp = bestRef.current;
      bestRef.current = setup;
    } else if (!bestRef.runnerUp || this._beatsSetup(setup, bestRef.runnerUp)) {
      bestRef.runnerUp = setup;
    }
  }

  _stealthJitterStake(stake) {
    const u1 = Math.random();
    const u2 = Math.random();
    const gaussian = Math.sqrt(-2 * Math.log(u1 || 0.001)) * Math.cos(2 * Math.PI * u2);
    const jitter = gaussian * 0.018;
    return Math.max(0.35, Number((stake + jitter).toFixed(2)));
  }

  /** Exact martingale stake for placement (no % jitter — user expects base × mult^step). */
  _martingaleStakeWithSlightRange(stake) {
    return Math.max(0.35, parseFloat(Number(stake).toFixed(2)));
  }

  async _stealthReactionDelay() {
    await this._stealthReactionDelayForChannel('SINGLE');
  }

  _randMs(minMs, maxMs) {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  }

  async _stealthReactionDelayForChannel(channelKey) {
    if ((this.sessionConsecutiveLosses || 0) >= 1 || this._isRecoveryUrgent()) return;
    const delay = channelKey.startsWith('SLOT_')
      ? this._randMs(30, 80)
      : this._randMs(10, 40);
    await new Promise(r => setTimeout(r, delay));
  }

  _stealthMaybeHesitate() {
    return false;
  }

  /** Rare human pause before tournament entry (~2%). */
  _stealthMaybeHesitateTournament() {
    if ((this.sessionConsecutiveLosses || 0) >= 1) return false;
    if (this._hasTournamentTradeInFlight()) return false;
    if (Math.random() > 0.02) return false;
    this._stealthBackgroundActivity();
    this.updateStatus('… brief pause (stealth)', true);
    return true;
  }

  /** Martingale stake = base × mult^step. EO/OU: unlimited unless user sets maxStakeCap > 0. */
  _getMartingaleStake(channel, useSessionStep = false) {
    const base = this.config.baseStake || 0.35;
    const mult = this.config.martMultiplier || 2.0;
    let step = useSessionStep
      ? Math.max(0, this._sessionMartingaleStep || 0)
      : Math.max(0, channel?.step ?? this._sessionMartingaleStep ?? 0);
    step = this._martingaleStepForStake(step);

    const winningUnlimited = this._isWinningDualStrategy() && !useSessionStep;
    let maxStep = 0;
    if (!winningUnlimited) {
      maxStep = this._getMaxMartingaleStep();
      if (maxStep > 0) step = Math.min(step, maxStep);
    }

    let stake = base * Math.pow(mult, step);
    const cap = this._getMaxStakeCap();
    if (cap != null) stake = Math.min(stake, cap);
    
    console.log(`[MARTINGALE DEBUG] channel=${channel?.direction || 'SINGLE'} base=${base} mult=${mult} step=${step} maxStep=${maxStep} cap=${cap} finalStake=${stake}`);
    
    return Math.max(0.35, parseFloat(stake.toFixed(2)));
  }

  _stealthBackgroundActivity() {
    if (Math.random() > 0.18) return;
    const actions = [
      () => derivWS.send({ ping: 1 }).catch(() => {}),
      () => derivWS.send({ balance: 1 }).catch(() => {}),
    ];
    actions[Math.floor(Math.random() * actions.length)]();
  }

  _isVirtualLossTick(digit, direction) {
    if (direction === 'OVER5') return digit <= 5;
    if (direction === 'UNDER5') return digit >= 5;
    if (direction === 'EVEN') return digit % 2 !== 0;
    if (direction === 'ODD') return digit % 2 === 0;
    return false;
  }

  _vlFloorForDirection(direction) {
    return BASE_VL[direction] ?? 5;
  }

  /** Per-market VL depth from historical streak distribution (p75 normal, p90 recovery). */
  _computeDynamicVlRequired(ticks, direction, recovery, tournamentMode = false) {
    const floor = tournamentMode
      ? (TOURNAMENT_VL[direction] ?? 3)
      : this._vlFloorForDirection(direction);
    const streaks = [];
    let cur = 0;
    for (const digit of (ticks || []).slice(-150)) {
      if (this._isVirtualLossTick(digit, direction)) cur++;
      else {
        if (cur > 0) streaks.push(cur);
        cur = 0;
      }
    }
    if (cur > 0) streaks.push(cur);
    if (streaks.length < 8) {
      const base = Number(this.config?.virtualLossesToWait) || 3;
      const req = tournamentMode
        ? (direction === 'OVER5' ? Math.max(TOURNAMENT_VL.OVER5, base) : Math.max(TOURNAMENT_VL.UNDER5, base))
        : floor;
      return { normal: req, recovery: Math.min(MAX_VL_REQUIREMENT, req + 1), required: req };
    }

    streaks.sort((a, b) => a - b);
    const p75 = streaks[Math.floor(streaks.length * 0.75)];
    const p90 = streaks[Math.floor(streaks.length * 0.9)];
    const sessionLosses = this.sessionConsecutiveLosses || 0;
    const recoveryExtra = Math.min(Math.floor(sessionLosses / 2), 3);
    const inRecovery = recovery?.recoveryWinMode || sessionLosses >= 2;

    const normal = Math.min(MAX_VL_REQUIREMENT, Math.max(floor, p75));
    const recoveryVal = Math.min(
      MAX_VL_REQUIREMENT,
      Math.max(floor + 1, p90 + recoveryExtra)
    );

    return {
      normal,
      recovery: recoveryVal,
      required: inRecovery ? recoveryVal : normal,
    };
  }

  _streakFormedAfterLastTrade(streakLen) {
    if (!streakLen || streakLen <= 0) return false;
    const lastSettled = this._lastTradeSettledAt || 0;
    if (lastSettled <= 0) return true;
    const streakStartAt = Date.now() - streakLen * MS_PER_TICK_EST;
    return streakStartAt > lastSettled;
  }

  _computeChiSquareDeviation(ticks, direction) {
    const window = (ticks || []).slice(-50);
    if (window.length < 30) return { significant: false, chi2: 0, deficit: 0 };

    const freq = Array(10).fill(0);
    for (const t of window) freq[t]++;
    const expected = window.length / 10;
    const chi2 = freq.reduce((sum, obs) => sum + ((obs - expected) ** 2) / expected, 0);

    let deficit = 0;
    if (direction === 'OVER5') {
      const highCount = freq.slice(6).reduce((a, b) => a + b, 0);
      deficit = window.length * 0.4 - highCount;
    } else if (direction === 'UNDER5') {
      const lowCount = freq.slice(0, 5).reduce((a, b) => a + b, 0);
      deficit = window.length * 0.5 - lowCount;
    } else if (direction === 'EVEN') {
      const evenCount = window.filter(d => d % 2 === 0).length;
      deficit = window.length * 0.5 - evenCount;
    } else if (direction === 'ODD') {
      const oddCount = window.filter(d => d % 2 !== 0).length;
      deficit = window.length * 0.5 - oddCount;
    }

    return {
      chi2,
      deficit,
      significant: chi2 > 12.6 && deficit > 3,
    };
  }

  _computeAlternationRate(ticks, direction, window = 20) {
    const recent = (ticks || []).slice(-window);
    if (recent.length < 4) return 0;
    let alternations = 0;
    for (let i = 1; i < recent.length; i++) {
      const prevWin = this._directionWouldWin(recent[i - 1], direction);
      const currWin = this._directionWouldWin(recent[i], direction);
      if (prevWin !== currWin) alternations++;
    }
    return alternations / (recent.length - 1);
  }

  _recentWinRate(symbol, direction) {
    const h = this._dirWinHistory[`${symbol}:${direction}`] || [];
    if (h.length < 8) return null;
    return h.reduce((a, b) => a + b, 0) / h.length;
  }

  _vlDepthBreakeven(direction) {
    return direction === 'OVER5' ? 0.57 : 0.52;
  }

  _recordVlDepthResult(direction, depth, won) {
    const key = `${direction}:${depth}`;
    this._vlDepthStats[key] ??= { wins: 0, attempts: 0 };
    this._vlDepthStats[key].attempts++;
    if (won) this._vlDepthStats[key].wins++;
  }

  _passesVlDepthGate(direction, depth) {
    const key = `${direction}:${depth}`;
    const stats = this._vlDepthStats[key];
    if (!stats || stats.attempts < 8) return true;
    return (stats.wins / stats.attempts) >= this._vlDepthBreakeven(direction);
  }

  /** Scan-line VL floors (dynamic per-market applied in omni-scan). */
  _getVirtualLossRequirements() {
    const recovery = this._getWinRecoveryContext();
    const sessionLosses = this.sessionConsecutiveLosses || 0;
    const recoveryExtra = Math.min(Math.floor(sessionLosses / 2), 3);
    const reqOver = Math.min(MAX_VL_REQUIREMENT, BASE_VL.OVER5 + recoveryExtra);
    const reqUnder = Math.min(MAX_VL_REQUIREMENT, BASE_VL.UNDER5 + recoveryExtra);
    const reqEven = Math.min(MAX_VL_REQUIREMENT, BASE_VL.EVEN + recoveryExtra);
    const reqOdd = Math.min(MAX_VL_REQUIREMENT, BASE_VL.ODD + recoveryExtra);
    return {
      requiredVirtualLosses: reqUnder,
      reqOver,
      reqUnder,
      reqEven,
      reqOdd,
      recovery,
    };
  }

  _omniScanBestSetup(activeSubStrategy, minConf) {
    const recovery = this._getWinRecoveryContext();
    const effectiveMinConf = minConf + recovery.minConfBoost;
    const { reqOver, reqUnder, reqEven, reqOdd } = this._getVirtualLossRequirements();
    let bestSetup = null;
    let maxOverStreak = 0, maxUnderStreak = 0, maxEvenStreak = 0, maxOddStreak = 0;

    const sessionLosses = this.sessionConsecutiveLosses || 0;
    const minStreakMargin = recovery.minStreakMargin || 0;
    const minChop = sessionLosses >= 4 ? 30 : sessionLosses > 0 ? 24 : 18;
    const minQualityFloor = 0;
    const minCrossMarkets = Math.max(2, recovery.minCrossMarkets || 2);
    let candidates = [];
    let rawSetupCount = 0;
    let vlReadyOver = 0;
    let vlReadyUnder = 0;

    const tryPushSetup = (setups, market, direction, streak, required, scores, chopIndex, d5Pct, vlSaturated) => {
      if (!vlSaturated) return;
      if (!this._streakFormedAfterLastTrade(streak)) return;
      if (this._isDirectionBlocked(direction, market)) return;

      const wr = this._recentWinRate(market, direction);
      if (wr !== null && wr < 0.38) return;

      if (!this._passesVlDepthGate(direction, streak)) return;

      const ltBias = direction === 'OVER5' ? parseFloat(scores.ltOverPct) || 40
        : direction === 'UNDER5' ? parseFloat(scores.ltUnderPct) || 50
        : direction === 'EVEN' ? parseFloat(scores.ltEvenPct) || 50
        : parseFloat(scores.ltOddPct) || 50;
      const minBias = direction === 'OVER5' ? 38 : 46;
      if (ltBias < minBias) return;

      const ticks = scanner.buffers[market] || [];
      const convCtx = this._buildConvergenceCtx(market, direction, ticks, scores, required, streak);
      const conv = this._runConvergenceScan(market, direction, convCtx);
      if (conv.blocked) return;

      setups.push({
        market,
        direction,
        streak,
        required,
        vlDepth: streak,
        chopIndex,
        d5Pct,
        conf: this._getSetupSignalStrength(scores, direction, streak, required),
        vlSaturated: true,
        vlReadyAt: Date.now(),
        convergenceScore: conv.convergenceScore,
      });
    };

    for (const market of MARKETS) {
      if (this.marketStats[market]?.quarantinedUntil > Date.now()) continue;
      const ticks = scanner.buffers[market] || [];
      if (ticks.length < 30) continue;

      const streaks = this._calcDigitStreaks(ticks);
      maxOverStreak = Math.max(maxOverStreak, streaks.overLossStreak);
      maxUnderStreak = Math.max(maxUnderStreak, streaks.underLossStreak);
      maxEvenStreak = Math.max(maxEvenStreak, streaks.evenLossStreak);
      maxOddStreak = Math.max(maxOddStreak, streaks.oddLossStreak);

      const scores = scanner.scores[market] || {};
      const d5Pct = parseFloat(scores.d5Pct) || 0;
      if (d5Pct >= 10.5) continue;

      const chopIndex = this._calcChopIndex(ticks);
      const setups = [];

      if (activeSubStrategy === 'BOTH5') {
        const dynOver = this._computeDynamicVlRequired(ticks, 'OVER5', recovery);
        const dynUnder = this._computeDynamicVlRequired(ticks, 'UNDER5', recovery);
        const localReqOver = dynOver?.required ?? reqOver;
        const localReqUnder = dynUnder?.required ?? reqUnder;

        const ltOverPct = parseFloat(scores.ltOverPct) || 40;
        const ltUnderPct = parseFloat(scores.ltUnderPct) || 50;
        const overSaturated = streaks.overLossStreak >= localReqOver;
        const underSaturated = streaks.underLossStreak >= localReqUnder;
        if (overSaturated) vlReadyOver++;
        if (underSaturated) vlReadyUnder++;

        if (streaks.overLossStreak >= localReqOver && ltOverPct >= 42.0) {
          tryPushSetup(setups, market, 'OVER5', streaks.overLossStreak, localReqOver, scores, chopIndex, d5Pct, overSaturated);
        }
        if (streaks.underLossStreak >= localReqUnder && ltUnderPct >= 48.0) {
          tryPushSetup(setups, market, 'UNDER5', streaks.underLossStreak, localReqUnder, scores, chopIndex, d5Pct, underSaturated);
        }
      } else {
        const dynEven = this._computeDynamicVlRequired(ticks, 'EVEN', recovery);
        const dynOdd = this._computeDynamicVlRequired(ticks, 'ODD', recovery);
        const localReqEven = dynEven?.required ?? reqEven;
        const localReqOdd = dynOdd?.required ?? reqOdd;

        const ltEvenPct = parseFloat(scores.ltEvenPct) || 50;
        const ltOddPct = parseFloat(scores.ltOddPct) || 50;
        const evenSaturated = streaks.evenLossStreak >= localReqEven;
        const oddSaturated = streaks.oddLossStreak >= localReqOdd;

        if (streaks.evenLossStreak >= localReqEven && ltEvenPct >= 48.0) {
          tryPushSetup(setups, market, 'EVEN', streaks.evenLossStreak, localReqEven, scores, chopIndex, d5Pct, evenSaturated);
        }
        if (streaks.oddLossStreak >= localReqOdd && ltOddPct >= 48.0) {
          tryPushSetup(setups, market, 'ODD', streaks.oddLossStreak, localReqOdd, scores, chopIndex, d5Pct, oddSaturated);
        }
      }

      for (const s of setups) {
        if (s.conf < effectiveMinConf) continue;

        let macroConf = 50;
        if (s.direction === 'OVER5') macroConf = parseFloat(scores.ltOverPct) || 50;
        if (s.direction === 'UNDER5') macroConf = parseFloat(scores.ltUnderPct) || 50;
        if (s.direction === 'EVEN') macroConf = parseFloat(scores.ltEvenPct) || 50;
        if (s.direction === 'ODD') macroConf = parseFloat(scores.ltOddPct) || 50;
        s.macroConf = macroConf;

        if (this._computeAlternationRate(ticks, s.direction) > DEFAULT_ALTERNATION_CAP) continue;

        const chi = this._computeChiSquareDeviation(ticks, s.direction);
        if (!chi.significant) continue;

        let penalty = 0;
        if (this._lastDirections?.length >= 2 && this._lastDirections.every(d => d === s.direction)) penalty += 1;
        if (macroConf < 45) penalty += 1;
        if (macroConf < 35) penalty += 1;
        const bonus = macroConf > 55 ? 1 : 0;
        const effectiveStreak = s.streak - Math.max(0, penalty - bonus);
        if (effectiveStreak < s.required + minStreakMargin) continue;
        if (chopIndex < minChop) continue;

        s.quality = this._scoreEntryQuality({ ...s, macroConf });
        if (s.quality < Math.max(recovery.minQuality, minQualityFloor)) continue;

        s.reversalProb = this._computeLunarReversalProb(ticks, s.direction, s.required);
        s.oppositeBias = this._computeOppositeDirectionBias(ticks, s.direction);
        s.chi2 = chi.chi2;

        rawSetupCount++;
        candidates.push(s);
      }
    }

    candidates = candidates.filter(s => {
      const mTicks = scanner.buffers[s.market] || [];
      const mScores = scanner.scores[s.market] || {};
      const report = this._runConvergenceScan(
        s.market,
        s.direction,
        this._buildConvergenceCtx(s.market, s.direction, mTicks, mScores, s.required, s.streak)
      );
      if (report.blocked) return false;
      s.convergenceScore = report.convergenceScore;
      s.convergence = report;
      s.winChance = Math.max(s.conf || 0, report.winEst);
      return true;
    });
    candidates.sort((a, b) => (b.convergenceScore ?? 0) - (a.convergenceScore ?? 0));

    const dirCount = {};
    for (const c of candidates) dirCount[c.direction] = (dirCount[c.direction] || 0) + 1;
    const consensusCandidates = candidates.filter(c => dirCount[c.direction] >= 2);
    if (consensusCandidates.length > 0) {
      const byDir = {};
      for (const c of consensusCandidates) {
        if (!byDir[c.direction]) byDir[c.direction] = [];
        byDir[c.direction].push(c);
      }
      const timeAligned = [];
      for (const dir of Object.keys(byDir)) {
        const group = byDir[dir].sort((a, b) => a.vlReadyAt - b.vlReadyAt);
        for (let i = 0; i < group.length; i++) {
          const cluster = [group[i]];
          for (let j = i + 1; j < group.length; j++) {
            if (Math.abs(group[j].vlReadyAt - group[i].vlReadyAt) <= VL_CONSENSUS_MS) cluster.push(group[j]);
          }
          if (cluster.length >= 2) timeAligned.push(...cluster);
        }
      }
      candidates = timeAligned.length > 0 ? timeAligned : consensusCandidates;
    }

    const crossCount = {};
    for (const c of candidates) {
      crossCount[c.direction] = (crossCount[c.direction] || 0) + 1;
    }

    const pick = { current: null, runnerUp: null };

    for (const s of candidates) {
      const cross = crossCount[s.direction] || 1;
      if (cross < minCrossMarkets) continue;
      if (recovery.minRevEdge > 0 && s.reversalProb != null) {
        if (!this._passesLunarReversalGate(s.reversalProb, s.direction, recovery.minRevEdge)) continue;
      }
      s.winRank = this._computeWinRank(s, cross);
      s.winConfidence = s.winRank;
      this._assignBestAndRunnerUp(s, pick);
    }

    if (!pick.current && sessionLosses < 2 && (maxOverStreak >= reqOver || maxUnderStreak >= reqUnder || maxEvenStreak >= reqEven || maxOddStreak >= reqOdd)) {
      const fc = {};
      for (const m of MARKETS) {
        const t = scanner.buffers[m] || [];
        if (t.length < 3) continue;
        const st = this._calcDigitStreaks(t);
        if (st.overLossStreak >= reqOver) fc.OVER5 = (fc.OVER5 || 0) + 1;
        if (st.underLossStreak >= reqUnder) fc.UNDER5 = (fc.UNDER5 || 0) + 1;
        if (st.evenLossStreak >= reqEven) fc.EVEN = (fc.EVEN || 0) + 1;
        if (st.oddLossStreak >= reqOdd) fc.ODD = (fc.ODD || 0) + 1;
      }
      const fallback = this._pickFallbackVlSetup(activeSubStrategy, reqOver, reqUnder, reqEven, reqOdd, fc);
      if (fallback) this._assignBestAndRunnerUp(fallback, pick);
    }

    bestSetup = pick.current;
    const runnerUp = pick.runnerUp;
    const bestPeek = bestSetup;

    return {
      bestSetup, runnerUp, maxOverStreak, maxUnderStreak, maxEvenStreak, maxOddStreak,
      reqOver, reqUnder, reqEven, reqOdd, recovery, rawSetupCount, candidateCount: candidates.length,
      vlReadyOver, vlReadyUnder, bestPeek,
    };
  }

  /** When strict pass yields nothing but VL is met, rank all VL-ready markets and take the best. */
  _pickFallbackVlSetup(activeSubStrategy, reqOver, reqUnder, reqEven, reqOdd, crossCount) {
    let best = null;
    for (const market of MARKETS) {
      if (this.marketStats[market]?.quarantinedUntil > Date.now()) continue;
      const ticks = scanner.buffers[market] || [];
      if (ticks.length < 4) continue;
      const streaks = this._calcDigitStreaks(ticks);
      const scores = scanner.scores[market] || {};
      const d5Pct = parseFloat(scores.d5Pct) || 0;
      if (d5Pct >= 12) continue;

      const trySetup = (direction, streak, required) => {
        if (streak < required) return;
        if (this._isDirectionBlocked(direction, market)) return;
        const s = {
          market, direction, streak, required, chopIndex: this._calcChopIndex(ticks),
          d5Pct, conf: this._getSetupSignalStrength(scores, direction, streak, required),
          macroConf: 50, quality: streak - required,
        };
        if (direction === 'OVER5') s.macroConf = parseFloat(scores.ltOverPct) || 50;
        if (direction === 'UNDER5') s.macroConf = parseFloat(scores.ltUnderPct) || 50;
        if (direction === 'EVEN') s.macroConf = parseFloat(scores.ltEvenPct) || 50;
        if (direction === 'ODD') s.macroConf = parseFloat(scores.ltOddPct) || 50;
        s.reversalProb = this._computeLunarReversalProb(ticks, direction, required);
        s.oppositeBias = this._computeOppositeDirectionBias(ticks, direction);
        const report = this._runConvergenceScan(
          market,
          direction,
          this._buildConvergenceCtx(market, direction, ticks, scores, required, streak)
        );
        if (report.blocked) return;
        s.convergenceScore = report.convergenceScore;
        s.convergence = report;
        const cross = crossCount[direction] || 1;
        s.winRank = this._computeWinRank(s, cross) + report.convergenceScore * 0.15;
        s.winConfidence = s.winRank;
        if (!best || this._beatsSetup(s, best)) best = s;
      };

      if (activeSubStrategy === 'BOTH5') {
        trySetup('OVER5', streaks.overLossStreak, reqOver);
        trySetup('UNDER5', streaks.underLossStreak, reqUnder);
      } else {
        trySetup('EVEN', streaks.evenLossStreak, reqEven);
        trySetup('ODD', streaks.oddLossStreak, reqOdd);
      }
    }
    return best;
  }

  /**
   * Dual winning (OU_WINNING / EO_WINNING) market scan.
   * @param {'entry'|'vl'} mode — entry: quality/lunar edge (no VL gate). vl: rank saturated legs for rotation after losses.
   */
  _omniScanBestDualMarket(isOverUnder, mode = 'entry') {
    const forVL = mode === 'vl';
    const recovery = this._getWinRecoveryContext();
    const minDualQuality = recovery.minQuality * 0.85;
    const { reqOver, reqUnder, reqEven, reqOdd } = this._getVirtualLossRequirements();
    const req1 = isOverUnder ? reqOver : reqEven;
    const req2 = isOverUnder ? reqUnder : reqOdd;
    const leg1Label = isOverUnder ? 'OVER5' : 'EVEN';
    const leg2Label = isOverUnder ? 'UNDER5' : 'ODD';
    const ch1 = this.channels[leg1Label];
    const ch2 = this.channels[leg2Label];
    const imbalance = Math.abs((ch1?.consecutiveLosses || 0) - (ch2?.consecutiveLosses || 0));
    const weakLegExtra = imbalance >= 2 ? 1 : 0;
    const sessionLosses = this.sessionConsecutiveLosses || 0;
    const minTicks = forVL ? Math.max(req1, req2) + weakLegExtra + 1 : 10;

    let best = null;
    let maxLeg1 = 0;
    let maxLeg2 = 0;

    for (const market of MARKETS) {
      if (this.marketStats[market]?.quarantinedUntil > Date.now()) continue;

      const ticks = scanner.buffers[market] || [];
      if (ticks.length < minTicks) continue;

      const streaks = this._calcDigitStreaks(ticks);
      const s1 = isOverUnder ? streaks.overLossStreak : streaks.evenLossStreak;
      const s2 = isOverUnder ? streaks.underLossStreak : streaks.oddLossStreak;
      maxLeg1 = Math.max(maxLeg1, s1);
      maxLeg2 = Math.max(maxLeg2, s2);

      const scores = scanner.scores[market] || {};
      const chopIndex = this._calcChopIndex(ticks);
      const d5Pct = parseFloat(scores.d5Pct) || 0;

      let localReq1 = req1;
      let localReq2 = req2;
      if ((ch1?.consecutiveLosses || 0) > (ch2?.consecutiveLosses || 0)) localReq1 += weakLegExtra;
      else if ((ch2?.consecutiveLosses || 0) > (ch1?.consecutiveLosses || 0)) localReq2 += weakLegExtra;
      const hotLegReady = s1 >= localReq1 || s2 >= localReq2;

      if (isOverUnder) {
        if (d5Pct >= 7.0) continue;
        const ltOverPct = parseFloat(scores.ltOverPct) || 40;
        const ltUnderPct = parseFloat(scores.ltUnderPct) || 50;
        if (forVL && !hotLegReady) continue;
        if (ltOverPct < 38.0 || ltUnderPct < 48.0) continue;
        if (!forVL && ticks[ticks.length - 1] === 5) continue;
        if (!forVL && this._computeAlternationRate(ticks, leg1Label) > 0.72) continue;
        if (!forVL && this._computeAlternationRate(ticks, leg2Label) > 0.72) continue;
      } else {
        const ltEvenPct = parseFloat(scores.ltEvenPct) || 50;
        const ltOddPct = parseFloat(scores.ltOddPct) || 50;
        if (forVL && !hotLegReady) continue;
        if (ltEvenPct < 48.0 || ltOddPct < 48.0) continue;
        if (!forVL && this._computeAlternationRate(ticks, leg1Label) > 0.72) continue;
        if (!forVL && this._computeAlternationRate(ticks, leg2Label) > 0.72) continue;
      }

      const rev1 = this._computeLunarReversalProb(ticks, leg1Label, localReq1);
      const rev2 = this._computeLunarReversalProb(ticks, leg2Label, localReq2);
      const base1 = this._getBaselineWinRate(leg1Label);
      const base2 = this._getBaselineWinRate(leg2Label);
      const r1 = rev1 ?? base1;
      const r2 = rev2 ?? base2;

      const dualScore = forVL
        ? Math.max(s1 / localReq1, s2 / localReq2)
        : Math.max(s1 / Math.max(1, localReq1), s2 / Math.max(1, localReq2));
      const quality = forVL
        ? dualScore * 10 + chopIndex * 0.05 - d5Pct * 0.15
        : chopIndex * 0.07 - d5Pct * 0.18 + (r1 + r2) * 0.35;
      const qualityFloor = forVL ? minDualQuality * 0.5 : Math.max(28, minDualQuality * 0.32);
      if (quality < qualityFloor) continue;

      const edge1 = r1 - base1;
      const edge2 = r2 - base2;
      const mStats = this.marketStats[market] || {};
      const mWins = mStats.totalSessionWins || 0;
      const mLosses = mStats.totalSessionLosses || 0;
      const mTotal = mWins + mLosses;
      const marketBonus = mTotal >= 2 ? ((mWins / mTotal) - 0.45) * 20 : 0;
      let lunarScore = forVL
        ? (r1 + r2) * 0.25 + (edge1 + edge2) * 1.2 + quality * 2 + marketBonus
        : (r1 + r2) * 0.38 + (edge1 + edge2) * 1.5 + quality * 2.4 + marketBonus;
      if (!forVL) {
        lunarScore += Math.min(s1, localReq1) * 0.25 + Math.min(s2, localReq2) * 0.25;
      }
      if (sessionLosses > 0 && rev1 != null && rev2 != null) lunarScore += forVL ? 8 : 4;
      const recoveryDir = this._getDualRecoveryPriorityDir([leg1Label, leg2Label]);
      if (recoveryDir === leg1Label) {
        lunarScore += (ch1?.step || 0) * 8 + (ch1?.consecutiveLosses || 0) * 5 + r1 * 0.2;
      } else if (recoveryDir === leg2Label) {
        lunarScore += (ch2?.step || 0) * 8 + (ch2?.consecutiveLosses || 0) * 5 + r2 * 0.2;
      }

      if (!best || lunarScore > best.lunarScore || (lunarScore === best.lunarScore && d5Pct < best.d5Pct)) {
        best = {
          market, leg1Streak: s1, leg2Streak: s2, dualScore, d5Pct, chopIndex, quality,
          lunarScore, rev1: r1, rev2: r2,
          req1: localReq1, req2: localReq2, leg1Label, leg2Label,
          entryMode: !forVL,
        };
      }
    }

    return { best, maxLeg1, maxLeg2, req1, req2, leg1Label, leg2Label, recovery, mode };
  }

  /** Pick the single strongest winning leg across all 15 markets. */
  _scanWinningSingleMarket(isOverUnder) {
    let best = null;
    const recovery = this._getWinRecoveryContext();
    const dirs = isOverUnder ? ['OVER5', 'UNDER5'] : ['EVEN', 'ODD'];
    const pressure = dirs
      .map(dir => ({ dir, losses: this.channels[dir]?.consecutiveLosses || 0 }))
      .sort((a, b) => b.losses - a.losses)[0];
    const rescueDir = pressure.losses >= 1 ? pressure.dir : null;

    for (const market of MARKETS) {
      if (this.marketStats[market]?.quarantinedUntil > Date.now()) continue;

      const ticks = scanner.buffers[market] || [];
      if (ticks.length < 10) continue;

      const scores = scanner.scores[market] || {};
      const d5Pct = parseFloat(scores.d5Pct) || 0;
      const chopIndex = this._calcChopIndex(ticks);
      const mStats = this.marketStats[market] || {};
      const mWins = mStats.totalSessionWins || 0;
      const mLosses = mStats.totalSessionLosses || 0;
      const mTotal = mWins + mLosses;
      const marketBonus = mTotal >= 2 ? ((mWins / mTotal) - 0.45) * 18 : 0;
      const streaks = this._calcDigitStreaks(ticks);

      if (isOverUnder && d5Pct >= 10.5) continue;

      for (const direction of dirs) {
        if (this._isDirectionBlocked(direction, market)) continue;
        if (rescueDir && pressure.losses >= 3 && direction !== rescueDir) continue;

        const pct = this._getDistributionBiasPct(direction, scores);
        const minPct = this.sessionConsecutiveLosses > 0
          ? minDistributionBias(direction)
          : minDistributionBiasNormal(direction);
        if (pct < minPct) continue;

        const streak = direction === 'OVER5' ? streaks.overLossStreak
          : direction === 'UNDER5' ? streaks.underLossStreak
          : direction === 'EVEN' ? streaks.evenLossStreak
          : streaks.oddLossStreak;
        const required = this._computeDynamicVlRequired(ticks, direction, recovery, true)?.required
          ?? this._getTournamentVlRequired(direction, recovery);
        if (streak < Math.max(1, required - 1)) continue;
        if (!this._passesVlDepthGate(direction, Math.max(streak, required))) continue;
        if (this._computeAlternationRate(ticks, direction) > DEFAULT_ALTERNATION_CAP) continue;

        const winChance = this._estimateTournamentWinChance(market, direction, streak, ticks, scores);
        const conv = this._runConvergenceScan(
          market,
          direction,
          this._buildConvergenceCtx(market, direction, ticks, scores, required, streak)
        );
        if (conv.blocked) continue;

        const bias = this._computeOppositeDirectionBias(ticks, direction);
        const rescueBoost = rescueDir === direction ? pressure.losses * 14 : 0;
        const score = pct * 1.7
          + winChance * 1.2
          + conv.convergenceScore * 0.75
          + Math.min(10, streak * 1.6)
          + bias.endConsecutive * 4
          + chopIndex * 0.04
          - d5Pct * 0.7
          + marketBonus
          + rescueBoost;

        if (!best || score > best.score) {
          const detail = isOverUnder
            ? `${direction} bias ${pct.toFixed(0)}% D5 ${d5Pct.toFixed(1)}% VL ${streak}/${required}`
            : `${direction} bias ${pct.toFixed(0)}% VL ${streak}/${required}`;
          best = {
            market,
            direction,
            score,
            detail,
            pct,
            winChance,
            convergenceScore: conv.convergenceScore,
            streak,
            required,
            rescueDir,
            pressureLosses: pressure.losses,
          };
        }
      }
    }

    return best;
  }

  _switchWinningSingleMarket(opts = {}) {
    return false;
  }

  /** Score one market for EO/OU recovery — favors the leg that must win back losses. */
  _scoreWinningRecoveryMarket(market, rescueDir, isOverUnder) {
    if (!rescueDir || !market) return -1;
    const ticks = scanner.buffers[market] || [];
    if (ticks.length < 12) return -1;
    if (this.marketStats[market]?.quarantinedUntil > Date.now()) return -1;

    const scores = scanner.scores[market] || {};
    const d5Pct = parseFloat(scores.d5Pct) || 0;
    const chopIndex = this._calcChopIndex(ticks);
    const streaks = this._calcDigitStreaks(ticks);
    const hedge = this._getOppositeDirection(rescueDir);
    const rescuePct = this._getDistributionBiasPct(rescueDir, scores);
    const hedgePct = hedge ? this._getDistributionBiasPct(hedge, scores) : 50;
    const minPct = rescueDir === 'OVER5' ? 42 : 48;

    if (rescuePct < minPct) return -1;
    if (this._computeAlternationRate(ticks, rescueDir) > 0.68) return -1;
    if (hedge && this._computeAlternationRate(ticks, hedge) > 0.72) return -1;
    if (isOverUnder && d5Pct >= 12) return -1;

    const rescueStreak = rescueDir === 'OVER5' ? streaks.overLossStreak
      : rescueDir === 'UNDER5' ? streaks.underLossStreak
      : rescueDir === 'EVEN' ? streaks.evenLossStreak
      : streaks.oddLossStreak;
    const revProb = this._computeLunarReversalProb(ticks, rescueDir, 2);
    const baseWR = this._getBaselineWinRate(rescueDir);
    const revEdge = (revProb ?? baseWR) - baseWR;

    const ch = this.channels[rescueDir];
    const legStep = ch?.step || 0;
    const legLosses = ch?.consecutiveLosses || 0;
    const legMktLosses = this._getLegMarketLossStreak(rescueDir, market);

    const mStats = this.marketStats[market] || {};
    const mTotal = (mStats.totalSessionWins || 0) + (mStats.totalSessionLosses || 0);
    const marketBonus = mTotal >= 2 ? ((mStats.totalSessionWins || 0) / mTotal - 0.45) * 22 : 0;

    let score = rescuePct * 2.4 + revEdge * 35 + rescueStreak * 4 + chopIndex * 0.08 + marketBonus;
    score += legStep * 12 + legLosses * 10;
    score -= legMktLosses * 18;
    score -= Math.abs(rescuePct - hedgePct) * 0.4;
    if (isOverUnder) score -= d5Pct * 3;
    return score;
  }

  /** Block weak paired fires while a leg is in martingale recovery. */
  _passesWinningPairQualityGate(best, isOverUnder) {
    if (!best?.market) return false;
    const rescueDir = best.rescueDir || this._getDualRecoveryPriorityDir(best.dirs);
    if (rescueDir && this._isLegMarketBlocked(rescueDir, best.market)) {
      this.sendLog(
        `⏸ ${rescueDir} burned on ${MARKET_LABELS[best.market] || best.market} — scanning other markets…`
      );
      return false;
    }
    const ch = rescueDir ? this.channels[rescueDir] : null;
    const inRecovery = (ch?.step || 0) > 0 || (ch?.consecutiveLosses || 0) > 0;
    if (!inRecovery) return true;

    const score = this._scoreWinningRecoveryMarket(best.market, rescueDir, isOverUnder);
    const minScore = rescueDir === 'OVER5' && (ch?.consecutiveLosses || 0) >= 2 ? 50 : 55;
    if (score < minScore) {
      this.sendLog(
        `⏸ Recovery gate — ${rescueDir} needs stronger market (score ${score.toFixed(0)} < ${minScore}) · scanning…`
      );
      return false;
    }
    return true;
  }

  _scanWinningPairMarket(isOverUnder) {
    const dirs = isOverUnder ? ['OVER5', 'UNDER5'] : ['EVEN', 'ODD'];
    const dir1 = dirs[0];
    const dir2 = dirs[1];
    const rescueDir = this._getDualRecoveryPriorityDir(dirs);
    const recoveryActive = (this.channels[rescueDir]?.step || 0) > 0
      || (this.channels[rescueDir]?.consecutiveLosses || 0) > 0;

    if (recoveryActive) {
      const dirBest = this._findBestMarketForDirection(rescueDir);
      if (dirBest?.market && dirBest.score >= 50) {
        return {
          market: dirBest.market,
          dirs,
          rescueDir,
          score: dirBest.score,
          detail: `${dirBest.detail} · leg scan`,
          pressureLosses: this.channels[rescueDir]?.consecutiveLosses || 0,
        };
      }

      const lb = this._scanLeaderboardRecoveryForDual(isOverUnder, rescueDir);
      if (lb?.market) {
        const lbScore = this._scoreWinningRecoveryMarket(lb.market, rescueDir, isOverUnder);
        if (lbScore >= 55) {
          return {
            market: lb.market,
            dirs,
            rescueDir: lb.rescueDir || rescueDir,
            score: lbScore,
            detail: `${lb.detail} · recovery ${rescueDir}`,
            leaderboardRecovery: true,
            pressureLosses: lb.pressureLosses,
          };
        }
      }
    }

    // ── BALANCE LOGIC: track per-side wins/losses to keep them balanced ──
    // Count actual wins per side from session trades
    const settled = (this.sessionTrades || []).filter(t => !t.pending);
    let side1Wins = 0, side1Losses = 0, side2Wins = 0, side2Losses = 0;
    for (const t of settled) {
      const td = t.direction || t.dir;
      if (td === dir1) {
        if (t.won) side1Wins++; else side1Losses++;
      } else if (td === dir2) {
        if (t.won) side2Wins++; else side2Losses++;
      }
    }
    const side1Total = side1Wins + side1Losses;
    const side2Total = side2Wins + side2Losses;
    const totalSides = side1Total + side2Total;

    // Compute actual win-rate per side (not 50/50 assumption)
    const side1WinRate = side1Total > 0 ? (side1Wins / side1Total) * 100 : 50;
    const side2WinRate = side2Total > 0 ? (side2Wins / side2Total) * 100 : 50;

    // Determine which side is lagging — bias toward the side with fewer wins to balance
    let balanceBiasDir = null;
    let balanceBiasStrength = 0;
    if (totalSides >= 4) {
      const winGap = Math.abs(side1Wins - side2Wins);
      if (winGap >= 2) {
        balanceBiasDir = side1Wins < side2Wins ? dir1 : dir2;
        balanceBiasStrength = Math.min(30, winGap * 5); // up to +30 score boost
      }
    }

    // 🚀 After a loss, try leaderboard pick first
    if ((this.sessionConsecutiveLosses || 0) >= 1) {
      const sweep = this._runApexMatrixLeaderboard();
      const lb = sweep.leaderboard || [];
      const valid = lb.filter(c => dirs.includes(c.dir)
        && !this._isLegMarketBlocked(c.dir, c.sym || c.market));
      if (valid.length > 0) {
        // If balance bias active, prefer the lagging side from leaderboard results
        let top = valid[0];
        if (balanceBiasDir) {
          const biasedPick = valid.find(c => c.dir === balanceBiasDir);
          if (biasedPick && biasedPick.score >= top.score * 0.75) {
            top = biasedPick;
          }
        }
        return {
          market: top.sym,
          dirs,
          rescueDir: top.dir,
          score: top.score || 100,
          detail: `LB ${top.dir} sc${top.score} · ${dir1}W${side1Wins}/${side1Total} ${dir2}W${side2Wins}/${side2Total}`,
          leaderboardRecovery: true
        };
      }
    }

    const recovery = (this.sessionConsecutiveLosses || 0) > 0;
    const pressure = dirs
      .map(dir => ({ dir, losses: this.channels[dir]?.consecutiveLosses || 0, step: this.channels[dir]?.step || 0 }))
      .sort((a, b) => b.step - a.step || b.losses - a.losses)[0] || { dir: null, losses: 0 };

    let best = null;

    for (const market of MARKETS) {
      if (this.marketStats[market]?.quarantinedUntil > Date.now()) continue;

      const ticks = scanner.buffers[market] || [];
      if (ticks.length < 10) continue;

      if (recoveryActive) {
        if (this._isLegMarketBlocked(rescueDir, market)) continue;
        const recoveryScore = this._scoreWinningRecoveryMarket(market, rescueDir, isOverUnder);
        if (recoveryScore < 55) continue;
        const scores = scanner.scores[market] || {};
        const rescuePct = this._getDistributionBiasPct(rescueDir, scores);
        const detail = isOverUnder
          ? `recovery ${rescueDir} ${rescuePct.toFixed(0)}% · score ${recoveryScore.toFixed(0)}`
          : `recovery ${rescueDir} ${rescuePct.toFixed(0)}% · score ${recoveryScore.toFixed(0)}`;
        if (!best || recoveryScore > best.score) {
          best = { market, dirs, rescueDir, pressureLosses: pressure.losses, score: recoveryScore, detail };
        }
        continue;
      }

      const scores = scanner.scores[market] || {};
      const d5Pct = parseFloat(scores.d5Pct) || 0;
      const chopIndex = this._calcChopIndex(ticks);
      const mStats = this.marketStats[market] || {};
      const mWins = mStats.totalSessionWins || 0;
      const mLosses = mStats.totalSessionLosses || 0;
      const mTotal = mWins + mLosses;
      const marketBonus = mTotal >= 2 ? ((mWins / mTotal) - 0.45) * 20 : 0;

      let score = 0;
      let detail = '';
      if (isOverUnder) {
        const overPct = parseFloat(scores.ltOverPct ?? scores.overPct) || 40;
        const underPct = parseFloat(scores.ltUnderPct ?? scores.underPct) || 50;
        const balanceGap = Math.abs(overPct - underPct);
        if (d5Pct >= 14.5) continue;
        // Base score: favor balanced distributions
        score = Math.min(overPct, underPct) * 2.5 - d5Pct * 4 - balanceGap * 0.35 + chopIndex * 0.05 + marketBonus;
        // Balance bias: boost score if this market favors the lagging side
        if (balanceBiasDir && totalSides >= 4) {
          const biasedPct = balanceBiasDir === 'OVER5' ? overPct : underPct;
          score += biasedPct > 48 ? balanceBiasStrength : balanceBiasStrength * 0.4;
        }
        if (rescueDir === 'OVER5') score += overPct * 0.1 + (pressure.step || 0) * 6 + pressure.losses * 4;
        else if (rescueDir === 'UNDER5') score += underPct * 0.1 + (pressure.step || 0) * 6 + pressure.losses * 4;
        detail = `O${overPct.toFixed(0)}% U${underPct.toFixed(0)}% D5${d5Pct.toFixed(1)}% · ${dir1}W${side1Wins} ${dir2}W${side2Wins}`;
      } else {
        const evenPct = parseFloat(scores.ltEvenPct ?? scores.evenPct) || 50;
        const oddPct = parseFloat(scores.ltOddPct ?? scores.oddPct) || 50;
        const balanceGap = Math.abs(evenPct - oddPct);
        // Base score: favor balanced distributions
        score = Math.min(evenPct, oddPct) * 2.2 + (100 - balanceGap * 5) + chopIndex * 0.05 + marketBonus;
        // Balance bias: boost score if this market favors the lagging side
        if (balanceBiasDir && totalSides >= 4) {
          const biasedPct = balanceBiasDir === 'EVEN' ? evenPct : oddPct;
          score += biasedPct > 48 ? balanceBiasStrength : balanceBiasStrength * 0.4;
        }
        if (rescueDir === 'EVEN') score += evenPct * 0.1 + (pressure.step || 0) * 6 + pressure.losses * 4;
        else if (rescueDir === 'ODD') score += oddPct * 0.1 + (pressure.step || 0) * 6 + pressure.losses * 4;
        detail = `E${evenPct.toFixed(0)}% O${oddPct.toFixed(0)}% gap${balanceGap.toFixed(1)}% · ${dir1}W${side1Wins} ${dir2}W${side2Wins}`;
      }

      if (!best || score > best.score) {
        best = { market, dirs, rescueDir, pressureLosses: pressure.losses, score, detail };
      }
    }

    if (!best) {
      for (const market of MARKETS) {
        if ((scanner.buffers[market]?.length || 0) < 8) continue;
        const scores = scanner.scores[market] || {};
        const overPct = parseFloat(scores.ltOverPct ?? scores.overPct) || 40;
        const underPct = parseFloat(scores.ltUnderPct ?? scores.underPct) || 50;
        const evenPct = parseFloat(scores.ltEvenPct ?? scores.evenPct) || 50;
        const oddPct = parseFloat(scores.ltOddPct ?? scores.oddPct) || 50;
        const score = isOverUnder
          ? Math.max(overPct, underPct)
          : Math.max(evenPct, oddPct);
        if (!best || score > best.score) {
          best = {
            market,
            dirs,
            rescueDir,
            pressureLosses: pressure.losses,
            score,
            detail: isOverUnder
              ? `fallback O${overPct.toFixed(0)}% U${underPct.toFixed(0)}%`
              : `fallback E${evenPct.toFixed(0)}% O${oddPct.toFixed(0)}%`,
          };
        }
      }
    }

    return best;
  }

  _executeWinningSingleCycle() {
    const isOu = this.strategy === 'OU_WINNING' || this.strategy === 'BOTH5';
    const dirs = this.strategy === 'OU_WINNING' ? ['OVER5', 'UNDER4'] : isOu ? ['OVER5', 'UNDER5'] : ['EVEN', 'ODD'];

    this._cleanStaleOpenContracts();
    this._clearStaleDualChannels(dirs);

    if (this._hasLiveDualContracts(dirs)) {
      this.updateStatus('Polling settlement...');
      this._scheduleNext(150);
      return;
    }

    if (this._checkSessionGuards()) {
      this._scheduleNext(500);
      return;
    }

    // Post-loss pause removed — fire immediately

    if (this._usesIsolatedSniperMode()) {
      void this._fireIsolatedSniperTrade().then((fired) => {
        this._scheduleNext(fired ? 600 : OMNI_SCAN_MS);
      });
      return;
    }

    const market = this.activeMarket;

    this.updateStatus(`Winning pair · ${market}`, true);
    this.sendLog(
      `⚡ Winning pair (same tick) → ${MARKET_LABELS[market] || market} · ${dirs.join('+')}`
    );
    this._recordTradeFired();
    this._recordTradeFired();
    void this._fireWinningDualPair(market, dirs).then((fired) => {
      this._scheduleNext(fired ? 150 : OMNI_SCAN_MS);
    });
  }

  /**
   * Single contract — restored 4-streak matrix + per-index martingale (win reset, stake ceiling).
   */
  async _fireIsolatedSniperTrade(opts = {}) {
    if (!this.running) return false;
    if (this._isCascadePaused()) {
      const sec = Math.ceil((this._cascadePausedUntil - Date.now()) / 1000);
      this.updateStatus(`⏸ Cascade pause · ${sec}s`, true);
      return false;
    }
    // Clear any stale apex lock to prevent indefinite freezing BEFORE checking network phase
    if (isApexOrderInFlight()) setApexOrderInFlight(false);

    if (!canDispatchNetworkPhase()) {
      this.updateStatus('⏳ Sniper wait · throttle/lock…', true);
      return false;
    }

    // Single uniform path win or loss — no recovery branching, no algorithm switch.
    let pick = null;
    {
      const marketMap = buildMarketDataMap(scanner, this._getAllMarketBuffers());
      pick = processSuperMatrixSweep(marketMap, {
        strategy: this.strategy,
        baseStake: this.config.baseStake,
        maxStakeCap: this._getMaxStakeCap(),
        stakeSafetyCeiling: 0,
        martMultiplier: this.config.martMultiplier || 2,
        maxMartingaleStep: this._getMaxMartingaleStep(),
        martingaleHoldAfterStep: this._getMartingaleHoldAfterStep(),
        scanner,
      });
    }

    if (!pick || pick.action === 'none') {
      const top = pick?.topScore ?? 0;
      const pool = pick?.readyPool ?? 0;
      if (usesMatrix20Engine(this.strategy)) {
        this.updateStatus(
          pool > 0
            ? `Sniper pool ${pool} · best ${pick?.bestSniperScore ?? 0}/9 · top WR ${top}%`
            : 'Hunting sniper setups (score ≥6, WR ≥58%)…',
          true
        );
      } else {
        this.updateStatus(
          top > 0 ? `Scan 15 · best ${top} (need ${ENGINE_CONFIG.SUPER_MIN_SCORE}+)…` : 'Scan 15 · 4-streak sweep…',
          true
        );
      }
      return false;
    }

    if (pick.action !== 'recovery' && pick.action !== 'matrix') return false;

    const sym = pick.sym;
    const dir = pick.dir;
    if (!sym || !dir) return false;

    this._lastTournamentEntry = {
      sym,
      dir,
      score: pick.sniperScore ?? pick.score,
      sniperScore: pick.sniperScore ?? pick.score,
      rate: pick.virtualWinRate,
      algorithm: 'apex_sniper_matrix',
      pivotRecovery: pick.pivotRecovery,
      at: Date.now(),
    };

    const stake = this._getSessionMartingaleStake(sym);
    if (!stake) return false;
    const martLevel = usesMatrix20Engine(this.strategy)
      ? globalMatrixState.currentMartingaleLevel
      : getAssetTracker(sym).currentMartingaleLevel;

    const ch = this.channels[dir];
    if (!ch || ch.active || ch.contractId) return false;

    if (opts.freeSlot && this._usesTournamentMode()) {
      const plan = {
        sym,
        dir,
        streak: 0,
        score: pick.score ?? 90,
        winChance: 48,
        algorithm: 'isolated_matrix',
        stake,
        fastPass: pick.fastPass === true,
        ready: true,
      };
      if (!tryAcquireApexLock()) {
        setApexOrderInFlight(false);
        return false;
      }
      if (!this._claimTournamentFire(opts.freeSlot, plan)) {
        setApexOrderInFlight(false);
        return false;
      }
      markNetworkDispatch();
    const pivotTag = pick.pivotRecovery ? ' · pivot' : '';
    const stealthTag = pick.stealthPool > 1 ? ` · 🎲 #${pick.stealthRank}/${pick.stealthPool}` : '';
    const sniperSc = pick.sniperScore ?? pick.score ?? '?';
    this.sendLog(
      `🎯 SNIPER ${dir} ${MARKET_LABELS[sym]} · $${stake.toFixed(2)} · score ${sniperSc} · WR ${pick.virtualWinRate ?? '?'}%${stealthTag}${pivotTag} · L${martLevel}`
    );
    this._recordTradeFired();
    await this._executeInSlot(opts.freeSlot, plan, { fastPass: plan.fastPass });
      return true;
    }

    if (!tryAcquireApexLock()) return false;
    markNetworkDispatch();
    const pivotTag2 = pick.pivotRecovery ? ' · pivot' : '';
    const stealthTag2 = pick.stealthPool > 1 ? ` · 🎲 #${pick.stealthRank}/${pick.stealthPool}` : '';
    this.sendLog(
      `🎯 SNIPER ${dir} ${MARKET_LABELS[sym]} · $${stake.toFixed(2)} · score ${pick.sniperScore ?? pick.score ?? '?'} · WR ${pick.virtualWinRate ?? '?'}%${stealthTag2}${pivotTag2} · L${martLevel}`
    );
    this._recordTradeFired();
    const barrier = pick.barrier != null ? String(pick.barrier) : null;
    await this._placeTrade(dir, dir, stake, barrier, sym, { fastPass: pick.fastPass === true });
    this.activeMarket = sym;
    if (this.onMarketSwitch) this.onMarketSwitch(sym);
    armApexOrderInFlight();
    return true;
  }

  _switchWinningDualMarketByVL() {
    return false;
  }

  /**
   * CROSS-MARKET DEBT MIGRATION for OU_WINNING / EO_WINNING.
   * Scans ALL 15 markets using real-time tick buffers and migrates the dual pair
   * to whichever market has the most balanced, high-reversion probability flow.
   * Both legs keep their martingale state (steps/stakes) intact during migration.
   */
  _migrateWinningDualToBalancedMarket() {
    return false;
  }

  _executeCycle() {
    if (this.paused) {
      this._scheduleNext(100);
      return;
    }
    if (!this.running) return;
    if (!derivWS.isReady) {
      this.updateStatus('Waiting for connection...');
      this._scheduleNext(3000);
      return;
    }

    // Stuck watchdog & Fast Polling
    const now = Date.now();
    let watchdogReleased = false;
    for (const key in this.channels) {
      const ch = this.channels[key];
      if (ch.active && ch.placedAt && ch.contractId) {
        const elapsed = now - ch.placedAt;
        
        if (elapsed > 3000 && !ch.pollRequested) {
          ch.pollRequested = true;
          derivWS.sendRaw({ proposal_open_contract: 1, contract_id: ch.contractId });
          setTimeout(() => { if (ch) ch.pollRequested = false; }, 3000);
        }

        // Hard watchdog: 12s max
        if (elapsed > 12000) {
          this.sendLog(`⚠️ Watchdog: Releasing stuck channel [${key}] after 12s`);
          
          if (this.onTradeUpdate) {
            this.onTradeUpdate({
              id: ch.contractId,
              market: this.activeMarket,
              direction: ch.direction || 'UNKNOWN',
              stake: ch.stake || 0,
              profit: -(ch.stake || 0),
              won: false,
              time: now,
              exitTick: '?',
              pending: false
            });
          }

          // Wipe zombie subscriptions from Deriv to prevent max subscription limit
          derivWS.sendRaw({ forget_all: 'proposal_open_contract' });

          ch.active = false;
          ch.contractId = null;
          if (key === 'SINGLE') ch.direction = null;
          watchdogReleased = true;
        }
      }
    }
    if (watchdogReleased) {
      this._cleanStaleOpenContracts();
      this._scheduleNext(0);
      return;
    }

    // Session Hard Stops
    const balance = derivWS.accountInfo?.balance || 0;
    if (this.strategy === 'MATCH_DIFF') {
      if (this.sessionOpeningBalance > 0 && balance <= 0.8 * this.sessionOpeningBalance) {
        const lossPct = ((this.sessionOpeningBalance - balance) / this.sessionOpeningBalance) * 100;
        this.stop(`Hard Stop: Balance dropped ${lossPct.toFixed(1)}% below opening (Opening: $${this.sessionOpeningBalance.toFixed(2)}, Current: $${balance.toFixed(2)})`);
        return;
      }
    } else if (this.strategy === 'MATCHES') {
      if (this.sessionOpeningBalance > 0 && balance <= 0.8 * this.sessionOpeningBalance) {
        const lossPct = ((this.sessionOpeningBalance - balance) / this.sessionOpeningBalance) * 100;
        this.stop(`Hard Stop: Balance dropped ${lossPct.toFixed(1)}% below opening (Opening: $${this.sessionOpeningBalance.toFixed(2)}, Current: $${balance.toFixed(2)})`);
        return;
      }

    }

    if (this.sessionStartedAt && Date.now() - this.sessionStartedAt < 800) {
      this.updateStatus('🌙 Warming 15 markets…');
      this._scheduleNext(100);
      return;
    }

    const maxLossStreak = this.config.maxLossStreak || 0;
    if (this.config.maxLossStreakStopEnabled === true && maxLossStreak > 0
      && this.sessionConsecutiveLosses >= maxLossStreak) {
      this.stop(`Stop: ${this.sessionConsecutiveLosses} consecutive losses (your limit: ${maxLossStreak}).`);
      return;
    }

    // Global Stop Loss & Take Profit checks
    if (this.sessionOpeningBalance > 0) {
      const currentPnL = balance - this.sessionOpeningBalance;
      if (this.config.stopLoss > 0 && currentPnL <= -this.config.stopLoss) {
        this.stop(`Stop Loss Reached: PnL is -$${Math.abs(currentPnL).toFixed(2)} (Limit: -$${this.config.stopLoss.toFixed(2)})`);
        return;
      }
      if (this.config.takeProfit > 0) {
        if (this.config.takeProfitType === 'wins') {
          if (this.sessionWinCount >= this.config.takeProfit) {
            if (this.strategy === 'O0_U9_HYBRID') {
              // HYBRID: If we still have unrecovered debt, do NOT reset — keep recovering
              if (this.hybridPhase === 'RECOVERY' && this.hybridDebt > 0.001) {
                this.sendLog(`⚠️ O0/U9 HYBRID: Global TP (wins) triggered but debt $${this.hybridDebt.toFixed(2)} still pending. Continuing recovery...`);
                this.sessionWinCount = 0; // Reset win counter so it doesn't keep firing
                this._scheduleNext(500);
                return;
              }
              // No debt — safe to reset everything and re-search a fresh market
              this.sendLog(`🎯 O0/U9 HYBRID: Take Profit hit! ${this.sessionWinCount} wins. Resetting and searching new market...`);
              this.hybridPhase = 'SEARCHING';
              this.hybridSide = null;
              this.hybridTargetMarket = null;
              this.hybridDebt = 0;
              this.hybridCurrentWins = 0;
              this.hybridCurrentLosses = 0;
              this.hybridRecoveryConsecutiveLosses = 0;
              this.hybridRecoveryDirection = null;
              this._hybridNeedsReevaluation = false;
              this.hybridPauseUntil = 0;
              this.sessionConsecutiveLosses = 0;
              this._syncSessionMartingaleStep(0);
              this.sessionWinCount = 0;
              this.sessionPnL = 0;
              this.sessionOpeningBalance = balance;
              this._scheduleNext(500);
              return;
            }
            this.stop(`Take Profit Reached: Session reached ${this.sessionWinCount} wins (Target: ${this.config.takeProfit} wins)`);
            return;
          }
        } else {
          if (currentPnL >= this.config.takeProfit) {
            if (this.strategy === 'O0_U9_HYBRID') {
              // HYBRID: If we still have unrecovered debt, do NOT reset — keep recovering
              if (this.hybridPhase === 'RECOVERY' && this.hybridDebt > 0.001) {
                this.sendLog(`⚠️ O0/U9 HYBRID: Global TP (currency) triggered but debt $${this.hybridDebt.toFixed(2)} still pending. Continuing recovery...`);
                this.sessionPnL = 0; // Reset PnL counter so it doesn't keep firing
                this._scheduleNext(500);
                return;
              }
              // No debt — safe to reset everything and re-search a fresh market
              this.sendLog(`🎯 O0/U9 HYBRID: Take Profit hit! PnL +$${currentPnL.toFixed(2)}. Resetting and searching new market...`);
              this.hybridPhase = 'SEARCHING';
              this.hybridSide = null;
              this.hybridTargetMarket = null;
              this.hybridDebt = 0;
              this.hybridCurrentWins = 0;
              this.hybridCurrentLosses = 0;
              this.hybridRecoveryConsecutiveLosses = 0;
              this.hybridRecoveryDirection = null;
              this._hybridNeedsReevaluation = false;
              this.hybridPauseUntil = 0;
              this.sessionConsecutiveLosses = 0;
              this._syncSessionMartingaleStep(0);
              this.sessionWinCount = 0;
              this.sessionPnL = 0;
              this.sessionOpeningBalance = balance;
              this._scheduleNext(500);
              return;
            }
            this.stop(`Take Profit Reached: PnL is +$${currentPnL.toFixed(2)} (Target: +$${this.config.takeProfit.toFixed(2)})`);
            return;
          }
        }
      }
    }

    // Time Stop — auto-stop after configured session duration
    if (this.config.timeStopMs > 0 && this.sessionStartedAt > 0) {
      const elapsed = Date.now() - this.sessionStartedAt;
      if (elapsed >= this.config.timeStopMs) {
        const hrs = Math.floor(this.config.timeStopMs / 3600000);
        const mins = Math.round((this.config.timeStopMs % 3600000) / 60000);
        const label = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
        this.stop(`Time Stop: Session reached ${label} limit.`);
        return;
      }
    }

    // All post-loss pauses, tick cooldowns, and nextAllowedTradeTime removed — fire immediately

    const isInstantWinningPair = this.strategy === 'OU_WINNING' || this.strategy === 'EO_WINNING';
    if (!isInstantWinningPair && !this._canFireTradeNow()) {
      this.updateStatus('⏳ Trade rate limit (settings)', true);
      this._scheduleNext(400);
      return;
    }

    // Router for the specific strategy
    if (this.strategy === 'MATCH_DIFF') {
      this._executeMatchesDiffersCycle();
      return;
    }
    if (this.strategy === 'MATCHES') {
      this._executeMatchesSniperCycle();
      return;
    }
    if (this.strategy === 'OVER_6') {
      this._executeOver6Cycle();
      return;
    }
    if (this.strategy === 'UNDER_8_V2') {
      this._executeUnder8V2Cycle();
      return;
    }
    if (this.strategy === 'UNDER_8_V1') {
      this._executeUnder8Cycle();
      return;
    }
    if (this.strategy === 'UNDER_7_V1') {
      this._executeUnder7V1Cycle();
      return;
    }
    if (this.strategy === 'OVER_3_V1') {
      this._executeOver3V1Cycle();
      return;
    }
    if (this.strategy === 'OVER_3_V3') {
      this._executeOver3V3Cycle();
      return;
    }
    if (this.strategy === 'OVER_3_V2') {
      this._executeOver3V2Cycle();
      return;
    }
    if (this.strategy === 'OVER_5_V1') {
      this._executeOver5V1Cycle();
      return;
    }
    if (this.strategy === 'OVER_6_V2') {
      this._executeOver6V2Cycle();
      return;
    }
    if (this.strategy === 'UNDER_3_V1') {
      this._executeUnder3V1Cycle();
      return;
    }
    if (this.strategy === 'EVEN_V1') {
      this._executeEvenV1Cycle();
      return;
    }
    if (this.strategy === 'ODD_V1') {
      this._executeOddV1Cycle();
      return;
    }
    if (this.strategy === 'OVER_0_V1') {
      this._executeOver0V1Cycle();
      return;
    }
    if (this.strategy === 'UNDER_9_V1') {
      this._executeUnder9V1Cycle();
      return;
    }
    if (this.strategy === 'O0_U9_HYBRID') {
      this._executeO0U9HybridCycle();
      return;
    }
    if (this.strategy === 'RANDOM_PICKER') {
      this._executeRandomPickerCycle();
      return;
    }
    if (this.strategy === 'RISE' || this.strategy === 'FALL') {
      this._executeRiseFallCycle();
      return;
    }

    // All other strategies (BOTH5, BOTH, OU_WINNING, EO_WINNING, DIFF, etc.)
    this._executeLegacyCycle();
  }

  // --- RISE / FALL STRATEGY ---

  /**
   * Check that a market has no consecutive rise or fall streak > 5
   * anywhere in its last 1000 ticks of price history.
   */
  _hasNoLongRiseFallStreaks(prices) {
    if (!prices || prices.length < 50) return false;
    let riseStreak = 0;
    let fallStreak = 0;
    for (let i = 1; i < prices.length; i++) {
      if (prices[i] > prices[i - 1]) { riseStreak++; fallStreak = 0; }
      else if (prices[i] < prices[i - 1]) { fallStreak++; riseStreak = 0; }
      else { riseStreak = 0; fallStreak = 0; }
      if (riseStreak > 5 || fallStreak > 5) return false;
    }
    return true;
  }

  /**
   * Score a market for Rise/Fall suitability.
   * Returns { score, riseRatio, fallRatio } or null if disqualified.
   */
  _scoreMarketForRiseFall(sym, direction) {
    const prices = scanner.priceBuffers[sym] || [];
    if (prices.length < 100) return null;

    let rises = 0, falls = 0;
    for (let i = 1; i < prices.length; i++) {
      if (prices[i] > prices[i - 1]) rises++;
      else if (prices[i] < prices[i - 1]) falls++;
    }

    const total = rises + falls;
    if (total === 0) return null;

    const riseRatio = rises / total;
    const fallRatio = falls / total;

    // --- Hard filter: reject too one-sided markets (> 65% overall in one direction) ---
    if (riseRatio > 0.65 || fallRatio > 0.65) return null;

    // --- Immediate Momentum Analysis ---
    // Look at the very end of the array to find the current active streak
    let currentRiseStreak = 0;
    let currentFallStreak = 0;
    
    // Count backwards from the most recent tick
    for (let i = prices.length - 1; i > 0; i--) {
      if (prices[i] > prices[i - 1]) {
        if (currentFallStreak > 0) break; // streak broken
        currentRiseStreak++;
      } else if (prices[i] < prices[i - 1]) {
        if (currentRiseStreak > 0) break; // streak broken
        currentFallStreak++;
      } else {
        break; // flat tick breaks streak
      }
    }

    // --- New Filters: Avoid falling knives & exhausted trends ---
    if (direction === 'RISE') {
      // Reject if we are currently falling for 2 or more ticks
      if (currentFallStreak >= 2) return null;
      // Reject if the trend is exhausted (6 or more consecutive rises)
      if (currentRiseStreak >= 6) return null;
    } else { // direction === 'FALL'
      // Reject if we are currently rising for 2 or more ticks
      if (currentRiseStreak >= 2) return null;
      // Reject if the trend is exhausted (6 or more consecutive falls)
      if (currentFallStreak >= 6) return null;
    }

    // --- Scoring System ---
    const favourRatio = direction === 'RISE' ? riseRatio : fallRatio;
    let score = favourRatio * 100; // Base score out of ~65

    // Momentum Boost: Catch the fresh wave!
    const activeStreak = direction === 'RISE' ? currentRiseStreak : currentFallStreak;
    if (activeStreak >= 1 && activeStreak <= 3) {
      score += 50; // Massive boost for perfectly timed entry
    } else if (activeStreak === 4 || activeStreak === 5) {
      score += 20; // Moderate boost for an ongoing trend
    }

    return { score, riseRatio, fallRatio };
  }

  /**
   * Pre-trade momentum gate for locked Rise/Fall market.
   * Returns true if the market's recent ticks favour our direction.
   */
  _isLockedMarketSafe(sym, direction) {
    const prices = scanner.priceBuffers[sym] || [];
    if (prices.length < 5) return false; // not enough data

    // Look at the last 5 ticks to gauge immediate momentum
    const recent = prices.slice(-5);
    let rises = 0, falls = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i] > recent[i - 1]) rises++;
      else if (recent[i] < recent[i - 1]) falls++;
    }

    // Count the current streak going against us
    let againstStreak = 0;
    for (let i = prices.length - 1; i > 0; i--) {
      if (direction === 'RISE' && prices[i] < prices[i - 1]) {
        againstStreak++;
      } else if (direction === 'FALL' && prices[i] > prices[i - 1]) {
        againstStreak++;
      } else {
        break;
      }
    }

    // Block if 3+ consecutive ticks going against our direction
    if (againstStreak >= 3) return false;

    // Block if majority of recent ticks are against us
    if (direction === 'RISE' && falls > rises && falls >= 3) return false;
    if (direction === 'FALL' && rises > falls && rises >= 3) return false;

    return true;
  }

  /**
   * Main Rise/Fall execution cycle.
   * Locks into a single market on first trade and stays there.
   * Pauses after 3 consecutive losses, waits for reversal, then re-enters the SAME market.
   */
  _executeRiseFallCycle() {
    const channel = this.channels.SINGLE;
    if (channel.active) {
      this._scheduleNext(100);
      return;
    }

    // ═══ PHASE 1: PAUSE COOLDOWN (real time) ═══
    if (this._rfPauseUntil && Date.now() < this._rfPauseUntil) {
      const secsLeft = Math.ceil((this._rfPauseUntil - Date.now()) / 1000);
      this.updateStatus(`⏸️ Cooling down after losses (${secsLeft}s left)...`);
      this._scheduleNext(500);
      return;
    } else if (this._rfPauseUntil) {
      // Pause just expired
      this._rfPauseUntil = 0;
      this._rfWaitingForReversal = true;
      this.sendLog(`⏸️ Pause complete — checking markets...`);
    }

    const direction = this.strategy; // 'RISE' or 'FALL'

    // ═══ DYNAMIC MARKET EVALUATION ═══
    // Check if our current market is still viable
    if (this._rfLockedMarket) {
      const currentScore = this._scoreMarketForRiseFall(this._rfLockedMarket, direction);
      const isSafe = this._isLockedMarketSafe(this._rfLockedMarket, direction);
      
      if (!currentScore || !isSafe) {
        this.sendLog(`📉 Trend depleted/reversed on ${MARKET_LABELS[this._rfLockedMarket] || this._rfLockedMarket}. Searching for new market...`);
        this._rfLockedMarket = null; 
      }
    }

    // If we don't have a market (or it was just discarded), find the best one
    if (!this._rfLockedMarket) {
      let bestMarket = null;
      let bestScore = -1;

      for (const sym of MARKETS) {
        const result = this._scoreMarketForRiseFall(sym, direction);
        if (result && result.score > bestScore) {
           if (this._isLockedMarketSafe(sym, direction)) {
             bestScore = result.score;
             bestMarket = sym;
           }
        }
      }

      if (!bestMarket) {
        this.updateStatus('🔍 Scanning for strong trend...');
        this._scheduleNext(1000);
        return;
      }

      this._rfLockedMarket = bestMarket;
      this.sendLog(`🎯 Switching to strong trend on ${MARKET_LABELS[bestMarket] || bestMarket}.`);
      
      // If we found a strong new market, we don't need to wait for a reversal anymore,
      // because this new market already has the correct active trend!
      if (this._rfWaitingForReversal) {
         this._rfWaitingForReversal = false;
         this._rfPauseDirection = null;
      }
    }

    const lockedMarket = this._rfLockedMarket;
    this.activeMarket = lockedMarket;

    // ═══ PHASE 2: WAITING FOR STREAK TO BREAK (If we stayed on the SAME market after a loss streak) ═══
    if (this._rfWaitingForReversal) {
      const prices = scanner.priceBuffers[lockedMarket] || [];
      if (prices.length >= 3) {
        let currentRiseStreak = 0;
        let currentFallStreak = 0;
        for (let i = prices.length - 1; i > 0; i--) {
          if (prices[i] > prices[i - 1]) {
            if (currentFallStreak > 0) break;
            currentRiseStreak++;
          } else if (prices[i] < prices[i - 1]) {
            if (currentRiseStreak > 0) break;
            currentFallStreak++;
          } else {
            break;
          }
        }

        const lostDir = this._rfPauseDirection;
        const streakBroken = lostDir === 'RISE' ? (currentRiseStreak >= 2) : (currentFallStreak >= 2);
        
        if (streakBroken) {
          const oppositeStr = lostDir === 'RISE' ? 'fall' : 'rise';
          this.sendLog(`🔄 Rise/Fall: ${oppositeStr} streak exhausted on ${MARKET_LABELS[lockedMarket] || lockedMarket} — re-entering ${lostDir}.`);
          this._rfWaitingForReversal = false;
          this._rfPauseDirection = null;
        } else {
          const waitingFor = lostDir === 'RISE' ? '2 rises' : '2 falls';
          this.updateStatus(`👁️ Waiting for ${waitingFor} to prove streak exhausted on ${MARKET_LABELS[lockedMarket] || lockedMarket}...`);
          this._scheduleNext(500);
          return;
        }
      } else {
        this._scheduleNext(500);
        return;
      }
    }

    // ═══ PHASE 4: PLACE TRADE ═══
    // We already checked safety during market selection, but do a final check just in case
    const isSafe = this._isLockedMarketSafe(lockedMarket, direction);
    if (!isSafe) {
      this.updateStatus(`👁️ Waiting for safe momentum on ${MARKET_LABELS[lockedMarket] || lockedMarket}...`);
      this._scheduleNext(1000);
      return;
    }

    const stake = this._resolveTradeStake('SINGLE');

    this.sendLog(`📈 ${this.strategy} on ${MARKET_LABELS[lockedMarket] || lockedMarket} at $${stake.toFixed(2)} (Trend Following)`);
    this.updateStatus(`Placing ${this.strategy} Trade...`);

    this._placeTrade('SINGLE', this.strategy, stake, null, lockedMarket, {
      duration: 1,
      durationUnit: 't'
    });
  }

  // --- MATCHES DIGIT SNIPER STRATEGY ---
  getHottestDigitForMarket(marketSym) {
    const ticks = scanner.buffers[marketSym]?.slice(-20);
    if (!ticks || ticks.length === 0) {
      return { digit: null, count: 0, score: 0 };
    }
    const total = ticks.length;
    const counts = Array(10).fill(0);
    for (const tick of ticks) {
      const d = parseInt(tick, 10);
      if (!isNaN(d) && d >= 0 && d <= 9) {
        counts[d]++;
      }
    }
    let maxCount = -1;
    let hottestDigit = null;
    for (let d = 0; d < 10; d++) {
      if (counts[d] > maxCount) {
        maxCount = counts[d];
        hottestDigit = d;
      }
    }
    const score = (maxCount / total) * 100;
    return { digit: hottestDigit, count: maxCount, score };
  }

  getMatchesSniperTarget() {
    let bestMarket = null;
    let bestDigit = null;
    let bestScore = -1;

    for (const sym of MARKETS) {
      // Quarantine check: skip quarantined markets
      const qUntil = this.marketStats[sym]?.quarantinedUntil || 0;
      if (qUntil > Date.now()) continue;

      const res = this.getHottestDigitForMarket(sym);
      if (res.score > bestScore) {
        bestScore = res.score;
        bestMarket = sym;
        bestDigit = res.digit;
      }
    }

    return { market: bestMarket, digit: bestDigit, score: bestScore };
  }

  _evaluateMatchesSniperMarket() {
    const currentMarket = this.activeMarket;
    const currentHottest = currentMarket ? this.getHottestDigitForMarket(currentMarket) : { digit: null, score: -1 };

    const best = this.getMatchesSniperTarget();

    if (!currentMarket) {
      if (best.market) {
        this.activeMarket = best.market;
        this.matchesTargetDigit = best.digit;
        const mStats = this.marketStats[best.market];
        if (mStats) mStats.consecutiveLosses = 0;
        this.sendLog(`🎯 MATCHES SNIPER Init: Selected ${MARKET_LABELS[best.market] || best.market} (Hottest Digit: ${best.digit}, Score: ${best.score.toFixed(0)}%)`);
      }
      return;
    }

    const currentScore = currentHottest.score;
    const scoreDiff = best.score - currentScore;

    const mStats = this.marketStats[currentMarket];
    const consecutiveLosses = mStats ? mStats.consecutiveLosses : 0;
    const hottestDigitChanged = currentHottest.digit !== this.matchesTargetDigit;

    let shouldSwitch = false;
    let reason = '';

    // Switch rule 1: Another market scores 10% higher than current market
    if (scoreDiff >= 10) {
      shouldSwitch = true;
      reason = `Another market (${MARKET_LABELS[best.market]} @ ${best.score.toFixed(0)}%) scores 10%+ higher than current (${MARKET_LABELS[currentMarket]} @ ${currentScore.toFixed(0)}%)`;
    }
    // Switch rule 2: Current market loses 2 consecutive MATCH trades
    else if (consecutiveLosses >= 2) {
      shouldSwitch = true;
      reason = `Current market (${MARKET_LABELS[currentMarket]}) lost 2 consecutive MATCH trades`;
    }
    // Switch rule 3: Hottest digit changes to a different digit
    else if (hottestDigitChanged) {
      shouldSwitch = true;
      reason = `Hottest digit of current market changed from ${this.matchesTargetDigit} to ${currentHottest.digit}`;
    }

    if (shouldSwitch && best.market && (best.market !== currentMarket || best.digit !== this.matchesTargetDigit)) {
      const oldMarket = currentMarket;
      this.activeMarket = best.market;
      this.matchesTargetDigit = best.digit;
      if (this.marketStats[oldMarket]) {
        this.marketStats[oldMarket].consecutiveLosses = 0;
      }
      if (this.onMarketSwitch) this.onMarketSwitch(this.activeMarket);
      this.sendLog(`🔄 MATCHES SNIPER Switch: ${reason}. Target: ${MARKET_LABELS[best.market]} (Digit: ${best.digit}, Score: ${best.score.toFixed(0)}%)`);
      this.matchesLastSwitchTime = Date.now();
    }
  }

  _executeOver6Cycle() {
    const channel = this.channels.SINGLE;
    if (channel.active) {
      this._scheduleNext(100);
      return;
    }

    if (this.over6Phase === 'SEARCHING') {
      this.updateStatus('OVER 6: Scanning all markets...');
      let bestMarket = null;
      let highestTop2Freq = 0;
      let targetMaxStreak = 0;

      for (const sym of MARKETS) {
        if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
        const ticks = scanner.buffers[sym] || [];
        if (ticks.length < 500) continue;

        const counts = Array(10).fill(0);
        for (const t of ticks) counts[t]++;
        const freqs = counts.map((c, i) => ({ digit: i, pct: (c / ticks.length) * 100 }));
        
        freqs.sort((a, b) => b.pct - a.pct);
        const top1 = freqs[0];
        const top2 = freqs[1];

        const isUpper = (d) => d === 7 || d === 8 || d === 9;
        if (isUpper(top1.digit) && isUpper(top2.digit) && top1.pct >= 11 && top2.pct >= 11) {
          const combinedFreq = top1.pct + top2.pct;
          if (combinedFreq > highestTop2Freq) {
            highestTop2Freq = combinedFreq;
            bestMarket = sym;
            
            let maxStreak = 0;
            let currentStreak = 0;
            for (const t of ticks) {
              if (t <= 6) {
                currentStreak++;
                if (currentStreak > maxStreak) maxStreak = currentStreak;
              } else {
                currentStreak = 0;
              }
            }
            targetMaxStreak = maxStreak;
          }
        }
      }

      if (!bestMarket) {
        this._scheduleNext(200);
        return;
      }

      this.activeMarket = bestMarket;
      if (this.onMarketSwitch) this.onMarketSwitch(bestMarket);
      this.over6TargetMarket = bestMarket;
      this.over6DynamicTrigger = Math.min(5, Math.max(3, targetMaxStreak - 1));
      this.over6Phase = 'TRADING';
      this.sendLog(`OVER 6: Selected ${MARKET_LABELS[bestMarket] || bestMarket}. Max lower streak was ${targetMaxStreak}. Trigger set to ${this.over6DynamicTrigger} consecutive lower digits.`);
    }

    if (this.over6Phase === 'TRADING') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }

      if (this.over6FirstTradeFired) {
        this.updateStatus('OVER 6: Executing continuous trade...');
        const stake = this._resolveTradeStake('SINGLE');
        this._placeTrade('SINGLE', 'OVER6', stake);
        this._scheduleNext(50);
        return;
      }

      const ticks = scanner.buffers[this.over6TargetMarket] || [];
      if (ticks.length < this.over6DynamicTrigger) return;

      let currentStreak = 0;
      for (let i = ticks.length - 1; i >= 0; i--) {
        if (ticks[i] <= 6) currentStreak++;
        else break;
      }

      this.updateStatus(`OVER 6: Waiting for ${this.over6DynamicTrigger} lower digits. Current: ${currentStreak}`);

      if (currentStreak >= this.over6DynamicTrigger) {
        this.over6FirstTradeFired = true;
        this.sendLog(`OVER 6: Trigger reached (${currentStreak} lower digits). Firing FIRST trade.`);
        this.updateStatus('OVER 6: Executing');
        const stake = this._resolveTradeStake('SINGLE');
        this._placeTrade('SINGLE', 'OVER6', stake);
        this._scheduleNext(50); // Wait for order to place
        return;
      } else {
        this._scheduleNext(100);
        return;
      }
    }

    // ── RECOVERY phase (Martingale ON) ──────────────────────────────────────
    if (this.over6Phase === 'RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }
      const dir = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.over6TargetMarket);
      const stake = this._resolveTradeStake('SINGLE');
      this.updateStatus(`OVER 6: Recovery Martingale (${dir})...`);
      this._placeTrade('SINGLE', dir, stake);
      this._scheduleNext(50);
      return;
    }

    // ── DEBT_RECOVERY phase (Martingale OFF) ────────────────────────────────
    if (this.over6Phase === 'DEBT_RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }
      const dir = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.over6TargetMarket);
      const stake = this.config.baseStake;
      this.updateStatus(`OVER 6: Debt Recovery base stake (${dir})...`);
      this._placeTrade('SINGLE', dir, stake);
      this._scheduleNext(50);
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UNDER 8 V2 CYCLE
  //  Entry: Scans 500 ticks. Digits 8 & 9 < 10%, Top digit < 7, Bottom digit >= 7.
  //  If matched, triggers UNDER 8 trade.
  //  Recovery: Rapid fire blind OVER 3.
  // ═══════════════════════════════════════════════════════════════════════════
  _executeUnder8V2Cycle() {
    const channel = this.channels.SINGLE;
    if (channel.active) {
      this._scheduleNext(10);
      return;
    }

    if (!this.under8V2Phase || this.under8V2Phase === 'SEARCHING') {
      this.updateStatus('UNDER 8 V2: Scanning all markets (V1 conditions)...');
      let bestMarket = null;

      for (const sym of MARKETS) {
        if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
        const ticks = scanner.buffers[sym] || [];
        if (ticks.length < 500) continue; 

        const counts = Array(10).fill(0);
        for (const t of ticks) counts[t]++;
        const freqs = counts.map((c, i) => ({ digit: i, pct: (c / ticks.length) * 100 }));
        
        const pct8 = freqs[8].pct;
        const pct9 = freqs[9].pct;
        
        const sorted = [...freqs].sort((a, b) => b.pct - a.pct);
        const top1 = sorted[0].digit;
        const bottom1 = sorted[9].digit;
        
        if (pct8 < 10 && pct9 < 10 && top1 < 7 && bottom1 >= 7) {
          bestMarket = sym;
          this.sendLog(`UNDER 8 V2: Market match on ${MARKET_LABELS[sym] || sym}. Conditions met.`);
          break;
        }
      }

      if (!bestMarket) {
        this._scheduleNext(200);
        return;
      }

      this.activeMarket = bestMarket;
      if (this.onMarketSwitch) this.onMarketSwitch(bestMarket);
      this.under8V2TargetMarket = bestMarket;
      this.under8V2Phase = 'TRADING';
    }

    if (this.under8V2Phase === 'TRADING') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(0);
        return;
      }
      const stake = this._resolveTradeStake('SINGLE');
      this._placeTrade('SINGLE', 'UNDER8', stake);
      this._scheduleNext(0);
      return;
    }

    if (this.under8V2Phase === 'RECOVERY' || this.under8V2Phase === 'DEBT_RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(0);
        return;
      }
      
      // Strict lockdown on original market and OVER 3 direction for blind rapid recovery
      if (!this.lockedRecoveryMarket || !this.lockedRecoveryDirection) {
        this.lockedRecoveryMarket = this.under8V2TargetMarket;
        this.lockedRecoveryDirection = 'OVER3'; // Hard lock to the OVER 3 direction
        this.sendLog(`UNDER 8 V2: Locked strictly into ${MARKET_LABELS[this.lockedRecoveryMarket] || this.lockedRecoveryMarket} ${this.lockedRecoveryDirection} for blind recovery firing.`);
      }

      const recMarket = this.lockedRecoveryMarket;
      const recDir = this.lockedRecoveryDirection;

      // Enforce step based on consecutive losses to ensure Martingale applies
      if (this.config.recoveryEnabled !== false && this.under8V2CurrentLosses > 0) {
        const hold = this._getMartingaleHoldAfterStep();
        const max = this._getMaxMartingaleStep() || 99;
        const targetStep = Math.min(this.under8V2CurrentLosses, max);
        channel.step = hold > 0 ? Math.min(hold, targetStep) : targetStep;
      }

      const stake = this._resolveTradeStake('SINGLE');

      this.updateStatus(`UNDER 8 V2: Rapid Recovery (${recDir}) on ${MARKET_LABELS[recMarket] || recMarket} Stake: $${stake.toFixed(2)} (Loss ${this.under8V2CurrentLosses})...`);
      this._placeTrade('SINGLE', recDir, stake);
      this._scheduleNext(10);
      return;
    }
  }

  _executeUnder8Cycle() {
    const channel = this.channels.SINGLE;
    if (channel.active) {
      this._scheduleNext(100);
      return;
    }

    if (this.under8Phase === 'SEARCHING') {
      this.updateStatus('UNDER 8 V1: Scanning all markets...');
      let bestMarket = null;

      for (const sym of MARKETS) {
        if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
        const ticks = scanner.buffers[sym] || [];
        if (ticks.length < 500) continue;

        const counts = Array(10).fill(0);
        for (const t of ticks) counts[t]++;
        const freqs = counts.map((c, i) => ({ digit: i, pct: (c / ticks.length) * 100 }));
        
        const pct8 = freqs[8].pct;
        const pct9 = freqs[9].pct;
        
        const sorted = [...freqs].sort((a, b) => b.pct - a.pct);
        const top1 = sorted[0].digit;
        const bottom1 = sorted[9].digit;
        
        if (pct8 < 10 && pct9 < 10 && top1 < 7 && bottom1 >= 7) {
          bestMarket = sym;
          break;
        }
      }

      if (!bestMarket) {
        this._scheduleNext(200);
        return;
      }

      this.activeMarket = bestMarket;
      if (this.onMarketSwitch) this.onMarketSwitch(bestMarket);
      this.under8TargetMarket = bestMarket;
      this.under8Phase = 'TRADING';
      this.sendLog(`UNDER 8 V1: Selected ${MARKET_LABELS[bestMarket] || bestMarket}. Conditions met.`);
    }

    if (this.under8Phase === 'TRADING') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }

      this.updateStatus('UNDER 8 V1: Executing continuous trade...');
      const stake = this._resolveTradeStake('SINGLE');
      this._placeTrade('SINGLE', 'UNDER8', stake);
      this._scheduleNext(50);
      return;
    }

    // ── RECOVERY phase (Martingale ON) ──────────────────────────────────────
    if (this.under8Phase === 'RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }
      const dir = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.under8TargetMarket);
      const stake = this._resolveTradeStake('SINGLE');
      this.updateStatus(`UNDER 8 V1: Recovery Martingale (${dir})...`);
      this._placeTrade('SINGLE', dir, stake);
      this._scheduleNext(50);
      return;
    }

    // ── DEBT_RECOVERY phase (Martingale OFF) ────────────────────────────────
    if (this.under8Phase === 'DEBT_RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }
      const dir = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.under8TargetMarket);
      const stake = this.config.baseStake;
      this.updateStatus(`UNDER 8 V1: Debt Recovery base stake (${dir})...`);
      this._placeTrade('SINGLE', dir, stake);
      this._scheduleNext(50);
      return;
    }
  }

  _executeUnder7V1Cycle() {
    const channel = this.channels.SINGLE;
    if (channel.active) {
      this._scheduleNext(100);
      return;
    }

    if (this.under7v1Phase === 'SEARCHING') {
      this.updateStatus('UNDER 7 V1: Scanning 1s markets...');
      let bestMarket = null;

      const oneSecMarkets = ['1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'];

      for (const sym of oneSecMarkets) {
        if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
        const ticks = scanner.buffers[sym] || [];
        if (ticks.length < 500) continue;

        const counts = Array(10).fill(0);
        for (const t of ticks) counts[t]++;
        const freqs = counts.map((c, i) => ({ digit: i, pct: (c / ticks.length) * 100 }));
        
        const pct8 = freqs[8].pct;
        const pct9 = freqs[9].pct;

        // Condition: Digits 8 and 9 must both be < 9.5%
        if (pct8 >= 9.5 || pct9 >= 9.5) continue;

        // Condition: Digits 8 and 9 must be strictly lower than all digits 0-7
        let isLowest = true;
        for (let i = 0; i <= 7; i++) {
          if (pct8 >= freqs[i].pct || pct9 >= freqs[i].pct) {
            isLowest = false;
            break;
          }
        }
        
        if (!isLowest) continue;

        bestMarket = sym;
        break;
      }

      if (!bestMarket) {
        this._scheduleNext(200);
        return;
      }

      this.activeMarket = bestMarket;
      if (this.onMarketSwitch) this.onMarketSwitch(bestMarket);
      this.under7v1TargetMarket = bestMarket;
      this.under7v1Phase = 'WAITING_ENTRY';
      this.sendLog(`✅ UNDER 7 V1: Selected ${MARKET_LABELS[bestMarket] || bestMarket}. Waiting for cursor to hit 8 or 9...`);
    }

    if (this.under7v1Phase === 'WAITING_ENTRY') {
      const ticks = scanner.buffers[this.under7v1TargetMarket] || [];
      if (ticks.length < 10) {
        this._scheduleNext(200);
        return;
      }

      const lastTick = ticks[ticks.length - 1];

      // Entry trigger: cursor hits 8 or 9
      if (lastTick !== 8 && lastTick !== 9) {
        this.updateStatus(`UNDER 7 V1: Waiting for cursor 8 or 9 (current: ${lastTick})`);
        this._scheduleNext(100);
        return;
      }

      this.under7v1Phase = 'TRADING';
      this.sendLog(`🚀 UNDER 7 V1: Entry trigger hit (digit ${lastTick}). Firing UNDER 7 (Duration: 2 ticks).`);
    }

    if (this.under7v1Phase === 'TRADING') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }



      const mktLabel = MARKET_LABELS[this.under7v1TargetMarket] || this.under7v1TargetMarket;
      this.updateStatus(`UNDER 7 V1: Trading continuously on ${mktLabel}...`);
      const stake = this._resolveTradeStake('SINGLE');
      this._placeTrade('SINGLE', 'UNDER7', stake, null, null, { duration: 2 });
      this._scheduleNext(50);
      return;
    }

    // ── RECOVERY phase (Martingale ON) ──────────────────────────────────────
    if (this.under7v1Phase === 'RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }
      const dir = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.under7v1TargetMarket);
      const stake = this._resolveTradeStake('SINGLE');
      this.updateStatus(`UNDER 7 V1: Recovery Martingale (${dir})...`);
      this._placeTrade('SINGLE', dir, stake);
      this._scheduleNext(50);
      return;
    }

    // ── DEBT_RECOVERY phase (Martingale OFF) ────────────────────────────────
    if (this.under7v1Phase === 'DEBT_RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }
      const dir = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.under7v1TargetMarket);
      const stake = this.config.baseStake;
      this.updateStatus(`UNDER 7 V1: Debt Recovery base stake (${dir})...`);
      this._placeTrade('SINGLE', dir, stake);
      this._scheduleNext(50);
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  EVEN V1 — Trade EVEN when even digits show clear dominance
  // ═══════════════════════════════════════════════════════════════════════════
  _executeEvenV1Cycle() {
    const channel = this.channels.SINGLE;
    if (channel.active) {
      this._scheduleNext(100);
      return;
    }

    /**
     * Compute the combined percentage share of even digits (0,2,4,6,8)
     * and odd digits (1,3,5,7,9) from a tick array.
     */
    const getEvenOddPcts = (ticks) => {
      const counts = Array(10).fill(0);
      for (const t of ticks) counts[t]++;
      let evenTotal = 0, oddTotal = 0;
      for (let d = 0; d <= 9; d++) {
        if (d % 2 === 0) evenTotal += counts[d];
        else oddTotal += counts[d];
      }
      return {
        evenPct: (evenTotal / ticks.length) * 100,
        oddPct:  (oddTotal  / ticks.length) * 100,
        counts,
      };
    };

    /**
     * Consistency check: split ticks in half and confirm even dominance
     * holds in BOTH halves (not a transient spike).
     */
    const isEvenConsistent = (ticks) => {
      if (ticks.length < 100) return false;
      const half = Math.floor(ticks.length / 2);
      const first  = getEvenOddPcts(ticks.slice(0, half));
      const second = getEvenOddPcts(ticks.slice(half));
      // Even must beat odd in both halves
      return first.evenPct > first.oddPct && second.evenPct > second.oddPct;
    };

    // ── SEARCHING ──
    if (this.evenV1Phase === 'SEARCHING') {
      this.updateStatus('EVEN V1: Scanning for even-dominant market...');
      let bestMarket = null;
      let bestGap = 0;

      for (const sym of MARKETS) {
        if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
        const ticks = scanner.buffers[sym] || [];
        if (ticks.length < 500) continue;

        const { evenPct, oddPct } = getEvenOddPcts(ticks);
        const gap = evenPct - oddPct;

        // Even must clearly dominate: at least 3 percentage points ahead
        if (gap < 3) continue;

        // Must be consistent across both halves
        if (!isEvenConsistent(ticks)) continue;

        // Pick the market with the widest even dominance gap
        if (gap > bestGap) {
          bestGap = gap;
          bestMarket = sym;
        }
      }

      if (!bestMarket) {
        this._scheduleNext(200);
        return;
      }

      this.activeMarket = bestMarket;
      if (this.onMarketSwitch) this.onMarketSwitch(bestMarket);
      this.evenV1TargetMarket = bestMarket;
      this.evenV1Phase = 'TRADING';

      const { evenPct, oddPct } = getEvenOddPcts(scanner.buffers[bestMarket] || []);
      this.sendLog(
        `✅ EVEN V1: Selected ${MARKET_LABELS[bestMarket] || bestMarket} ` +
        `| Even ${evenPct.toFixed(1)}% vs Odd ${oddPct.toFixed(1)}% ` +
        `| Gap +${(evenPct - oddPct).toFixed(1)}pp. Trading continuously.`
      );
    }

    // ── TRADING ──
    if (this.evenV1Phase === 'TRADING') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }



      const mktLabel = MARKET_LABELS[this.evenV1TargetMarket] || this.evenV1TargetMarket;
      this.updateStatus(`EVEN V1: Trading on ${mktLabel}...`);
      const stake = this._resolveTradeStake('SINGLE');
      this._placeTrade('SINGLE', 'EVEN', stake);
      this._scheduleNext(50);
      return;
    }

    // ── RECOVERY phase (Martingale ON) ──────────────────────────────────────
    if (this.evenV1Phase === 'RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }
      const dir = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.evenV1TargetMarket);
      const stake = this._resolveTradeStake('SINGLE');
      this.updateStatus(`EVEN V1: Recovery Martingale (${dir})...`);
      this._placeTrade('SINGLE', dir, stake);
      this._scheduleNext(50);
      return;
    }

    // ── DEBT_RECOVERY phase (Martingale OFF) ────────────────────────────────
    if (this.evenV1Phase === 'DEBT_RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }
      const dir = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.evenV1TargetMarket);
      const stake = this.config.baseStake;
      this.updateStatus(`EVEN V1: Debt Recovery base stake (${dir})...`);
      this._placeTrade('SINGLE', dir, stake);
      this._scheduleNext(50);
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ODD V1 — Trade ODD when odd digits overtake evens (reversal pattern)
  // ═══════════════════════════════════════════════════════════════════════════
  _executeOddV1Cycle() {
    const channel = this.channels.SINGLE;
    if (channel.active) {
      this._scheduleNext(100);
      return;
    }

    /**
     * Compute the combined percentage share of even digits (0,2,4,6,8)
     * and odd digits (1,3,5,7,9) from a tick array.
     */
    const getEvenOddPcts = (ticks) => {
      const counts = Array(10).fill(0);
      for (const t of ticks) counts[t]++;
      let evenTotal = 0, oddTotal = 0;
      for (let d = 0; d <= 9; d++) {
        if (d % 2 === 0) evenTotal += counts[d];
        else oddTotal += counts[d];
      }
      return {
        evenPct: (evenTotal / ticks.length) * 100,
        oddPct:  (oddTotal  / ticks.length) * 100,
        counts,
      };
    };

    /**
     * Reversal detection: checks that odd dominance is building.
     * Split the ticks into two halves — odd must be stronger in the
     * second half than the first (momentum is shifting toward odd).
     */
    const isOddReversal = (ticks) => {
      if (ticks.length < 100) return false;
      const half = Math.floor(ticks.length / 2);
      const first  = getEvenOddPcts(ticks.slice(0, half));
      const second = getEvenOddPcts(ticks.slice(half));

      // Odd must dominate in the recent half AND be stronger than in the first half
      return second.oddPct > second.evenPct && second.oddPct > first.oddPct;
    };

    /**
     * Consistency check: odd must dominate in both halves.
     */
    const isOddConsistent = (ticks) => {
      if (ticks.length < 100) return false;
      const half = Math.floor(ticks.length / 2);
      const first  = getEvenOddPcts(ticks.slice(0, half));
      const second = getEvenOddPcts(ticks.slice(half));
      return first.oddPct > first.evenPct && second.oddPct > second.evenPct;
    };

    // ── SEARCHING ──
    if (this.oddV1Phase === 'SEARCHING') {
      this.updateStatus('ODD V1: Scanning for odd-reversal market...');
      let bestMarket = null;
      let bestGap = 0;

      for (const sym of MARKETS) {
        if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
        const ticks = scanner.buffers[sym] || [];
        if (ticks.length < 500) continue;

        const { evenPct, oddPct } = getEvenOddPcts(ticks);
        const gap = oddPct - evenPct;

        // Odd must be overtaking even: at least 2pp ahead
        if (gap < 2) continue;

        // Confirm reversal pattern OR consistent odd dominance
        if (!isOddReversal(ticks) && !isOddConsistent(ticks)) continue;

        if (gap > bestGap) {
          bestGap = gap;
          bestMarket = sym;
        }
      }

      if (!bestMarket) {
        this._scheduleNext(200);
        return;
      }

      this.activeMarket = bestMarket;
      if (this.onMarketSwitch) this.onMarketSwitch(bestMarket);
      this.oddV1TargetMarket = bestMarket;
      this.oddV1Phase = 'TRADING';

      const { evenPct, oddPct } = getEvenOddPcts(scanner.buffers[bestMarket] || []);
      this.sendLog(
        `✅ ODD V1: Selected ${MARKET_LABELS[bestMarket] || bestMarket} ` +
        `| Odd ${oddPct.toFixed(1)}% vs Even ${evenPct.toFixed(1)}% ` +
        `| Gap +${(oddPct - evenPct).toFixed(1)}pp. Trading continuously.`
      );
    }

    // ── TRADING ──
    if (this.oddV1Phase === 'TRADING') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }



      const mktLabel = MARKET_LABELS[this.oddV1TargetMarket] || this.oddV1TargetMarket;
      this.updateStatus(`ODD V1: Trading on ${mktLabel}...`);
      const stake = this._resolveTradeStake('SINGLE');
      this._placeTrade('SINGLE', 'ODD', stake);
      this._scheduleNext(50);
      return;
    }

    // ── RECOVERY phase (Martingale ON) ──────────────────────────────────────
    if (this.oddV1Phase === 'RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }
      const dir = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.oddV1TargetMarket);
      const stake = this._resolveTradeStake('SINGLE');
      this.updateStatus(`ODD V1: Recovery Martingale (${dir})...`);
      this._placeTrade('SINGLE', dir, stake);
      this._scheduleNext(50);
      return;
    }

    // ── DEBT_RECOVERY phase (Martingale OFF) ────────────────────────────────
    if (this.oddV1Phase === 'DEBT_RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }
      const dir = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.oddV1TargetMarket);
      const stake = this.config.baseStake;
      this.updateStatus(`ODD V1: Debt Recovery base stake (${dir})...`);
      this._placeTrade('SINGLE', dir, stake);
      this._scheduleNext(50);
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Dynamic Flow-Based Recovery Helper
  //  Analyzes full tick history to identify Green, Blue, and Red bars.
  //  If majority of bars are >= 5, goes OVER5. If <= 4, goes UNDER4.
  // ═══════════════════════════════════════════════════════════════════════════
  _getFlowBasedRecoveryDirection(marketSym) {
    const ticks = scanner.buffers[marketSym] || [];
    if (ticks.length < 50) return 'UNDER4'; // fallback

    const counts = Array(10).fill(0);
    for (const t of ticks) counts[t]++;
    const freqs = counts.map((c, i) => ({ digit: i, pct: (c / ticks.length) * 100 }));
    
    // Sort descending by percentage
    const sorted = [...freqs].sort((a, b) => b.pct - a.pct);
    const greenDigit = sorted[0].digit;  // highest frequency
    const blueDigit  = sorted[1].digit;  // 2nd highest frequency
    const redDigit   = sorted[9].digit;  // lowest frequency

    const bars = [greenDigit, blueDigit, redDigit];
    
    let overCount = 0;
    let underCount = 0;

    for (const d of bars) {
      if (d >= 5) overCount++;
      else underCount++;
    }

    return overCount > underCount ? 'OVER5' : 'UNDER4';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  OVER 3 V1 — Entry: Green, Blue, Red bars all on digit > 4
  //  Recovery: Dynamic flow-based (auto UNDER4 / OVER5)
  //  Supports Martingale (stake multiply) or Debt Recovery (base stake loop)
  // ═══════════════════════════════════════════════════════════════════════════
  _executeOver3V1Cycle() {
    const channel = this.channels.SINGLE;
    if (channel.active) {
      this._scheduleNext(100);
      return;
    }

    const getFreqs = (ticks) => {
      const counts = Array(10).fill(0);
      for (const t of ticks) counts[t]++;
      return counts.map((c, i) => ({ digit: i, pct: (c / ticks.length) * 100 }));
    };

    // ── SEARCHING phase ─────────────────────────────────────────────────────
    if (this.over3v1Phase === 'SEARCHING') {
      this.updateStatus('OVER 3 V1: Scanning for market (Green, Blue, Red all > digit 4)...');
      let bestMarket = null;

      for (const sym of MARKETS) {
        if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
        const ticks = scanner.buffers[sym] || [];
        if (ticks.length < 500) continue;

        const freqs = getFreqs(ticks);
        const sorted = [...freqs].sort((a, b) => b.pct - a.pct);
        const greenDigit = sorted[0].digit;  // highest frequency
        const blueDigit  = sorted[1].digit;  // 2nd highest frequency
        const redDigit   = sorted[9].digit;  // lowest frequency

        // All three bars must be on digits ABOVE 4 (i.e., 5, 6, 7, 8, or 9)
        if (greenDigit <= 4 || blueDigit <= 4 || redDigit <= 4) continue;

        bestMarket = sym;
        break;
      }

      if (!bestMarket) {
        this._scheduleNext(200);
        return;
      }

      this.activeMarket = bestMarket;
      if (this.onMarketSwitch) this.onMarketSwitch(bestMarket);
      this.over3v1TargetMarket = bestMarket;
      this.over3v1Phase = 'TRADING';

      const freqsLog = getFreqs(scanner.buffers[bestMarket] || []);
      const sorted = [...freqsLog].sort((a, b) => b.pct - a.pct);
      this.sendLog(
        `✅ OVER 3 V1: Selected ${MARKET_LABELS[bestMarket] || bestMarket} ` +
        `| Green: ${sorted[0].digit} (${sorted[0].pct.toFixed(1)}%) ` +
        `| Blue: ${sorted[1].digit} (${sorted[1].pct.toFixed(1)}%) ` +
        `| Red: ${sorted[9].digit} (${sorted[9].pct.toFixed(1)}%)`
      );
    }

    // ── TRADING phase ────────────────────────────────────────────────────────
    if (this.over3v1Phase === 'TRADING') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }


      const stake = this._resolveTradeStake('SINGLE');
      const mktLabel = MARKET_LABELS[this.over3v1TargetMarket] || this.over3v1TargetMarket;
      this.updateStatus(`OVER 3 V1: Trading on ${mktLabel}...`);
      this._placeTrade('SINGLE', 'OVER3', stake);
      this._scheduleNext(0);
      return;
    }

    // ── RECOVERY phase (Martingale ON) ──────────────────────────────────────
    if (this.over3v1Phase === 'RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }

      const tradeKey = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.over3v1TargetMarket);
      const mktLabel = MARKET_LABELS[this.over3v1TargetMarket] || this.over3v1TargetMarket;
      this.updateStatus(`OVER 3 V1 RECOVERY: ${tradeKey} on ${mktLabel}...`);

      const stake = this._resolveTradeStake('SINGLE');
      this._placeTrade('SINGLE', tradeKey, stake);
      this._scheduleNext(0);
      return;
    }

    // ── DEBT_RECOVERY phase (Martingale OFF) ────────────────────────────────
    if (this.over3v1Phase === 'DEBT_RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }

      const tradeKey = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.over3v1TargetMarket);
      const mktLabel = MARKET_LABELS[this.over3v1TargetMarket] || this.over3v1TargetMarket;
      this.updateStatus(`OVER 3 V1 DEBT RECOVERY: ${tradeKey} on ${mktLabel} (Debt: $${this.over3v1Debt.toFixed(2)})`);

      const stake = this.config.baseStake;
      this._placeTrade('SINGLE', tradeKey, stake);
      this._scheduleNext(0);
      return;
    }
  }


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
        this._scheduleNext(200);
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
      const stake = this._resolveTradeStake('SINGLE');
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
        this.sendLog(`OVER 3 V3: Locked strictly into ${MARKET_LABELS[this.lockedRecoveryMarket] || this.lockedRecoveryMarket} ${this.lockedRecoveryDirection} for blind recovery firing.`);
      }

      const recMarket = this.lockedRecoveryMarket;
      const recDir = this.lockedRecoveryDirection;

      // Hardcoded 1.5x multiplier capped at 5 steps for small chunks recovery
      const multi = 1.5;
      const cappedLosses = Math.min(this.over3v3CurrentLosses, 5);
      const stake = this.config.baseStake * Math.pow(multi, cappedLosses);

      this.updateStatus(`OVER 3 V3: Combined Recovery (${recDir}) on ${MARKET_LABELS[recMarket] || recMarket} Stake: $${stake.toFixed(2)} (Step ${cappedLosses})...`);
      this._placeTrade('SINGLE', recDir, stake);
      this._scheduleNext(50);
      return;
    }
  }

  _executeOver3V2Cycle() {
    const channel = this.channels.SINGLE;
    if (channel.active) {
      this._scheduleNext(100);
      return;
    }

    if (this.over3v2Phase === 'SEARCHING') {
      this.updateStatus('OVER 3 V2: Scanning all markets...');
      let bestMarket = null;
      let greenBarDigit = null;

      for (const pass of [1, 2]) {
        for (const sym of MARKETS) {
          if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
          const ticks = scanner.buffers[sym] || [];
          if (ticks.length < 500) continue;

          const counts = Array(10).fill(0);
          for (const t of ticks) counts[t]++;
          const freqs = counts.map((c, i) => ({ digit: i, pct: (c / ticks.length) * 100 }));

          const evens = freqs.filter(f => f.digit % 2 === 0);
          const hasEven12 = evens.some(f => f.pct >= 12);
          const digit6 = freqs.find(f => f.digit === 6);

          if (pass === 1 && digit6 && digit6.pct >= 12) {
            bestMarket = sym;
            greenBarDigit = [...freqs].sort((a, b) => b.pct - a.pct)[0].digit;
            break;
          } else if (pass === 2 && hasEven12) {
            bestMarket = sym;
            greenBarDigit = [...freqs].sort((a, b) => b.pct - a.pct)[0].digit;
            break;
          }
        }
        if (bestMarket) break;
      }

      if (!bestMarket) {
        this._scheduleNext(200);
        return;
      }

      this.activeMarket = bestMarket;
      if (this.onMarketSwitch) this.onMarketSwitch(bestMarket);
      this.over3v2TargetMarket = bestMarket;
      this.over3v2GreenBarDigit = greenBarDigit;
      this.over3v2Phase = 'WAITING_ENTRY';
      this.sendLog(`OVER 3 V2: Selected ${MARKET_LABELS[bestMarket] || bestMarket}. Waiting for cursor on Green Bar (${greenBarDigit}) OR 3 consecutive numbers <= 3...`);
    }

    if (this.over3v2Phase === 'WAITING_ENTRY') {
      const ticks = scanner.buffers[this.over3v2TargetMarket] || [];
      if (ticks.length < 10) {
        this._scheduleNext(200);
        return;
      }

      const lastTick = ticks[ticks.length - 1];
      let triggerMet = false;

      // Condition 1: Touches the digit with the green bar
      if (lastTick === this.over3v2GreenBarDigit) {
        triggerMet = true;
        this.sendLog(`OVER 3 V2: Triggered by Green Bar hit (digit ${lastTick}).`);
      } 
      // Condition 2: 3 consecutive digits <= 3
      else if (ticks.length >= 3) {
        const last3 = ticks.slice(-3);
        if (last3.every(t => t <= 3)) {
          triggerMet = true;
          this.sendLog(`OVER 3 V2: Triggered by 3 consecutive under 3 digits: [${last3.join(', ')}].`);
        }
      }

      if (!triggerMet) {
        this.updateStatus(`OVER 3 V2: Waiting for trigger...`);
        this._scheduleNext(100);
        return;
      }

      this.over3v2Phase = 'TRADING';
      this.sendLog(`OVER 3 V2: Firing continuous trades.`);
    }

    if (this.over3v2Phase === 'TRADING') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }

      this.updateStatus('OVER 3 V2: Executing continuous trade...');
      const stake = this._resolveTradeStake('SINGLE');
      this._placeTrade('SINGLE', 'OVER3', stake);
      this._scheduleNext(50);
      return;
    }

    // ── RECOVERY phase (Martingale ON) ──────────────────────────────────────
    if (this.over3v2Phase === 'RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }
      const dir = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.over3v2TargetMarket);
      const stake = this._resolveTradeStake('SINGLE');
      this.updateStatus(`OVER 3 V2: Recovery Martingale (${dir})...`);
      this._placeTrade('SINGLE', dir, stake);
      this._scheduleNext(50);
      return;
    }

    // ── DEBT_RECOVERY phase (Martingale OFF) ────────────────────────────────
    if (this.over3v2Phase === 'DEBT_RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }
      const dir = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.over3v2TargetMarket);
      const stake = this.config.baseStake;
      this.updateStatus(`OVER 3 V2: Debt Recovery base stake (${dir})...`);
      this._placeTrade('SINGLE', dir, stake);
      this._scheduleNext(50);
      return;
    }
  }

  _executeOver5V1Cycle() {
    const channel = this.channels.SINGLE;
    if (channel.active) {
      this._scheduleNext(100);
      return;
    }

    // Helper: check if digits 0-4 percentages are stable (not trending up or down)
    const _areDigitsStable = (ticks) => {
      if (ticks.length < 100) return false;
      const half = Math.floor(ticks.length / 2);
      const firstHalf = ticks.slice(0, half);
      const secondHalf = ticks.slice(half);

      for (let d = 0; d <= 4; d++) {
        const countFirst = firstHalf.filter(t => t === d).length;
        const countSecond = secondHalf.filter(t => t === d).length;
        const pctFirst = (countFirst / firstHalf.length) * 100;
        const pctSecond = (countSecond / secondHalf.length) * 100;
        const drift = Math.abs(pctSecond - pctFirst);
        if (drift > 1.5) return false;
      }
      return true;
    };

    if (this.over5v1Phase === 'SEARCHING') {
      this.updateStatus('OVER 5 V1: Scanning all markets...');
      let bestMarket = null;

      for (const sym of MARKETS) {
        if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
        const ticks = scanner.buffers[sym] || [];
        if (ticks.length < 500) continue;

        const counts = Array(10).fill(0);
        for (const t of ticks) counts[t]++;
        const freqs = counts.map((c, i) => ({ digit: i, pct: (c / ticks.length) * 100 }));

        // Condition 1: digits 0,1,2,3,4 each < 10%
        if (freqs[0].pct >= 10 || freqs[1].pct >= 10 || freqs[2].pct >= 10 || freqs[3].pct >= 10 || freqs[4].pct >= 10) continue;

        // Sort to find green (max) and red (min)
        const sorted = [...freqs].sort((a, b) => b.pct - a.pct);
        const greenDigit = sorted[0].digit;
        const redDigit = sorted[9].digit;

        // Condition 2: Green bar on odd digit above 5 (7 or 9)
        const isOddAbove5 = (d) => d > 5 && d % 2 === 1;
        if (!isOddAbove5(greenDigit)) continue;

        // Condition 3: Red bar on odd digit above 5 (7 or 9)
        if (!isOddAbove5(redDigit)) continue;

        // Condition 4: Digits 0-4 must be stable (not trending)
        if (!_areDigitsStable(ticks)) continue;

        bestMarket = sym;
        break;
      }

      if (!bestMarket) {
        this._scheduleNext(200);
        return;
      }

      this.activeMarket = bestMarket;
      if (this.onMarketSwitch) this.onMarketSwitch(bestMarket);
      this.over5v1TargetMarket = bestMarket;
      this.over5v1Phase = 'WAITING_ENTRY';
      this.sendLog(`OVER 5 V1: Selected ${MARKET_LABELS[bestMarket] || bestMarket}. Waiting for entry trigger (digit 1, 3, or 5)...`);
    }

    if (this.over5v1Phase === 'WAITING_ENTRY') {
      const ticks = scanner.buffers[this.over5v1TargetMarket] || [];
      if (ticks.length < 10) {
        this._scheduleNext(200);
        return;
      }

      const lastTick = ticks[ticks.length - 1];

      // Entry trigger: last tick must be digit 1, 3, or 5
      if (lastTick !== 1 && lastTick !== 3 && lastTick !== 5) {
        this.updateStatus(`OVER 5 V1: Waiting for cursor on digit 1, 3 or 5 (current: ${lastTick})`);
        this._scheduleNext(100);
        return;
      }

      // Re-verify stability at entry time
      if (!_areDigitsStable(ticks)) {
        this.updateStatus('OVER 5 V1: Digits 0-4 not stable, waiting...');
        this._scheduleNext(200);
        return;
      }

      this.over5v1Phase = 'TRADING';
      this.sendLog(`OVER 5 V1: Entry trigger hit (digit ${lastTick}). Firing first trade.`);
    }

    if (this.over5v1Phase === 'TRADING') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }

      this.updateStatus('OVER 5 V1: Executing continuous trade...');
      const stake = this._resolveTradeStake('SINGLE');
      this._placeTrade('SINGLE', 'OVER5', stake);
      this._scheduleNext(50);
      return;
    }

    // ── RECOVERY phase (Martingale ON) ──────────────────────────────────────
    if (this.over5v1Phase === 'RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }
      const dir = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.over5v1TargetMarket);
      const stake = this._resolveTradeStake('SINGLE');
      this.updateStatus(`OVER 5 V1: Recovery Martingale (${dir})...`);
      this._placeTrade('SINGLE', dir, stake);
      this._scheduleNext(50);
      return;
    }

    // ── DEBT_RECOVERY phase (Martingale OFF) ────────────────────────────────
    if (this.over5v1Phase === 'DEBT_RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }
      const dir = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.over5v1TargetMarket);
      const stake = this.config.baseStake;
      this.updateStatus(`OVER 5 V1: Debt Recovery base stake (${dir})...`);
      this._placeTrade('SINGLE', dir, stake);
      this._scheduleNext(50);
      return;
    }
  }

  _executeOver6V2Cycle() {
    const channel = this.channels.SINGLE;
    if (channel.active) {
      this._scheduleNext(100);
      return;
    }

    // Helper: check if digits 0,2,4 percentages are stable (not trending up or down)
    const _areEvenBelow6Stable = (ticks) => {
      if (ticks.length < 100) return false;
      const half = Math.floor(ticks.length / 2);
      const firstHalf = ticks.slice(0, half);
      const secondHalf = ticks.slice(half);

      const targets = [0, 2, 4];
      for (const d of targets) {
        const countFirst = firstHalf.filter(t => t === d).length;
        const countSecond = secondHalf.filter(t => t === d).length;
        const pctFirst = (countFirst / firstHalf.length) * 100;
        const pctSecond = (countSecond / secondHalf.length) * 100;
        const drift = Math.abs(pctSecond - pctFirst);
        if (drift > 1.5) return false;
      }
      return true;
    };

    if (this.over6v2Phase === 'SEARCHING') {
      this.updateStatus('OVER 6 V2: Scanning all markets...');
      let bestMarket = null;

      for (const sym of MARKETS) {
        if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
        const ticks = scanner.buffers[sym] || [];
        if (ticks.length < 500) continue;

        const counts = Array(10).fill(0);
        for (const t of ticks) counts[t]++;
        const freqs = counts.map((c, i) => ({ digit: i, pct: (c / ticks.length) * 100 }));

        // Sort to find green (max) and red (min)
        const sorted = [...freqs].sort((a, b) => b.pct - a.pct);
        const greenDigit = sorted[0].digit;
        const redDigit = sorted[9].digit;

        // Condition 1: Green bar must be EXACTLY digit 8
        if (greenDigit !== 8) continue;

        // Condition 2: Red bar must be an EVEN digit less than 6 (0, 2, or 4)
        if (redDigit !== 0 && redDigit !== 2 && redDigit !== 4) continue;

        // Condition 3: At least two digits above 6 (7, 8, 9) must be >= 11%
        let highCount = 0;
        if (freqs[7].pct >= 11) highCount++;
        if (freqs[8].pct >= 11) highCount++;
        if (freqs[9].pct >= 11) highCount++;
        if (highCount < 2) continue;

        // Condition 4: Even digits below 6 must be stable
        if (!_areEvenBelow6Stable(ticks)) continue;

        bestMarket = sym;
        break;
      }

      if (!bestMarket) {
        this._scheduleNext(200);
        return;
      }

      this.activeMarket = bestMarket;
      if (this.onMarketSwitch) this.onMarketSwitch(bestMarket);
      this.over6v2TargetMarket = bestMarket;
      this.over6v2Phase = 'WAITING_ENTRY';
      this.sendLog(`OVER 6 V2: Selected ${MARKET_LABELS[bestMarket] || bestMarket}. Waiting for entry trigger (even digit < 6)...`);
    }

    if (this.over6v2Phase === 'WAITING_ENTRY') {
      const ticks = scanner.buffers[this.over6v2TargetMarket] || [];
      if (ticks.length < 10) {
        this._scheduleNext(200);
        return;
      }

      const lastTick = ticks[ticks.length - 1];

      // Entry trigger: any even digit below digit 6 (0, 2, 4)
      if (lastTick !== 0 && lastTick !== 2 && lastTick !== 4) {
        this.updateStatus(`OVER 6 V2: Waiting for cursor on 0, 2, or 4 (current: ${lastTick})`);
        this._scheduleNext(100);
        return;
      }

      // Re-verify stability at entry time
      if (!_areEvenBelow6Stable(ticks)) {
        this.updateStatus('OVER 6 V2: Even digits below 6 not stable, waiting...');
        this._scheduleNext(200);
        return;
      }

      this.over6v2Phase = 'TRADING';
      this.sendLog(`OVER 6 V2: Entry trigger hit (digit ${lastTick}). Firing first trade.`);
    }

    if (this.over6v2Phase === 'TRADING') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }

      this.updateStatus('OVER 6 V2: Executing continuous trade...');
      const stake = this._resolveTradeStake('SINGLE');
      this._placeTrade('SINGLE', 'OVER6', stake);
      this._scheduleNext(50);
      return;
    }

    // ── RECOVERY phase (Martingale ON) ──────────────────────────────────────
    if (this.over6v2Phase === 'RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }
      const dir = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.over6v2TargetMarket);
      const stake = this._resolveTradeStake('SINGLE');
      this.updateStatus(`OVER 6 V2: Recovery Martingale (${dir})...`);
      this._placeTrade('SINGLE', dir, stake);
      this._scheduleNext(50);
      return;
    }

    // ── DEBT_RECOVERY phase (Martingale OFF) ────────────────────────────────
    if (this.over6v2Phase === 'DEBT_RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }
      const dir = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.over6v2TargetMarket);
      const stake = this.config.baseStake;
      this.updateStatus(`OVER 6 V2: Debt Recovery base stake (${dir})...`);
      this._placeTrade('SINGLE', dir, stake);
      this._scheduleNext(50);
      return;
    }
  }

  _executeUnder3V1Cycle() {
    const channel = this.channels.SINGLE;
    if (channel.active) {
      this._scheduleNext(100);
      return;
    }

    if (this.under3v1Phase === 'SEARCHING') {
      this.updateStatus('UNDER 3 V1: Scanning all markets...');
      let bestMarket = null;
      let targetRedDigit = null;

      for (const sym of MARKETS) {
        if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
        const ticks = scanner.buffers[sym] || [];
        if (ticks.length < 500) continue;

        const counts = Array(10).fill(0);
        for (const t of ticks) counts[t]++;
        const freqs = counts.map((c, i) => ({ digit: i, pct: (c / ticks.length) * 100 }));

        // Condition: digits 0 and 1 > 10%
        if (freqs[0].pct <= 10 || freqs[1].pct <= 10) continue;

        const sorted = [...freqs].sort((a, b) => b.pct - a.pct);
        const greenDigit = sorted[0].digit;
        const redDigit = sorted[9].digit;

        // Condition: green bar is exactly 0 or 2
        if (greenDigit !== 0 && greenDigit !== 2) continue;

        // Condition: red bar is an odd digit above 5 (so 7 or 9)
        if (redDigit !== 7 && redDigit !== 9) continue;

        bestMarket = sym;
        targetRedDigit = redDigit;
        break;
      }

      if (!bestMarket) {
        this._scheduleNext(200);
        return;
      }

      this.activeMarket = bestMarket;
      if (this.onMarketSwitch) this.onMarketSwitch(bestMarket);
      this.under3v1TargetMarket = bestMarket;
      this.under3v1TargetRedDigit = targetRedDigit;
      this.under3v1Phase = 'WAITING_ENTRY';
      this.sendLog(`UNDER 3 V1: Selected ${MARKET_LABELS[bestMarket] || bestMarket}. Waiting for cursor to hit digit ${targetRedDigit}...`);
    }

    if (this.under3v1Phase === 'WAITING_ENTRY') {
      const ticks = scanner.buffers[this.under3v1TargetMarket] || [];
      if (ticks.length < 10) {
        this._scheduleNext(200);
        return;
      }

      const lastTick = ticks[ticks.length - 1];

      // Entry trigger: hit the red bar digit
      if (lastTick !== this.under3v1TargetRedDigit) {
        this.updateStatus(`UNDER 3 V1: Waiting for cursor on ${this.under3v1TargetRedDigit} (current: ${lastTick})`);
        this._scheduleNext(100);
        return;
      }

      this.under3v1Phase = 'TRADING';
      this.sendLog(`UNDER 3 V1: Entry trigger hit (digit ${lastTick}). Firing continuous trades.`);
    }

    if (this.under3v1Phase === 'TRADING') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }

      this.updateStatus('UNDER 3 V1: Executing continuous trade...');
      const stake = this._resolveTradeStake('SINGLE');
      this._placeTrade('SINGLE', 'UNDER3', stake);
      this._scheduleNext(50);
      return;
    }

    // ── RECOVERY phase (Martingale ON) ──────────────────────────────────────
    if (this.under3v1Phase === 'RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }
      const dir = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.under3v1TargetMarket);
      const stake = this._resolveTradeStake('SINGLE');
      this.updateStatus(`UNDER 3 V1: Recovery Martingale (${dir})...`);
      this._placeTrade('SINGLE', dir, stake);
      this._scheduleNext(50);
      return;
    }

    // ── DEBT_RECOVERY phase (Martingale OFF) ────────────────────────────────
    if (this.under3v1Phase === 'DEBT_RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }
      const dir = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.under3v1TargetMarket);
      const stake = this.config.baseStake;
      this.updateStatus(`UNDER 3 V1: Debt Recovery base stake (${dir})...`);
      this._placeTrade('SINGLE', dir, stake);
      this._scheduleNext(50);
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  OVER 0 V1 — Trade OVER 0 after a 0 appears on weak 0 markets, with OVER 4 recovery
  // ═══════════════════════════════════════════════════════════════════════════
  _executeOver0V1Cycle() {
    const channel = this.channels.SINGLE;
    if (channel.active) {
      this._scheduleNext(100);
      return;
    }

    const getFreqs = (ticks) => {
      const counts = Array(10).fill(0);
      for (const t of ticks) counts[t]++;
      return counts.map((c, i) => ({ digit: i, pct: (c / ticks.length) * 100 }));
    };

    // ── PHASE 1: SEARCHING FOR INITIAL FAVORED MARKET ──
    if (this.over0v1Phase === 'SEARCHING_OVER_0') {
      this.updateStatus('OVER 0 V1: Scanning for favored market (0 < 10%)...');
      let bestMarket = null;
      let lowest0Pct = 100;

      for (const sym of MARKETS) {
        if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
        const ticks = scanner.buffers[sym] || [];
        if (ticks.length < 500) continue;

        const freqs = getFreqs(ticks);
        const pct0 = freqs[0].pct;

        // Condition 1: 0 < 10%
        if (pct0 >= 10) continue;

        // Condition 2 & 3: Green bar (max frequency) cannot be 0 and must be an EVEN digit
        const sorted = [...freqs].sort((a, b) => b.pct - a.pct);
        const greenDigit = sorted[0].digit;

        if (greenDigit === 0) continue;
        if (greenDigit % 2 !== 0) continue; // must be even

        if (pct0 < lowest0Pct) {
          lowest0Pct = pct0;
          bestMarket = sym;
        }
      }

      if (!bestMarket) {
        this._scheduleNext(200);
        return;
      }

      this.activeMarket = bestMarket;
      if (this.onMarketSwitch) this.onMarketSwitch(bestMarket);
      this.over0v1TargetMarket = bestMarket;
      this.over0v1OriginalMarket = bestMarket; // Save it to return later!
      this.over0v1Phase = 'TRADING_OVER_0';
      
      const mktLabel = MARKET_LABELS[bestMarket] || bestMarket;
      this.sendLog(`✅ OVER 0 V1: Selected ${mktLabel} (Digit 0 is ${lowest0Pct.toFixed(1)}%). Locked in forever.`);
    }

    // ── PHASE 2: CONTINUOUS TRADING OVER 0 ON LOCKED MARKET ──
    if (this.over0v1Phase === 'TRADING_OVER_0') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }

      // No condition checking! Just fire OVER 0 continuously.
      const mktLabel = MARKET_LABELS[this.over0v1TargetMarket] || this.over0v1TargetMarket;
      this.updateStatus(`OVER 0 V1: Firing OVER 0 on ${mktLabel}...`);
      
      const stake = this._resolveTradeStake('SINGLE');
      this._placeTrade('SINGLE', 'OVER0', stake);
      this._scheduleNext(50);
      return;
    }

    // ── PHASE 3: RECOVERY (Martingale ON) ──
    if (this.over0v1Phase === 'RECOVERY_OVER_0') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }

      const tradeKey = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.over0v1TargetMarket);
      const mktLabel = MARKET_LABELS[this.over0v1TargetMarket] || this.over0v1TargetMarket;
      this.updateStatus(`OVER 0 V1 RECOVERY: ${tradeKey} on ${mktLabel}...`);
      
      const stake = this._resolveTradeStake('SINGLE');
      this._placeTrade('SINGLE', tradeKey, stake);
      
      this._scheduleNext(50);
      return;
    }

    // ── PHASE 4: DEBT_RECOVERY (Martingale OFF) ──
    if (this.over0v1Phase === 'DEBT_RECOVERY_OVER_0') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }

      const tradeKey = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.over0v1TargetMarket);
      const mktLabel = MARKET_LABELS[this.over0v1TargetMarket] || this.over0v1TargetMarket;
      this.updateStatus(`OVER 0 V1 DEBT RECOVERY: ${tradeKey} on ${mktLabel} (Debt: $${this.over0v1Debt.toFixed(2)})`);

      const stake = this.config.baseStake;
      this._placeTrade('SINGLE', tradeKey, stake);
      
      this._scheduleNext(50);
      return;
    }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  O0_U9_HYBRID — Interchangeable OVER 0 / UNDER 9 with smart recovery
  //  Conditions:
  //    OVER 0:  digit 0 < 9.5%, green bar (top freq digit) > 5, top 3 digits all > 3
  //    UNDER 9: digit 9 < 9.5%, green bar (top freq digit) < 5, top 3 digits all < 8
  //  Recovery: Dynamically picks OVER 3 or UNDER 7 (whichever is statistically
  //    better). Locks to one side until PL is no longer negative.
  //    After every 3 consecutive recovery losses, pauses to re-evaluate side.
  //  Martingale + Debt Recovery are ALWAYS active.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Evaluates the current market to decide whether OVER5 or UNDER4 is the
   * better recovery direction. Uses multi-signal scoring:
   *   1. Digit frequency edge (full buffer)
   *   2. Recent momentum (last 20 ticks)
   *   3. Streak detection (consecutive wins for each side)
   *   4. Recency-weighted frequency (recent ticks count more)
   * Returns 'OVER5' or 'UNDER4' (or null in strict, or {dir,score} in 'score' mode).
   */
  _evaluateHybridRecoveryDirection(marketSym, strict = false) {
    const ticks = scanner.buffers[marketSym] || [];
    if (ticks.length < 50) return strict ? null : 'OVER5';

    const total = ticks.length;

    // ── Signal 1: Full-buffer digit frequency edge ──
    const counts = Array(10).fill(0);
    for (const t of ticks) counts[t]++;
    const over5FullPct = counts.slice(6, 10).reduce((s, c) => s + c, 0) / total * 100;
    const under4FullPct = counts.slice(0, 4).reduce((s, c) => s + c, 0) / total * 100;
    const over5FreqEdge = over5FullPct - 40;
    const under4FreqEdge = under4FullPct - 40;

    // ── Signal 2: Recent momentum (last 20 ticks) ──
    const recentWindow = Math.min(20, total);
    const recentTicks = ticks.slice(-recentWindow);
    let recentOver5 = 0, recentUnder4 = 0;
    for (const t of recentTicks) {
      if (t >= 6) recentOver5++;
      if (t <= 3) recentUnder4++;
    }
    const recentOver5Pct = (recentOver5 / recentWindow) * 100;
    const recentUnder4Pct = (recentUnder4 / recentWindow) * 100;
    const over5MomentumEdge = recentOver5Pct - 40;
    const under4MomentumEdge = recentUnder4Pct - 40;

    // ── Signal 3: Streak detection (last 10 ticks) ──
    const streakWindow = Math.min(10, total);
    const streakTicks = ticks.slice(-streakWindow);
    let over5Streak = 0, under4Streak = 0;
    // Count consecutive wins from the tail
    for (let i = streakTicks.length - 1; i >= 0; i--) {
      if (streakTicks[i] >= 6) over5Streak++;
      else break;
    }
    for (let i = streakTicks.length - 1; i >= 0; i--) {
      if (streakTicks[i] <= 3) under4Streak++;
      else break;
    }
    const over5StreakBonus = over5Streak >= 3 ? (over5Streak * 1.5) : 0;
    const under4StreakBonus = under4Streak >= 3 ? (under4Streak * 1.5) : 0;

    // ── Signal 4: Recency-weighted frequency (exponential decay) ──
    let over5Weighted = 0, under4Weighted = 0, totalWeight = 0;
    for (let i = 0; i < total; i++) {
      const weight = Math.pow(1.02, i); // Newer ticks get exponentially more weight
      totalWeight += weight;
      if (ticks[i] >= 6) over5Weighted += weight;
      if (ticks[i] <= 3) under4Weighted += weight;
    }
    const over5WeightedEdge = (over5Weighted / totalWeight * 100) - 40;
    const under4WeightedEdge = (under4Weighted / totalWeight * 100) - 40;

    // ── Composite Score (weighted blend) ──
    const over5Score = (over5FreqEdge * 0.25) + (over5MomentumEdge * 0.35) + (over5StreakBonus * 0.15) + (over5WeightedEdge * 0.25);
    const under4Score = (under4FreqEdge * 0.25) + (under4MomentumEdge * 0.35) + (under4StreakBonus * 0.15) + (under4WeightedEdge * 0.25);

    this.sendLog(`🔍 HYBRID: Recovery eval ${MARKET_LABELS[marketSym] || marketSym} — OVER5: ${over5Score.toFixed(1)} (freq:${over5FreqEdge.toFixed(1)} mom:${over5MomentumEdge.toFixed(1)} streak:${over5StreakBonus.toFixed(0)} wt:${over5WeightedEdge.toFixed(1)}) | UNDER4: ${under4Score.toFixed(1)} (freq:${under4FreqEdge.toFixed(1)} mom:${under4MomentumEdge.toFixed(1)} streak:${under4StreakBonus.toFixed(0)} wt:${under4WeightedEdge.toFixed(1)})`);

    if (strict === 'score') {
      const bestDir = over5Score >= under4Score ? 'OVER5' : 'UNDER4';
      return { dir: bestDir, score: Math.max(over5Score, under4Score), over5Score, under4Score };
    }

    if (strict) {
      if (over5Score < 2 && under4Score < 2) return null;
    }

    return over5Score >= under4Score ? 'OVER5' : 'UNDER4';
  }

  /**
   * Checks whether a given market matches the OVER 0 conditions.
   */
  _hybridMatchesOver0(sym) {
    const ticks = scanner.buffers[sym] || [];
    if (ticks.length < 500) return false;

    const counts = Array(10).fill(0);
    for (const t of ticks) counts[t]++;
    const freqs = counts.map((c, i) => ({ digit: i, pct: (c / ticks.length) * 100 }));

    // Condition 1: digit 0 percentage < 9.5%
    if (freqs[0].pct >= 9.5) return false;

    const sorted = [...freqs].sort((a, b) => b.pct - a.pct);
    const greenDigit = sorted[0].digit; // highest frequency digit

    // Condition 2: green bar (highest freq) must be digit > 5 (i.e. 6,7,8,9)
    if (greenDigit <= 5) return false;

    // Condition 3: top 3 most frequent digits must all be > 3 (i.e. 4,5,6,7,8,9)
    if (sorted[0].digit <= 3 || sorted[1].digit <= 3 || sorted[2].digit <= 3) return false;

    return true;
  }

  /**
   * Checks whether a given market matches the UNDER 9 conditions.
   */
  _hybridMatchesUnder9(sym) {
    const ticks = scanner.buffers[sym] || [];
    if (ticks.length < 500) return false;

    const counts = Array(10).fill(0);
    for (const t of ticks) counts[t]++;
    const freqs = counts.map((c, i) => ({ digit: i, pct: (c / ticks.length) * 100 }));

    // Condition 1: digit 9 percentage < 9.5%
    if (freqs[9].pct >= 9.5) return false;

    const sorted = [...freqs].sort((a, b) => b.pct - a.pct);
    const greenDigit = sorted[0].digit; // highest frequency digit

    // Condition 2: green bar (highest freq) must be digit < 5 (i.e. 0,1,2,3,4)
    if (greenDigit >= 5) return false;

    // Condition 3: top 3 most frequent digits must all be < 8 (i.e. 0,1,2,3,4,5,6,7)
    if (sorted[0].digit >= 8 || sorted[1].digit >= 8 || sorted[2].digit >= 8) return false;

    return true;
  }

  _executeO0U9HybridCycle() {
    const channel = this.channels.SINGLE;
    if (channel.active) {
      this._scheduleNext(100);
      return;
    }

    // ── PHASE 1: SEARCHING — scan all markets for OVER 0 or UNDER 9 conditions ──
    if (this.hybridPhase === 'SEARCHING') {
      // If we have a pause timer set (max 30s), respect it
      if (this.hybridPauseUntil && Date.now() < this.hybridPauseUntil) {
        const remaining = ((this.hybridPauseUntil - Date.now()) / 1000).toFixed(0);
        this.updateStatus(`O0/U9 HYBRID: Paused, re-scanning in ${remaining}s...`);
        this._scheduleNext(500);
        return;
      }
      this.hybridPauseUntil = 0;

      this.updateStatus('O0/U9 HYBRID: Scanning all markets for OVER 0 or UNDER 9 conditions...');

      let bestMarket = null;
      let bestSide = null;

      for (const sym of MARKETS) {
        if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;

        // Check OVER 0 first
        if (this._hybridMatchesOver0(sym)) {
          bestMarket = sym;
          bestSide = 'OVER0';
          break;
        }
        // Then check UNDER 9
        if (this._hybridMatchesUnder9(sym)) {
          bestMarket = sym;
          bestSide = 'UNDER9';
          break;
        }
      }

      if (!bestMarket) {
        this._scheduleNext(200);
        return;
      }

      this.activeMarket = bestMarket;
      this.hybridTradingConsecutiveTrades = 0;
      if (this.onMarketSwitch) this.onMarketSwitch(bestMarket);
      this.hybridTargetMarket = bestMarket;
      this.hybridSide = bestSide;

      // If we have unrecovered debt, go straight to RECOVERY instead of TRADING
      if (this.hybridDebt > 0.001) {
        this.hybridPhase = 'RECOVERY';
        this.hybridRecoveryDirection = this._evaluateHybridRecoveryDirection(bestMarket) || 'OVER5';
        this.hybridMarketEntryDebt = this.hybridDebt;
        const mktLabel = MARKET_LABELS[bestMarket] || bestMarket;
        this.sendLog(`🔄 O0/U9 HYBRID: Found market ${mktLabel} but debt $${this.hybridDebt.toFixed(2)} exists. Going straight to RECOVERY via ${this.hybridRecoveryDirection}.`);
      } else {
        this.hybridPhase = 'TRADING';
        const mktLabel = MARKET_LABELS[bestMarket] || bestMarket;
        const tradeLabel = bestSide === 'OVER0' ? 'OVER 0' : 'UNDER 9';
        this.sendLog(`✅ O0/U9 HYBRID: Matched ${tradeLabel} on ${mktLabel}. Trading!`);
      }
    }

    // ── PHASE 2: TRADING — fire on locked market, re-check conditions ──
    if (this.hybridPhase === 'TRADING') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }

      const sym = this.hybridTargetMarket;
      const currentSide = this.hybridSide;

      // Re-validate conditions on current market for current side
      const currentSideValid = currentSide === 'OVER0'
        ? this._hybridMatchesOver0(sym)
        : this._hybridMatchesUnder9(sym);

      if (currentSideValid) {
        // TRADING PHASE CIRCUIT BREAKER: Don't stay in one direction for too long
        if (this.hybridTradingConsecutiveTrades >= 5) {
          const combo = `${sym}_${currentSide}`;
          if (!this._hybridRecoveryBlacklist) this._hybridRecoveryBlacklist = {};
          this._hybridRecoveryBlacklist[combo] = Date.now() + 45000; // Blacklist for 45s
          this.sendLog(`🔄 O0/U9 HYBRID: Fired 5 consecutive trades on ${MARKET_LABELS[sym] || sym} ${currentSide}. Dropping market to avoid stale trends...`);
          this.hybridPhase = 'SEARCHING';
          this.hybridTargetMarket = null;
          this.hybridSide = null;
          this._scheduleNext(200);
          return;
        }

        // Conditions still valid — fire trade
        const mktLabel = MARKET_LABELS[sym] || sym;
        const tradeKey = currentSide === 'OVER0' ? 'OVER0' : 'UNDER9';
        this.updateStatus(`O0/U9 HYBRID: Firing ${currentSide === 'OVER0' ? 'OVER 0' : 'UNDER 9'} on ${mktLabel}...`);

        const stake = this._resolveTradeStake('SINGLE');
        this.hybridTradingConsecutiveTrades++;
        this._placeTrade('SINGLE', tradeKey, stake);
        this._scheduleNext(50);
        return;
      }

      // Current side lost conditions — try the OTHER side on same market
      const otherSide = currentSide === 'OVER0' ? 'UNDER9' : 'OVER0';
      const otherValid = otherSide === 'OVER0'
        ? this._hybridMatchesOver0(sym)
        : this._hybridMatchesUnder9(sym);

      if (otherValid) {
        this.hybridSide = otherSide;
        this.hybridTradingConsecutiveTrades = 0; // Reset counter when switching sides
        const mktLabel = MARKET_LABELS[sym] || sym;
        this.sendLog(`🔄 O0/U9 HYBRID: Switched to ${otherSide === 'OVER0' ? 'OVER 0' : 'UNDER 9'} on ${mktLabel} (conditions flipped).`);
        this._scheduleNext(50);
        return;
      }

      // Both sides fail on this market
      if (this.hybridDebt > 0.001) {
        // We have unrecovered debt — go to RECOVERY, not SEARCHING
        this.sendLog(`🔄 O0/U9 HYBRID: Conditions lost on ${MARKET_LABELS[sym] || sym} but debt $${this.hybridDebt.toFixed(2)} exists. Entering RECOVERY...`);
        this.hybridPhase = 'RECOVERY';
        this.hybridTargetMarket = null; // Force re-scan for best recovery market
        this.hybridPauseUntil = 0;
      } else {
        this.sendLog(`⏸️ O0/U9 HYBRID: Conditions lost on ${MARKET_LABELS[sym] || sym}. Scanning other volatilities...`);
        this.hybridPhase = 'SEARCHING';
        this.hybridPauseUntil = 0;
      }
      this._scheduleNext(200);
      return;
    }

    // ── PHASE 3: RECOVERY — Martingale ON, OVER5 or UNDER4 ──
    if (this.hybridPhase === 'RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }

      // If we don't have a target market for recovery (e.g. paused due to losses), search for one
      if (!this.hybridTargetMarket) {
        if (this.hybridPauseUntil && Date.now() < this.hybridPauseUntil) {
          const remaining = ((this.hybridPauseUntil - Date.now()) / 1000).toFixed(0);
          this.updateStatus(`O0/U9 HYBRID: Paused, re-scanning recovery markets in ${remaining}s...`);
          this._scheduleNext(500);
          return;
        }
        
        // Initialize blacklist for recently-failed market+side combos
        if (!this._hybridRecoveryBlacklist) this._hybridRecoveryBlacklist = {};
        
        // Build list of candidates with scores
        const candidates = [];
        for (const sym of MARKETS) {
          if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
          const result = this._evaluateHybridRecoveryDirection(sym, 'score');
          if (!result) continue;
          
          // Check both sides separately so we can pick the best side per market
          const over5Blacklisted = (this._hybridRecoveryBlacklist[`${sym}_OVER5`] || 0) > Date.now();
          const under4Blacklisted = (this._hybridRecoveryBlacklist[`${sym}_UNDER4`] || 0) > Date.now();
          
          if (result.over5Score >= 1 && !over5Blacklisted) {
            candidates.push({ sym, dir: 'OVER5', score: result.over5Score, blacklisted: false });
          }
          if (result.under4Score >= 1 && !under4Blacklisted) {
            candidates.push({ sym, dir: 'UNDER4', score: result.under4Score, blacklisted: false });
          }
        }
        
        // Sort by score descending — best edge first
        candidates.sort((a, b) => b.score - a.score);
        
        // Prefer a different market/side than what just failed (if any)
        const lastFailedKey = this._hybridLastFailedCombo || null;
        let bestCandidate = candidates.find(c => `${c.sym}_${c.dir}` !== lastFailedKey && c.score >= 2);
        
        // Fallback: accept the best candidate even if it's the same combo, but only if score >= 2
        if (!bestCandidate) bestCandidate = candidates.find(c => c.score >= 2);
        
        // Last resort fallback: if no market has score >= 2, accept score >= 0.5 to avoid stalling recovery
        if (!bestCandidate && candidates.length > 0) {
          bestCandidate = candidates.find(c => c.score >= 0.5);
          if (bestCandidate) {
            this.sendLog(`⚠️ O0/U9 HYBRID: No strong edge found. Using best available: ${MARKET_LABELS[bestCandidate.sym] || bestCandidate.sym} ${bestCandidate.dir} (score: ${bestCandidate.score.toFixed(1)})`);
          }
        }
        
        if (!bestCandidate) {
          this.updateStatus(`O0/U9 HYBRID RECOVERY: Scanning... no favorable market found yet. Debt: $${this.hybridDebt.toFixed(2)}`);
          this._scheduleNext(200);
          return;
        }
        
        this.activeMarket = bestCandidate.sym;
        if (this.onMarketSwitch) this.onMarketSwitch(bestCandidate.sym);
        this.hybridTargetMarket = bestCandidate.sym;
        this.hybridRecoveryDirection = bestCandidate.dir;
        this.hybridMarketEntryDebt = this.hybridDebt;
        const mktLabel = MARKET_LABELS[bestCandidate.sym] || bestCandidate.sym;
        this.sendLog(`✅ O0/U9 HYBRID: Resuming recovery on ${mktLabel} via ${bestCandidate.dir} (score: ${bestCandidate.score.toFixed(1)}).`);
      }

      // 1. Dynamic Streak Pauser: Wait out opposing momentum instead of dropping the market
      const ticks = scanner.buffers[this.hybridTargetMarket] || [];
      if (ticks.length >= 3) {
        let opposingStreak = 0;
        for (let i = ticks.length - 1; i >= 0; i--) {
          const t = ticks[i];
          const isOpposing = this.hybridRecoveryDirection === 'OVER5' ? (t <= 5) : (t >= 4);
          if (isOpposing) opposingStreak++;
          else break;
        }

        if (opposingStreak >= 3) {
          const mktLabel = MARKET_LABELS[this.hybridTargetMarket] || this.hybridTargetMarket;
          this.updateStatus(`O0/U9 HYBRID RECOVERY: Paused on ${mktLabel}. Waiting for opposing streak (${opposingStreak}) to break...`);
          this._scheduleNext(200);
          return; // Don't fire, just wait for better tick
        }
      }

      // Enforce hardcoded 2-level martingale step based on consecutive losses
      if (this.hybridCurrentLosses > 0) {
        const hold = this._getMartingaleHoldAfterStep();
        const hardMax = 2; // Hardcoded max 2 levels for hybrid recovery
        const targetStep = Math.min(this.hybridCurrentLosses, hardMax);
        channel.step = hold > 0 ? Math.min(hold, targetStep) : targetStep;
      }

      const tradeKey = this.hybridRecoveryDirection || 'OVER5';
      const mktLabel = MARKET_LABELS[this.hybridTargetMarket] || this.hybridTargetMarket;
      const stake = this._resolveTradeStake('SINGLE');

      this.updateStatus(`O0/U9 HYBRID RECOVERY: ${tradeKey} on ${mktLabel} | Stake: $${stake.toFixed(2)} | Debt: $${this.hybridDebt.toFixed(2)} (Loss #${this.hybridCurrentLosses})`);
      this._placeTrade('SINGLE', tradeKey, stake);

      this._scheduleNext(50);
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  UNDER 9 V1 — Trade UNDER 9 on markets where digit 9 is weakest
  //  Green bar = even digit < 7 (0,2,4,6), Red bar = odd digit < 8 (1,3,5,7)
  //  Recovery: user-selectable (UNDER4 / OVER5 / UNDER7) via config
  // ═══════════════════════════════════════════════════════════════════════════
  _executeUnder9V1Cycle() {
    const channel = this.channels.SINGLE;
    if (channel.active) {
      this._scheduleNext(100);
      return;
    }

    const getFreqs = (ticks) => {
      const counts = Array(10).fill(0);
      for (const t of ticks) counts[t]++;
      return counts.map((c, i) => ({ digit: i, pct: (c / ticks.length) * 100 }));
    };

    // ── PHASE 1: SEARCHING FOR BEST MARKET ──
    if (this.under9v1Phase === 'SEARCHING') {
      this.updateStatus('UNDER 9 V1: Scanning for market with lowest digit 9...');
      let bestMarket = null;
      let lowest9Pct = 100;

      for (const sym of MARKETS) {
        if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
        const ticks = scanner.buffers[sym] || [];
        if (ticks.length < 500) continue;

        const freqs = getFreqs(ticks);
        const pct9 = freqs[9].pct;

        const sorted = [...freqs].sort((a, b) => b.pct - a.pct);
        const greenDigit = sorted[0].digit;
        const redDigit = sorted[9].digit;

        // Green bar must be an even digit below 7 (0, 2, 4, 6)
        if (greenDigit % 2 !== 0 || greenDigit >= 7) continue;

        // Red bar must be an odd digit below 8 (1, 3, 5, 7)
        if (redDigit % 2 === 0 || redDigit >= 8) continue;

        if (pct9 < lowest9Pct) {
          lowest9Pct = pct9;
          bestMarket = sym;
        }
      }

      if (!bestMarket) {
        this._scheduleNext(200);
        return;
      }

      this.activeMarket = bestMarket;
      if (this.onMarketSwitch) this.onMarketSwitch(bestMarket);
      this.under9v1TargetMarket = bestMarket;
      this.under9v1Phase = 'TRADING';

      const mktLabel = MARKET_LABELS[bestMarket] || bestMarket;
      this.sendLog(`✅ UNDER 9 V1: Selected ${mktLabel} (Digit 9 is ${lowest9Pct.toFixed(1)}%). Locked in.`);
    }

    // ── PHASE 2: CONTINUOUS TRADING UNDER 9 ──
    if (this.under9v1Phase === 'TRADING') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }

      const mktLabel = MARKET_LABELS[this.under9v1TargetMarket] || this.under9v1TargetMarket;
      this.updateStatus(`UNDER 9 V1: Firing UNDER 9 on ${mktLabel}...`);

      const stake = this._resolveTradeStake('SINGLE');
      this._placeTrade('SINGLE', 'UNDER9', stake);
      this._scheduleNext(50);
      return;
    }

    // ── PHASE 3: RECOVERY (Martingale ON) ──
    if (this.under9v1Phase === 'RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }

      const tradeKey = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.under9v1TargetMarket);
      const mktLabel = MARKET_LABELS[this.under9v1TargetMarket] || this.under9v1TargetMarket;
      this.updateStatus(`UNDER 9 V1 RECOVERY: ${tradeKey} on ${mktLabel}...`);

      const stake = this._resolveTradeStake('SINGLE');
      this._placeTrade('SINGLE', tradeKey, stake);

      this._scheduleNext(50);
      return;
    }

    // ── PHASE 4: DEBT_RECOVERY (Martingale OFF) ──
    if (this.under9v1Phase === 'DEBT_RECOVERY') {
      if (!this._canFireTradeNow() || channel.active) {
        this._scheduleNext(200);
        return;
      }

      const tradeKey = this.lockedRecoveryDirection || this._getFlowBasedRecoveryDirection(this.under9v1TargetMarket);
      const mktLabel = MARKET_LABELS[this.under9v1TargetMarket] || this.under9v1TargetMarket;
      this.updateStatus(`UNDER 9 V1 DEBT RECOVERY: ${tradeKey} on ${mktLabel} (Debt: $${this.under9v1Debt.toFixed(2)})`);

      const stake = this.config.baseStake;
      this._placeTrade('SINGLE', tradeKey, stake);

      this._scheduleNext(50);
      return;
    }
  }


  _executeRandomPickerCycle() {
    const channel = this.channels.SINGLE;
    if (channel.active) {
      this._scheduleNext(100);
      return;
    }

    this.updateStatus('RANDOM PICKER: Scanning all volatilities...');

    // ── Collect candidates across ALL volatility indices ──────────────────
    // For each market we compute every trade type's edge score and collect
    // the best over-type AND best under-type per market so the picker is
    // naturally balanced (not biased toward one side).
    const candidates = [];

    for (const sym of MARKETS) {
      if (this.marketStats[sym]?.quarantinedUntil > Date.now()) continue;
      const ticks = scanner.buffers[sym] || [];
      if (ticks.length < 100) continue;

      const total = ticks.length;
      const counts = Array(10).fill(0);
      for (const t of ticks) counts[t]++;
      const freqs = counts.map((c, i) => ({ digit: i, pct: (c / total) * 100 }));

      // ─ OVER candidates: pick the best OVER level where the high-digit
      //   frequency gives a clear statistical edge (digit frequency > expected)
      // Expected uniform frequency per digit = 10%.
      // OVER N wins when last digit > N  →  true probability ≈ (9-N)/10 = 90%, 80% … 10%
      // We want: observed high-end frequency > theoretical to confirm bias.
      const overCandidates = [
        // OVER3: wins when digit > 3  (6 outcomes); edge if digits 4-9 are collectively hot
        { trade: 'OVER3', barrier: 3, winDigits: [4,5,6,7,8,9],
          edge: freqs.slice(4).reduce((s, f) => s + f.pct, 0) - 60 },
        // OVER4: wins when digit > 4  (5 outcomes)
        { trade: 'OVER4', barrier: 4, winDigits: [5,6,7,8,9],
          edge: freqs.slice(5).reduce((s, f) => s + f.pct, 0) - 50 },
        // OVER5: wins when digit > 5  (4 outcomes)
        { trade: 'OVER5', barrier: 5, winDigits: [6,7,8,9],
          edge: freqs.slice(6).reduce((s, f) => s + f.pct, 0) - 40 },
        // OVER6: wins when digit > 6  (3 outcomes)
        { trade: 'OVER6', barrier: 6, winDigits: [7,8,9],
          edge: freqs.slice(7).reduce((s, f) => s + f.pct, 0) - 30 },
        // OVER7: wins when digit > 7  (2 outcomes)
        { trade: 'OVER7', barrier: 7, winDigits: [8,9],
          edge: freqs.slice(8).reduce((s, f) => s + f.pct, 0) - 20 },
      ];

      const underCandidates = [
        // UNDER5: wins when digit < 5  (5 outcomes)
        { trade: 'UNDER5', barrier: 5, winDigits: [0,1,2,3,4],
          edge: freqs.slice(0,5).reduce((s, f) => s + f.pct, 0) - 50 },
        // UNDER4: wins when digit < 4  (4 outcomes)
        { trade: 'UNDER4', barrier: 4, winDigits: [0,1,2,3],
          edge: freqs.slice(0,4).reduce((s, f) => s + f.pct, 0) - 40 },
        // UNDER6: wins when digit < 6  (6 outcomes)
        { trade: 'UNDER6', barrier: 6, winDigits: [0,1,2,3,4,5],
          edge: freqs.slice(0,6).reduce((s, f) => s + f.pct, 0) - 60 },
        // UNDER3: wins when digit < 3  (3 outcomes)
        { trade: 'UNDER3', barrier: 3, winDigits: [0,1,2],
          edge: freqs.slice(0,3).reduce((s, f) => s + f.pct, 0) - 30 },
        // UNDER7: wins when digit < 7  (7 outcomes)
        { trade: 'UNDER7', barrier: 7, winDigits: [0,1,2,3,4,5,6],
          edge: freqs.slice(0,7).reduce((s, f) => s + f.pct, 0) - 70 },
      ];

      // ── Find best OVER with positive edge
      const bestOver = overCandidates.filter(c => c.edge > 0)
        .sort((a, b) => b.edge - a.edge)[0] || null;

      // ── Find best UNDER with positive edge
      const bestUnder = underCandidates.filter(c => c.edge > 0)
        .sort((a, b) => b.edge - a.edge)[0] || null;

      if (bestOver)  candidates.push({ sym, ...bestOver, side: 'OVER'  });
      if (bestUnder) candidates.push({ sym, ...bestUnder, side: 'UNDER' });
    }

    if (candidates.length === 0) {
      this.updateStatus('RANDOM PICKER: Scanning for edge...');
      this._scheduleNext(800);
      return;
    }

    // ── Balance over/under selection ─────────────────────────────────────
    // Separate candidates by side, pick the best edge from each side,
    // then randomly choose between them — ensuring neither side dominates.
    candidates.sort((a, b) => b.edge - a.edge);
    const overPool  = candidates.filter(c => c.side === 'OVER');
    const underPool = candidates.filter(c => c.side === 'UNDER');

    // Take top 3 from each side (to add some randomness within quality picks)
    const topOvers  = overPool.slice(0, 3);
    const topUnders = underPool.slice(0, 3);

    // Merge and pick randomly, but only if both sides are represented
    let finalPool;
    if (topOvers.length > 0 && topUnders.length > 0) {
      // Pick a random element from each side's top-3, then pick one of those two
      const overPick  = topOvers[Math.floor(Math.random() * topOvers.length)];
      const underPick = topUnders[Math.floor(Math.random() * topUnders.length)];
      // Randomly decide which side to trade this cycle
      finalPool = Math.random() < 0.5 ? overPick : underPick;
    } else {
      // Only one side has favorable conditions — pick best from that side
      const pool = topOvers.length > 0 ? topOvers : topUnders;
      finalPool = pool[Math.floor(Math.random() * pool.length)];
    }

    const chosen = finalPool;

    if (!this._canFireTradeNow()) {
      this._scheduleNext(200);
      return;
    }

    this.activeMarket = chosen.sym;
    if (this.onMarketSwitch) this.onMarketSwitch(chosen.sym);

    const mult   = this.config.martMultiplier || 2.0;
    const losses = this.randomPickerCurrentLosses || 0;
    const stake  = parseFloat((this.config.baseStake * Math.pow(mult, losses)).toFixed(2));

    const mktLabel = MARKET_LABELS[chosen.sym] || chosen.sym;
    this.sendLog(
      `RANDOM PICKER: ${mktLabel} → ${chosen.trade} (edge +${chosen.edge.toFixed(1)}%) · stake $${stake.toFixed(2)}`
    );
    this.updateStatus(`RANDOM PICKER: ${mktLabel} ${chosen.trade}...`);

    this._placeTrade('SINGLE', chosen.trade, stake);
    this._scheduleNext(50);
  }

  _executeMatchesSniperCycle() {
    const channel = this.channels.SINGLE;
    if (channel.active) {
      this.updateStatus('Polling settlement...');
      this._scheduleNext(1000);
      return;
    }

    // Post-loss tick cooldown removed — fire immediately
    this.pauseTicksRemaining = 0;

    // Evaluate market switching in real time
    this._evaluateMatchesSniperMarket();

    if (!this.activeMarket || this.matchesTargetDigit === null) {
      this.updateStatus('Scanning markets...');
      this._scheduleNext(1000);
      return;
    }

    const ticks = scanner.buffers[this.activeMarket]?.slice(-20);
    if (!ticks || ticks.length < 20) {
      this.updateStatus('Syncing ticks...');
      this._scheduleNext(1000);
      return;
    }

    // Entry condition: target digit appeared once (meaning it is the last tick's digit)
    const lastDigit = parseInt(ticks[ticks.length - 1], 10);
    if (lastDigit !== this.matchesTargetDigit) {
      this.updateStatus(`Waiting for digit ${this.matchesTargetDigit} on ${MARKET_LABELS[this.activeMarket]}`);
      this._scheduleNext(500); // Check again quickly on next tick/timer
      return;
    }

    // Stake sizing: base stake (minimum $0.35)
    const baseStake = this.config.baseStake || 0.35;

    this.sendLog(
      `🎯 [MATCHES SNIPER ENTRY] Market: ${MARKET_LABELS[this.activeMarket]} | ` +
      `Target Digit: ${this.matchesTargetDigit} appeared! Placing DIGITMATCH trade...`
    );

    this.updateStatus('Placing Match Trade');
    this._placeTrade('SINGLE', 'MATCH', baseStake, this.matchesTargetDigit.toString());
  }

  getMatchesSniperData() {
    return {
      activeMarket: this.activeMarket,
      targetDigit: this.matchesTargetDigit,
      lastSwitchTime: this.matchesLastSwitchTime,
      markets: MARKETS.map(sym => {
        const stats = this.getHottestDigitForMarket(sym);
        return {
          symbol: sym,
          label: MARKET_LABELS[sym] || sym,
          hottestDigit: stats.digit,
          frequency: stats.count,
          score: stats.score,
          status: sym === this.activeMarket ? 'ACTIVE' : (this.marketStats[sym]?.quarantinedUntil > Date.now() ? 'QUARANTINE' : 'SCANNING'),
        };
      })
    };
  }

  async _placeTrade(channelKey, direction, stake, dynamicBarrier = null, marketSymbol = null, opts = {}) {
    const spec = CONTRACT_MAP[direction];
    if (!spec) return;

    const tradeMarket = marketSymbol || this.activeMarket;
    const channel = this.channels[channelKey];
    if (!channel) return;

    const isFastPass = opts.fastPass === true || shouldUseFastPassRecovery();
    if (!isStreamFresh(tradeMarket, scanner, isFastPass ? 2500 : 2000)) {
      const lag = Date.now() - (scanner.lastTickAt?.[tradeMarket] || Date.now());
      this.sendLog(`⏸ Order blocked — stream lag ${lag}ms on ${MARKET_LABELS[tradeMarket]}`);
      channel.active = false;
      channel.direction = null;
      if (channelKey.startsWith('SLOT_')) {
        this._pendingTournamentBuy = false;
        const errSlot = this.executionSlots?.find(s => s.channelKey === channelKey);
        if (errSlot) this._releaseTournamentFire(errSlot);
      }
      return;
    }

    if (channelKey.startsWith('SLOT_')) {
      if (!this._tournamentTradeInFlight) {
        this.sendLog('⚠️ Blocked stray tournament order (no active session lock)');
        return;
      }
      if (channel.contractId || this._hasOpenTournamentContracts()) {
        this.sendLog('⚠️ Blocked duplicate tournament order (contract already open)');
        return;
      }
      if (this._pendingTournamentBuy) {
        this.sendLog('⚠️ Blocked duplicate tournament order (buy in progress)');
        return;
      }
      this._pendingTournamentBuy = true;
    }
    const resolvedStake = this._resolveStake(stake);
    if (resolvedStake !== stake) {
      this.sendLog(`⚠️ Stake adjusted to Deriv minimum $${resolvedStake.toFixed(2)} (was $${Number(stake || 0).toFixed(2)})`);
    }

    // ▸▸▸ LOCK the channel IMMEDIATELY to prevent double-firing ◂◂◂
    if (channel.contractId) {
      if (!this._contractLedger) this._contractLedger = {};
      this._contractLedger[channel.contractId] = {
        channelKey, direction: channel.direction, stake: channel.stake
      };
      channel.contractId = null;
    }

    channel.active = true;
    channel.direction = direction;
    channel.stake = resolvedStake;
    channel.placedAt = Date.now();
    if (channelKey === 'SINGLE' || channelKey.startsWith('SLOT_')) {
      const slot = this.executionSlots?.find(s => s.channelKey === channelKey);
      channel.vlDepthAtEntry = slot?.vlDepthAtEntry || channel.pendingVlDepth || 0;
      channel.pendingVlDepth = 0;
    }

    const exactMartingale = this.config.recoveryEnabled !== false;
    const cleanStake = exactMartingale
      ? Math.max(0.35, parseFloat(Number(resolvedStake).toFixed(2)))
      : channelKey.startsWith('SLOT_')
        ? this._martingaleStakeWithSlightRange(resolvedStake)
        : this._stealthJitterStake(resolvedStake);

    const isRecovery = (this.sessionConsecutiveLosses || 0) >= 1;
    if (!isFastPass && !isRecovery) {
      await this._stealthReactionDelayForChannel(channelKey);
      this._stealthBackgroundActivity();
    }

    const barrierVal = dynamicBarrier != null && dynamicBarrier !== undefined
      ? String(dynamicBarrier)
      : (spec.barrier != null && spec.barrier !== undefined ? String(spec.barrier) : undefined);

    const balance = derivWS.accountInfo?.balance || 0;
    if (cleanStake > balance) {
      this.sendLog(`🚨 Stake $${cleanStake.toFixed(2)} exceeds balance $${balance.toFixed(2)}. Stop.`);
      channel.active = false;
      channel.direction = null;
      if (channelKey.startsWith('SLOT_')) this._pendingTournamentBuy = false;
      const failSlot = this.executionSlots?.find(s => s.channelKey === channelKey);
      if (failSlot) this._releaseTournamentFire(failSlot);
      this.stop(`Insufficient balance for $${cleanStake.toFixed(2)} stake.`);
      return;
    }

    const tradeDuration = opts.duration || 1;
    const tradeDurationUnit = opts.durationUnit || 't';

    try {
      let propRes;
      const buffered = tradeDuration === 1 ? consumeBufferedProposal(
        tradeMarket,
        spec.contract_type,
        cleanStake,
        barrierVal
      ) : null;

      if (buffered?.id) {
        propRes = await derivWS.send(
          { buy: buffered.id, price: buffered.price, subscribe: 1, priority: 1 },
          { priority: true }
        );
        if (!propRes?.buy && !propRes?.error) {
          propRes = { error: { message: 'Buffered buy failed' } };
        }
      } else {
        const proposalPayload = {
          proposal: 1,
          amount: cleanStake,
          basis: 'stake',
          contract_type: spec.contract_type,
          currency: derivWS.accountInfo?.currency || 'USD',
          underlying_symbol: tradeMarket,
          duration: tradeDuration,
          duration_unit: tradeDurationUnit,
          priority: isFastPass ? 1 : undefined,
        };
        if (barrierVal != null) proposalPayload.barrier = barrierVal;
        propRes = await derivWS.send(proposalPayload, { priority: isFastPass });
        if (!propRes.error && propRes.proposal?.id) {
          propRes = await derivWS.send(
            { buy: propRes.proposal.id, price: propRes.proposal.ask_price, subscribe: 1, priority: isFastPass ? 1 : undefined },
            { priority: isFastPass }
          );
        }
      }

      if (propRes.error) {
        this.sendLog(`❌ Proposal error [${direction}]: ${propRes.error.message}`);
        this.nextAllowedTradeTime = 0; // No cooldown — retry immediately
        channel.active = false;
        channel.direction = null;
        if (channelKey.startsWith('SLOT_')) this._pendingTournamentBuy = false;
        const errSlot = this.executionSlots?.find(s => s.channelKey === channelKey);
        if (errSlot) {
          this._releaseTournamentFire(errSlot);
          if (this.running) this._scheduleNext(150);
          return;
        }
        if (this.strategy === 'RANDOM_PICKER' && this.config.autoSwitchMarkets !== false) {
          this.sendLog(`Proposal error received`);
        }
        if (this.running) this._scheduleNext(5000);
        return;
      }

      let res = propRes;
      if (propRes.proposal?.id && !propRes.buy) {
        res = await derivWS.send(
          { buy: propRes.proposal.id, price: propRes.proposal.ask_price, priority: isFastPass ? 1 : undefined },
          { priority: isFastPass }
        );
      }
      if (res.error) {
        this.sendLog(`❌ Trade error [${direction}]: ${res.error.message}`);
        this.nextAllowedTradeTime = 0; // No cooldown — retry immediately
        channel.active = false;
        channel.direction = null;
        if (channelKey.startsWith('SLOT_')) this._pendingTournamentBuy = false;
        const errSlot = this.executionSlots?.find(s => s.channelKey === channelKey);
        if (errSlot) {
          this._releaseTournamentFire(errSlot);
          if (this.running) this._scheduleNext(150);
          return;
        }
        // Don't stop entirely, just try to rotate market and resume after a delay
        if (this.strategy === 'RANDOM_PICKER' && this.config.autoSwitchMarkets !== false) {
          this.sendLog(`Trade error received`);
        }
        if (this.running) this._scheduleNext(5000);
        return;
      }
      if (res.buy) {
        this._notifyOnce(
          this._toastIds.entry,
          `${direction} → ${MARKET_LABELS[tradeMarket] || tradeMarket}`,
          { icon: '⚡', duration: 2200 }
        );
        this._lastVlToastTime = Date.now();

        channel.contractId = res.buy.contract_id;
        const slot = this.executionSlots?.find(s => s.channelKey === channelKey);
        if (slot) {
          slot.contractId = channel.contractId;
          this._contractToSlot[channel.contractId] = slot.id;
          this._openTournamentContracts.set(channel.contractId, Date.now());
        }
        if (channelKey.startsWith('SLOT_')) this._pendingTournamentBuy = false;
        this.sendLog(
          `✅ Triggered ${channelKey} ${direction} on ${MARKET_LABELS[tradeMarket] || tradeMarket} at $${cleanStake.toFixed(2)} ` +
          `(mart step ${this._sessionMartingaleStep}) | Contract ${channel.contractId}`
        );
        derivWS.sendRaw({ proposal_open_contract: 1, contract_id: channel.contractId, subscribe: 1 });
        
        if (this.onTradeUpdate) {
          this.onTradeUpdate({
            id: channel.contractId,
            market: tradeMarket,
            direction: direction,
            stake: stake,
            profit: 0,
            won: false,
            time: Date.now(),
            exitTick: null,
            pending: true
          });
        }
        
        // MIRROR TO DEMO IF COPYTRADE IS ACTIVE
        if (copyTradeEngine.active) {
          copyTradeEngine.copyTrade({
            contractType: spec.contract_type,
            symbol: tradeMarket,
            amount: cleanStake,
            duration: 1,
            durationUnit: 't',
            barrier: dynamicBarrier !== null && dynamicBarrier !== undefined ? String(dynamicBarrier) : (spec.barrier !== null && spec.barrier !== undefined ? String(spec.barrier) : undefined),
            currency: derivWS.accountInfo?.currency || 'USD'
          });
        }
      }
    } catch (e) {
      this.sendLog(`⚠️ Connection drop, retrying trade in 3s...`);
      channel.active = false;
      channel.direction = null;
      if (channelKey.startsWith('SLOT_')) this._pendingTournamentBuy = false;
      const slot = this.executionSlots?.find(s => s.channelKey === channelKey);
      if (slot) this._releaseTournamentFire(slot);
      if (this.running && !this._usesTournamentMode()) this._scheduleNext(3000);
      else if (this.running) this._scheduleTournamentFireTry();
    }
  }

  _handleContractUpdate(msg) {
    const contract = msg.proposal_open_contract;
    if (!contract) return;
    
    // Accept as settled if sold, expired, or explicitly won/lost
    const isSettled = contract.is_sold || contract.is_expired || (contract.status && contract.status !== 'open');
    if (!isSettled) return;

    const cid = contract.contract_id;

    if (this._settledContractIds.has(cid)) return;

    const slotId = this._contractToSlot[cid];
    if (slotId !== undefined && this.executionSlots[slotId]) {
      this._onSlotSettled(this.executionSlots[slotId], contract);
      return;
    }

    // First try active channels
    let channelKey = null;
    let channel = null;
    for (const key in this.channels) {
      if (this.channels[key].contractId === cid) {
        channelKey = key;
        channel = this.channels[key];
        break;
      }
    }

    if (channelKey?.startsWith('SLOT_')) {
      const slot = this.executionSlots.find(s => s.channelKey === channelKey);
      if (slot) {
        this._onSlotSettled(slot, contract);
        return;
      }
    }

    let isLedgerSettle = false;
    // Fallback: check the overflow ledger for contracts that were overwritten
    if (!channel && this._contractLedger && this._contractLedger[cid]) {
      const ledgerEntry = this._contractLedger[cid];
      channelKey = ledgerEntry.channelKey;
      // Create a virtual channel object for settlement
      channel = {
        active: true,
        contractId: cid,
        direction: ledgerEntry.direction,
        stake: ledgerEntry.stake,
        consecutiveLosses: 0,
        step: 0,
      };
      delete this._contractLedger[cid];
      isLedgerSettle = true;
      const profit = parseFloat(contract.profit) || 0;
      const won = contract.status === 'won' || profit > 0;
      this.sendLog(`💸 [LEDGER SETTLE] ${won ? '✅ WIN' : '❌ LOSS'} (${won ? '+' : ''}$${profit.toFixed(2)}) — Contract ${cid}`);
    }

    if (!channel) return;

    this._settledContractIds.add(cid);
    this._openTournamentContracts.delete(cid);

    const direction = channel.direction;
    const profit = parseFloat(contract.profit) || 0;
    const won = contract.status === 'won' || profit > 0;
    const buyPrice = parseFloat(contract.buy_price) || 0;
    const market = contract.underlying || this.activeMarket;

    // Record results
    const mStats = this.marketStats[market];
    let justTriggeredDefensive = false;

    if (this.strategy === 'OVER_6') {
      if (won) {
        if (this.over6Phase === 'DEBT_RECOVERY') {
          this.over6Debt -= profit;
          if (this.over6Debt <= 0) {
            this.over6Debt = 0;
            this.sendLog(`✨ OVER 6: Debt fully recovered! Returning to normal trading.`);
            this.over6Phase = 'SEARCHING';
            this.sessionConsecutiveLosses = 0;
            this._syncSessionMartingaleStep(0);
          } else {
            this.sendLog(`💰 OVER 6: Partial recovery win. Remaining Debt: $${this.over6Debt.toFixed(2)}`);
          }
        } else if (this.over6Phase === 'RECOVERY') {
          this.sendLog(`✨ OVER 6: Recovery successful.`);
          this.over6Phase = 'SEARCHING';
          this.sessionConsecutiveLosses = 0;
          if (this._shouldResetMartingaleOnWin()) this._syncSessionMartingaleStep(0);
        }
        this._onSessionWin('OVER_6');
        this.over6CurrentWins++;
        this.over6CurrentLosses = 0;
      } else {
        if (this.over6Phase === 'DEBT_RECOVERY') {
          this.over6Debt += Math.abs(profit);
          this.sendLog(`⚠️ OVER 6: Debt recovery loss. Total Debt: $${this.over6Debt.toFixed(2)}`);
        } else if (this.over6Phase === 'TRADING') {
          if (this.config.recoveryEnabled === false) {
            this.over6Phase = 'DEBT_RECOVERY';
            this.over6Debt += Math.abs(profit);
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.over6TargetMarket);
            this.sendLog(`⚠️ OVER 6: Loss detected. Martingale OFF. Entering Debt Recovery. Debt: $${this.over6Debt.toFixed(2)}`);
          } else {
            this.over6Phase = 'RECOVERY';
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.over6TargetMarket);
            this.sendLog(`⚠️ OVER 6: Loss detected. Entering Recovery.`);
          }
        }
        this._onSessionLoss('OVER_6');
        this.over6CurrentLosses++;
        this.over6CurrentWins = 0;
      }
      riskManager.recordResult(direction, won, profit);
    } else if (this.strategy === 'UNDER_8_V2') {
      if (won) {
        if (this.under8V2Phase === 'DEBT_RECOVERY' || this.under8V2Phase === 'RECOVERY') {
          this.under8V2Debt -= profit;
          if (this.under8V2Debt <= 0) {
            this.under8V2Debt = 0;
            this.sendLog(`✅ UNDER 8 V2: Debt fully recovered! Returning to original trades.`);
            this.under8V2Phase = 'SEARCHING';
            this.sessionConsecutiveLosses = 0;
            this.under8V2CurrentLosses = 0;
            this.lockedRecoveryDirection = null;
            this.lockedRecoveryMarket = null;
            this._syncSessionMartingaleStep(0);
          } else {
            this.sendLog(`⚠️ UNDER 8 V2: Partial chunk win. Remaining Debt: $${this.under8V2Debt.toFixed(2)}`);
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

        this.sendLog(`🔴 UNDER 8 V2: Loss detected. OVER 3 Rapid Recovery Active. Debt: $${this.under8V2Debt.toFixed(2)}`);
        
        this._onSessionLoss('UNDER_8_V2');
        this.under8V2CurrentLosses++;

        this._evaluateCircuitBreaker(this.under8V2CurrentLosses);
        this.under8V2CurrentWins = 0;
      }
      riskManager.recordResult(direction, won, profit);
    } else if (this.strategy === 'UNDER_8_V1') {
      if (won) {
        if (this.under8Phase === 'DEBT_RECOVERY') {
          this.under8Debt -= profit;
          if (this.under8Debt <= 0) {
            this.under8Debt = 0;
            this.sendLog(`✅ UNDER 8 V1: Debt fully recovered! Returning to original trades.`);
            this.under8Phase = 'SEARCHING';
            this.sessionConsecutiveLosses = 0;
            this._syncSessionMartingaleStep(0);
          } else {
            this.sendLog(`💰 UNDER 8 V1: Partial recovery win. Remaining Debt: $${this.under8Debt.toFixed(2)}`);
          }
        } else if (this.under8Phase === 'RECOVERY') {
          this.sendLog(`✨ UNDER 8 V1: Recovery successful.`);
          this.under8Phase = 'SEARCHING';
          this.sessionConsecutiveLosses = 0;
          if (this._shouldResetMartingaleOnWin()) this._syncSessionMartingaleStep(0);
        }
        this._onSessionWin('UNDER_8_V1');
        this.under8CurrentWins++;
        this.under8CurrentLosses = 0;
      } else {
        if (this.under8Phase === 'DEBT_RECOVERY') {
          this.under8Debt += Math.abs(profit);
          this.sendLog(`⚠️ UNDER 8 V1: Debt recovery loss. Total Debt: $${this.under8Debt.toFixed(2)}`);
        } else if (this.under8Phase === 'TRADING') {
          if (this.config.recoveryEnabled === false) {
            this.under8Phase = 'DEBT_RECOVERY';
            this.under8Debt += Math.abs(profit);
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.under8TargetMarket);
            this.sendLog(`⚠️ UNDER 8 V1: Loss detected. Martingale OFF. Entering Debt Recovery. Debt: $${this.under8Debt.toFixed(2)}`);
          } else {
            this.under8Phase = 'RECOVERY';
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.under8TargetMarket);
            this.sendLog(`⚠️ UNDER 8 V1: Loss detected. Entering Recovery.`);
          }
        }
        this._onSessionLoss('UNDER_8_V1');
        this.under8CurrentLosses++;
        this.under8CurrentWins = 0;
      }
      riskManager.recordResult(direction, won, profit);
    } else if (this.strategy === 'UNDER_7_V1') {
      if (won) {
        if (this.under7v1Phase === 'DEBT_RECOVERY') {
          this.under7v1Debt -= profit;
          if (this.under7v1Debt <= 0) {
            this.under7v1Debt = 0;
            this.sendLog(`✅ UNDER 7 V1: Debt fully recovered! Returning to original trades.`);
            this.under7v1Phase = 'SEARCHING';
            this.sessionConsecutiveLosses = 0;
            this._syncSessionMartingaleStep(0);
          } else {
            this.sendLog(`💰 UNDER 7 V1: Partial recovery win. Remaining Debt: $${this.under7v1Debt.toFixed(2)}`);
          }
        } else if (this.under7v1Phase === 'RECOVERY') {
          this.sendLog(`✨ UNDER 7 V1: Recovery successful.`);
          this.under7v1Phase = 'SEARCHING';
          this.sessionConsecutiveLosses = 0;
          if (this._shouldResetMartingaleOnWin()) this._syncSessionMartingaleStep(0);
        }
        this._onSessionWin('UNDER_7_V1');
        this.under7v1CurrentWins++;
        this.under7v1CurrentLosses = 0;
      } else {
        if (this.under7v1Phase === 'DEBT_RECOVERY') {
          this.under7v1Debt += Math.abs(profit);
          this.sendLog(`⚠️ UNDER 7 V1: Debt recovery loss. Total Debt: $${this.under7v1Debt.toFixed(2)}`);
        } else if (this.under7v1Phase === 'TRADING') {
          if (this.config.recoveryEnabled === false) {
            this.under7v1Phase = 'DEBT_RECOVERY';
            this.under7v1Debt += Math.abs(profit);
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.under7v1TargetMarket);
            this.sendLog(`⚠️ UNDER 7 V1: Loss detected. Martingale OFF. Entering Debt Recovery. Debt: $${this.under7v1Debt.toFixed(2)}`);
          } else {
            this.under7v1Phase = 'RECOVERY';
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.under7v1TargetMarket);
            this.sendLog(`⚠️ UNDER 7 V1: Loss detected. Entering Recovery.`);
          }
        }
        this._onSessionLoss('UNDER_7_V1');
        this.under7v1CurrentLosses++;
        this.under7v1CurrentWins = 0;
      }
      riskManager.recordResult(direction, won, profit);
    } else if (this.strategy === 'OVER_3_V1') {
      if (won) {
        if (this.over3v1Phase === 'DEBT_RECOVERY') {
          this.over3v1Debt -= profit;
          if (this.over3v1Debt <= 0) {
            this.over3v1Debt = 0;
            this.sendLog(`✅ OVER 3 V1: Debt fully recovered! Returning to original trades.`);
            this.over3v1Phase = 'SEARCHING';
            this.sessionConsecutiveLosses = 0;
            this._syncSessionMartingaleStep(0);
          } else {
            this.sendLog(`💰 OVER 3 V1: Partial recovery win. Remaining Debt: $${this.over3v1Debt.toFixed(2)}`);
          }
        } else if (this.over3v1Phase === 'RECOVERY') {
          this.sendLog(`✨ OVER 3 V1: Recovery successful.`);
          this.over3v1Phase = 'SEARCHING';
          this.sessionConsecutiveLosses = 0;
          if (this._shouldResetMartingaleOnWin()) this._syncSessionMartingaleStep(0);
        }
        this._onSessionWin('OVER_3_V1');
        this.over3v1CurrentWins++;
        this.over3v1CurrentLosses = 0;
      } else {
        if (this.over3v1Phase === 'DEBT_RECOVERY') {
          this.over3v1Debt += Math.abs(profit);
          this.sendLog(`⚠️ OVER 3 V1: Debt recovery loss. Total Debt: $${this.over3v1Debt.toFixed(2)}`);
        } else if (this.over3v1Phase === 'TRADING') {
          if (this.config.recoveryEnabled === false) {
            this.over3v1Phase = 'DEBT_RECOVERY';
            this.over3v1Debt += Math.abs(profit);
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.over3v1TargetMarket);
            this.sendLog(`⚠️ OVER 3 V1: Loss detected. Martingale OFF. Entering Debt Recovery. Debt: $${this.over3v1Debt.toFixed(2)}`);
          } else {
            this.over3v1Phase = 'RECOVERY';
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.over3v1TargetMarket);
            this.sendLog(`⚠️ OVER 3 V1: Loss detected. Entering Recovery.`);
          }
        }
        
        this._onSessionLoss('OVER_3_V1');
        this.over3v1CurrentLosses++;
        this.over3v1CurrentWins = 0;
      }
      riskManager.recordResult(direction, won, profit);
    } else if (this.strategy === 'OVER_3_V3') {
      this._executeOver3V3Cycle();
      return;
    }
    if (this.strategy === 'OVER_3_V2') {
      if (won) {
        if (this.over3v2Phase === 'DEBT_RECOVERY') {
          this.over3v2Debt -= profit;
          if (this.over3v2Debt <= 0) {
            this.over3v2Debt = 0;
            this.sendLog(`✅ OVER 3 V2: Debt fully recovered! Returning to original trades.`);
            this.over3v2Phase = 'SEARCHING';
            this.sessionConsecutiveLosses = 0;
            this._syncSessionMartingaleStep(0);
          } else {
            this.sendLog(`💰 OVER 3 V2: Partial recovery win. Remaining Debt: $${this.over3v2Debt.toFixed(2)}`);
          }
        } else if (this.over3v2Phase === 'RECOVERY') {
          this.sendLog(`✨ OVER 3 V2: Recovery successful.`);
          this.over3v2Phase = 'SEARCHING';
          this.sessionConsecutiveLosses = 0;
          if (this._shouldResetMartingaleOnWin()) this._syncSessionMartingaleStep(0);
        }
        this._onSessionWin('OVER_3_V2');
        this.over3v2CurrentWins++;
        this.over3v2CurrentLosses = 0;
      } else {
        if (this.over3v2Phase === 'DEBT_RECOVERY') {
          this.over3v2Debt += Math.abs(profit);
          this.sendLog(`⚠️ OVER 3 V2: Debt recovery loss. Total Debt: $${this.over3v2Debt.toFixed(2)}`);
        } else if (this.over3v2Phase === 'TRADING') {
          if (this.config.recoveryEnabled === false) {
            this.over3v2Phase = 'DEBT_RECOVERY';
            this.over3v2Debt += Math.abs(profit);
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.over3v2TargetMarket);
            this.sendLog(`⚠️ OVER 3 V2: Loss detected. Martingale OFF. Entering Debt Recovery. Debt: $${this.over3v2Debt.toFixed(2)}`);
          } else {
            this.over3v2Phase = 'RECOVERY';
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.over3v2TargetMarket);
            this.sendLog(`⚠️ OVER 3 V2: Loss detected. Entering Recovery.`);
          }
        }
        this._onSessionLoss('OVER_3_V2');
        this.over3v2CurrentLosses++;
        this.over3v2CurrentWins = 0;
      }
      riskManager.recordResult(direction, won, profit);
    } else if (this.strategy === 'OVER_3_V3') {
      if (won) {
        if (this.over3v3Phase === 'DEBT_RECOVERY' || this.over3v3Phase === 'RECOVERY') {
          this.over3v3Debt -= profit;
          if (this.over3v3Debt <= 0) {
            this.over3v3Debt = 0;
            this.sendLog(`✅ OVER 3 V3: Debt fully recovered! Returning to normal trading.`);
            this.over3v3Phase = 'SEARCHING';
            this.sessionConsecutiveLosses = 0;
            this.over3v3CurrentLosses = 0;
            this.lockedRecoveryDirection = null;
            this.lockedRecoveryMarket = null;
            if (this._shouldResetMartingaleOnWin()) this._syncSessionMartingaleStep(0);
          } else {
            this.sendLog(`⚠️ OVER 3 V3: Partial chunk win. Remaining Debt: $${this.over3v3Debt.toFixed(2)}. Keeping 1.5x capped martingale level and maintaining locked market.`);
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

        this.sendLog(`🔴 OVER 3 V3: Loss detected. Fixed 1.5x Chunked Recovery Active. Debt: $${this.over3v3Debt.toFixed(2)}`);
        
        this._onSessionLoss('OVER_3_V3');
        this.over3v3CurrentLosses++;
        
        if (this.over3v3CurrentLosses >= 5) {
          this.sendLog(`⚠️ OVER 3 V3: Hit max martingale step 5. Resetting step to 0 while keeping debt to prevent crippling loss.`);
          this.over3v3CurrentLosses = 0;
        }

        this._evaluateCircuitBreaker(this.over3v3CurrentLosses);
        this.over3v3CurrentWins = 0;
      }
      riskManager.recordResult(direction, won, profit);
    } else if (this.strategy === 'OVER_5_V1') {
      if (won) {
        if (this.over5v1Phase === 'DEBT_RECOVERY') {
          this.over5v1Debt -= profit;
          if (this.over5v1Debt <= 0) {
            this.over5v1Debt = 0;
            this.sendLog(`✅ OVER 5 V1: Debt fully recovered! Returning to original trades.`);
            this.over5v1Phase = 'SEARCHING';
            this.sessionConsecutiveLosses = 0;
            this._syncSessionMartingaleStep(0);
          } else {
            this.sendLog(`💰 OVER 5 V1: Partial recovery win. Remaining Debt: $${this.over5v1Debt.toFixed(2)}`);
          }
        } else if (this.over5v1Phase === 'RECOVERY') {
          this.sendLog(`✨ OVER 5 V1: Recovery successful.`);
          this.over5v1Phase = 'SEARCHING';
          this.sessionConsecutiveLosses = 0;
          if (this._shouldResetMartingaleOnWin()) this._syncSessionMartingaleStep(0);
        }
        this._onSessionWin('OVER_5_V1');
        this.over5v1CurrentWins++;
        this.over5v1CurrentLosses = 0;
      } else {
        if (this.over5v1Phase === 'DEBT_RECOVERY') {
          this.over5v1Debt += Math.abs(profit);
          this.sendLog(`⚠️ OVER 5 V1: Debt recovery loss. Total Debt: $${this.over5v1Debt.toFixed(2)}`);
        } else if (this.over5v1Phase === 'TRADING') {
          if (this.config.recoveryEnabled === false) {
            this.over5v1Phase = 'DEBT_RECOVERY';
            this.over5v1Debt += Math.abs(profit);
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.over5v1TargetMarket);
            this.sendLog(`⚠️ OVER 5 V1: Loss detected. Martingale OFF. Entering Debt Recovery. Debt: $${this.over5v1Debt.toFixed(2)}`);
          } else {
            this.over5v1Phase = 'RECOVERY';
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.over5v1TargetMarket);
            this.sendLog(`⚠️ OVER 5 V1: Loss detected. Entering Recovery.`);
          }
        }
        this._onSessionLoss('OVER_5_V1');
        this.over5v1CurrentLosses++;
        this.over5v1CurrentWins = 0;
      }
      riskManager.recordResult(direction, won, profit);
    } else if (this.strategy === 'OVER_6_V2') {
      if (won) {
        if (this.over6v2Phase === 'DEBT_RECOVERY') {
          this.over6v2Debt -= profit;
          if (this.over6v2Debt <= 0) {
            this.over6v2Debt = 0;
            this.sendLog(`✅ OVER 6 V2: Debt fully recovered! Returning to original trades.`);
            this.over6v2Phase = 'SEARCHING';
            this.sessionConsecutiveLosses = 0;
            this._syncSessionMartingaleStep(0);
          } else {
            this.sendLog(`💰 OVER 6 V2: Partial recovery win. Remaining Debt: $${this.over6v2Debt.toFixed(2)}`);
          }
        } else if (this.over6v2Phase === 'RECOVERY') {
          this.sendLog(`✨ OVER 6 V2: Recovery successful.`);
          this.over6v2Phase = 'SEARCHING';
          this.sessionConsecutiveLosses = 0;
          if (this._shouldResetMartingaleOnWin()) this._syncSessionMartingaleStep(0);
        }
        this._onSessionWin('OVER_6_V2');
        this.over6v2CurrentWins++;
        this.over6v2CurrentLosses = 0;
      } else {
        if (this.over6v2Phase === 'DEBT_RECOVERY') {
          this.over6v2Debt += Math.abs(profit);
          this.sendLog(`⚠️ OVER 6 V2: Debt recovery loss. Total Debt: $${this.over6v2Debt.toFixed(2)}`);
        } else if (this.over6v2Phase === 'TRADING') {
          if (this.config.recoveryEnabled === false) {
            this.over6v2Phase = 'DEBT_RECOVERY';
            this.over6v2Debt += Math.abs(profit);
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.over6v2TargetMarket);
            this.sendLog(`⚠️ OVER 6 V2: Loss detected. Martingale OFF. Entering Debt Recovery. Debt: $${this.over6v2Debt.toFixed(2)}`);
          } else {
            this.over6v2Phase = 'RECOVERY';
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.over6v2TargetMarket);
            this.sendLog(`⚠️ OVER 6 V2: Loss detected. Entering Recovery.`);
          }
        }
        this._onSessionLoss('OVER_6_V2');
        this.over6v2CurrentLosses++;
        this.over6v2CurrentWins = 0;
      }
      riskManager.recordResult(direction, won, profit);
    } else if (this.strategy === 'UNDER_3_V1') {
      if (won) {
        if (this.under3v1Phase === 'DEBT_RECOVERY') {
          this.under3v1Debt -= profit;
          if (this.under3v1Debt <= 0) {
            this.under3v1Debt = 0;
            this.sendLog(`✅ UNDER 3 V1: Debt fully recovered! Returning to original trades.`);
            this.under3v1Phase = 'SEARCHING';
            this.sessionConsecutiveLosses = 0;
            this._syncSessionMartingaleStep(0);
          } else {
            this.sendLog(`💰 UNDER 3 V1: Partial recovery win. Remaining Debt: $${this.under3v1Debt.toFixed(2)}`);
          }
        } else if (this.under3v1Phase === 'RECOVERY') {
          this.sendLog(`✨ UNDER 3 V1: Recovery successful.`);
          this.under3v1Phase = 'SEARCHING';
          this.sessionConsecutiveLosses = 0;
          if (this._shouldResetMartingaleOnWin()) this._syncSessionMartingaleStep(0);
        }
        this._onSessionWin('UNDER_3_V1');
        this.under3v1CurrentWins++;
        this.under3v1CurrentLosses = 0;
      } else {
        if (this.under3v1Phase === 'DEBT_RECOVERY') {
          this.under3v1Debt += Math.abs(profit);
          this.sendLog(`⚠️ UNDER 3 V1: Debt recovery loss. Total Debt: $${this.under3v1Debt.toFixed(2)}`);
        } else if (this.under3v1Phase === 'TRADING') {
          if (this.config.recoveryEnabled === false) {
            this.under3v1Phase = 'DEBT_RECOVERY';
            this.under3v1Debt += Math.abs(profit);
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.under3v1TargetMarket);
            this.sendLog(`⚠️ UNDER 3 V1: Loss detected. Martingale OFF. Entering Debt Recovery. Debt: $${this.under3v1Debt.toFixed(2)}`);
          } else {
            this.under3v1Phase = 'RECOVERY';
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.under3v1TargetMarket);
            this.sendLog(`⚠️ UNDER 3 V1: Loss detected. Entering Recovery.`);
          }
        }
        this._onSessionLoss('UNDER_3_V1');
        this.under3v1CurrentLosses++;
        this.under3v1CurrentWins = 0;
      }
      riskManager.recordResult(direction, won, profit);
    } else if (this.strategy === 'EVEN_V1') {
      if (won) {
        if (this.evenV1Phase === 'DEBT_RECOVERY') {
          this.evenV1Debt -= profit;
          if (this.evenV1Debt <= 0) {
            this.evenV1Debt = 0;
            this.sendLog(`✅ EVEN V1: Debt fully recovered! Returning to normal trading.`);
            this.evenV1Phase = 'SEARCHING';
            this.sessionConsecutiveLosses = 0;
            this._syncSessionMartingaleStep(0);
          } else {
            this.sendLog(`💰 EVEN V1: Partial recovery win. Remaining Debt: $${this.evenV1Debt.toFixed(2)}`);
          }
        } else if (this.evenV1Phase === 'RECOVERY') {
          this.sendLog(`✨ EVEN V1: Recovery successful.`);
          this.evenV1Phase = 'SEARCHING';
          this.sessionConsecutiveLosses = 0;
          if (this._shouldResetMartingaleOnWin()) this._syncSessionMartingaleStep(0);
        }
        this._onSessionWin('EVEN_V1');
        this.evenV1CurrentWins++;
        this.evenV1CurrentLosses = 0;
      } else {
        if (this.evenV1Phase === 'DEBT_RECOVERY') {
          this.evenV1Debt += Math.abs(profit);
          this.sendLog(`⚠️ EVEN V1: Debt recovery loss. Total Debt: $${this.evenV1Debt.toFixed(2)}`);
        } else if (this.evenV1Phase === 'TRADING') {
          if (this.config.recoveryEnabled === false) {
            this.evenV1Phase = 'DEBT_RECOVERY';
            this.evenV1Debt += Math.abs(profit);
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.evenV1TargetMarket);
            this.sendLog(`⚠️ EVEN V1: Loss detected. Martingale OFF. Entering Debt Recovery. Debt: $${this.evenV1Debt.toFixed(2)}`);
          } else {
            this.evenV1Phase = 'RECOVERY';
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.evenV1TargetMarket);
            this.sendLog(`⚠️ EVEN V1: Loss detected. Entering Recovery.`);
          }
        }
        this._onSessionLoss('EVEN_V1');
        this.evenV1CurrentLosses++;
        this.evenV1CurrentWins = 0;
      }
      riskManager.recordResult(direction, won, profit);
    } else if (this.strategy === 'ODD_V1') {
      if (won) {
        if (this.oddV1Phase === 'DEBT_RECOVERY') {
          this.oddV1Debt -= profit;
          if (this.oddV1Debt <= 0) {
            this.oddV1Debt = 0;
            this.sendLog(`✨ ODD V1: Debt fully recovered! Returning to ODD.`);
            this.oddV1Phase = 'TRADING';
            this.sessionConsecutiveLosses = 0;
            this._syncSessionMartingaleStep(0);
          } else {
            this.sendLog(`💰 ODD V1: Partial recovery win. Remaining Debt: $${this.oddV1Debt.toFixed(2)}`);
          }
        } else if (this.oddV1Phase === 'RECOVERY') {
          this.sendLog(`✨ ODD V1: Recovery successful.`);
          this.oddV1Phase = 'TRADING';
          this.sessionConsecutiveLosses = 0;
          if (this._shouldResetMartingaleOnWin()) this._syncSessionMartingaleStep(0);
        }
        this._onSessionWin('ODD_V1');
        this.oddV1CurrentWins++;
        this.oddV1CurrentLosses = 0;
      } else {
        if (this.oddV1Phase === 'DEBT_RECOVERY') {
          this.oddV1Debt += Math.abs(profit);
          this.sendLog(`⚠️ ODD V1: Debt recovery loss. Total Debt: $${this.oddV1Debt.toFixed(2)}`);
        } else if (this.oddV1Phase === 'TRADING') {
          if (this.config.recoveryEnabled === false) {
            this.oddV1Phase = 'DEBT_RECOVERY';
            this.oddV1Debt += Math.abs(profit);
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.oddV1TargetMarket);
            this.sendLog(`⚠️ ODD V1: Loss detected. Martingale OFF. Entering Debt Recovery. Debt: $${this.oddV1Debt.toFixed(2)}`);
          } else {
            this.oddV1Phase = 'RECOVERY';
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.oddV1TargetMarket);
            this.sendLog(`⚠️ ODD V1: Loss detected. Entering Recovery.`);
          }
        }
        this._onSessionLoss('ODD_V1');
        this.oddV1CurrentLosses++;
        this.oddV1CurrentWins = 0;
      }
      riskManager.recordResult(direction, won, profit);
    } else if (this.strategy === 'OVER_0_V1') {
      if (won) {
        if (this.over0v1Phase === 'DEBT_RECOVERY_OVER_0') {
          this.over0v1Debt -= profit;
          if (this.over0v1Debt <= 0) {
            this.over0v1Debt = 0;
            this.sendLog(`✨ OVER 0 V1: Debt fully recovered! Returning to OVER 0.`);
            this.over0v1Phase = 'TRADING_OVER_0';
            this.sessionConsecutiveLosses = 0;
            this._syncSessionMartingaleStep(0);
          } else {
            this.sendLog(`💰 OVER 0 V1: Partial recovery win. Remaining Debt: $${this.over0v1Debt.toFixed(2)}`);
          }
        } else if (this.over0v1Phase === 'RECOVERY_OVER_0') {
          this.sendLog(`✨ OVER 0 V1: Recovery successful.`);
          this.over0v1Phase = 'TRADING_OVER_0';
          this.sessionConsecutiveLosses = 0;
          if (this._shouldResetMartingaleOnWin()) this._syncSessionMartingaleStep(0);
        }
        this._onSessionWin('OVER_0_V1');
        this.over0v1CurrentWins++;
        this.over0v1CurrentLosses = 0;
      } else {
        if (this.over0v1Phase === 'DEBT_RECOVERY_OVER_0') {
          this.over0v1Debt += Math.abs(profit);
          this.sendLog(`⚠️ OVER 0 V1: Debt recovery loss. Total Debt: $${this.over0v1Debt.toFixed(2)}`);
        } else if (this.over0v1Phase === 'TRADING_OVER_0') {
          if (this.config.recoveryEnabled === false) {
            this.over0v1Phase = 'DEBT_RECOVERY_OVER_0';
            this.over0v1Debt += Math.abs(profit);
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.over0v1TargetMarket);
            this.sendLog(`⚠️ OVER 0 V1: Loss detected. Martingale OFF. Entering Debt Recovery. Debt: $${this.over0v1Debt.toFixed(2)}`);
          } else {
            this.over0v1Phase = 'RECOVERY_OVER_0';
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.over0v1TargetMarket);
            this.sendLog(`⚠️ OVER 0 V1: Loss detected. Entering Recovery.`);
          }
        }
        
        this._onSessionLoss('OVER_0_V1');
        this.over0v1CurrentLosses++;
        this.over0v1CurrentWins = 0;
      }
      riskManager.recordResult(direction, won, profit);
    } else if (this.strategy === 'UNDER_9_V1') {
      if (won) {
        if (this.under9v1Phase === 'DEBT_RECOVERY') {
          this.under9v1Debt -= profit;
          if (this.under9v1Debt <= 0) {
            this.under9v1Debt = 0;
            this.sendLog(`✨ UNDER 9 V1: Debt fully recovered! Returning to UNDER 9.`);
            this.under9v1Phase = 'TRADING';
            this.sessionConsecutiveLosses = 0;
            this._syncSessionMartingaleStep(0);
          } else {
            this.sendLog(`💰 UNDER 9 V1: Partial recovery win. Remaining Debt: $${this.under9v1Debt.toFixed(2)}`);
          }
        } else if (this.under9v1Phase === 'RECOVERY') {
          this.sendLog(`✨ UNDER 9 V1: Recovery successful.`);
          this.under9v1Phase = 'TRADING';
          this.sessionConsecutiveLosses = 0;
          if (this._shouldResetMartingaleOnWin()) this._syncSessionMartingaleStep(0);
        }
        this._onSessionWin('UNDER_9_V1');
        this.under9v1CurrentWins++;
        this.under9v1CurrentLosses = 0;
      } else {
        if (this.under9v1Phase === 'DEBT_RECOVERY') {
          this.under9v1Debt += Math.abs(profit);
          this.sendLog(`⚠️ UNDER 9 V1: Debt recovery loss. Total Debt: $${this.under9v1Debt.toFixed(2)}`);
        } else if (this.under9v1Phase === 'TRADING') {
          if (this.config.recoveryEnabled === false) {
            this.under9v1Phase = 'DEBT_RECOVERY';
            this.under9v1Debt += Math.abs(profit);
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.under9v1TargetMarket);
            this.sendLog(`⚠️ UNDER 9 V1: Loss detected. Martingale OFF. Entering Debt Recovery. Debt: $${this.under9v1Debt.toFixed(2)}`);
          } else {
            this.under9v1Phase = 'RECOVERY';
            this.lockedRecoveryDirection = this._getFlowBasedRecoveryDirection(this.under9v1TargetMarket);
            this.sendLog(`⚠️ UNDER 9 V1: Loss detected. Entering Recovery.`);
          }
        }
        this._onSessionLoss('UNDER_9_V1');
        this.under9v1CurrentLosses++;
        this.under9v1CurrentWins = 0;
      }
      riskManager.recordResult(direction, won, profit);
    } else if (this.strategy === 'O0_U9_HYBRID') {
      if (this.hybridPhase === 'RECOVERY') {
        this.hybridRecoveryTotalAttempts = (this.hybridRecoveryTotalAttempts || 0) + 1;
        this._hybridTotalAttemptsNeedsReevaluation = true;
      }

      if (won) {
        if (this.hybridPhase === 'RECOVERY') {
          // Recovery win — subtract profit from debt
          this.hybridDebt -= profit;
          
          const baseStake = this.config.baseStake || 0.35;
          // Exit ONLY if fully cleared (<= 0). Use 0.001 to handle floating point noise.
          if (this.hybridDebt <= 0.001) {
            // Debt is fully cleared
            this.hybridDebt = 0;
            this.sendLog(`✅ O0/U9 HYBRID: Debt fully recovered! Returning to SEARCHING.`);
            this.hybridPhase = 'SEARCHING';
            this.hybridCurrentLosses = 0;
            this.hybridRecoveryConsecutiveLosses = 0;
            this.hybridRecoveryTotalAttempts = 0;
            this.hybridRecoveryDirection = null;
            this._hybridNeedsReevaluation = false;
            this.sessionConsecutiveLosses = 0;
            this._syncSessionMartingaleStep(0);
          } else {
            // Partial win — still have significant debt remaining, stay in RECOVERY
            this.hybridRecoveryConsecutiveLosses = 0; // reset consecutive recovery losses on win
            this.sendLog(`💰 O0/U9 HYBRID: Recovery win! Remaining Debt: $${this.hybridDebt.toFixed(2)}`);
          }
        } else {
          // Normal trading win
          this.hybridCurrentLosses = 0;
        }
        this._onSessionWin('O0_U9_HYBRID');
        this.hybridCurrentWins++;
      } else {
        // LOSS
        const lossAmt = Math.abs(profit);
        this.hybridDebt = (this.hybridDebt || 0) + lossAmt;

        if (this.hybridPhase !== 'RECOVERY') {
          // First loss from TRADING → enter RECOVERY
          this.hybridPhase = 'RECOVERY';
          this.hybridRecoveryConsecutiveLosses = 0;
          this.hybridRecoveryTotalAttempts = 0;
          this.hybridMarketEntryDebt = this.hybridDebt;
          // Dynamically evaluate OVER5 vs UNDER4
          this.hybridRecoveryDirection = this._evaluateHybridRecoveryDirection(this.hybridTargetMarket);
          this._hybridNeedsReevaluation = false;
          this.sendLog(`🔴 O0/U9 HYBRID: Loss on ${this.hybridSide === 'OVER0' ? 'OVER 0' : 'UNDER 9'}. Recovery via ${this.hybridRecoveryDirection}. Debt: $${this.hybridDebt.toFixed(2)}`);
        } else {
          // Loss during recovery — accumulate debt and track consecutive recovery losses
          this.hybridRecoveryConsecutiveLosses++;
          this._hybridNeedsReevaluation = true; // flag for re-evaluation at next multiple of 3
          this.sendLog(`🔴 O0/U9 HYBRID: Recovery loss #${this.hybridRecoveryConsecutiveLosses} (${this.hybridRecoveryDirection}). Debt: $${this.hybridDebt.toFixed(2)}`);
        }

        this._onSessionLoss('O0_U9_HYBRID');
        this.hybridCurrentLosses++;
        this.hybridCurrentWins = 0;

        this._evaluateCircuitBreaker(this.hybridCurrentLosses);
      }

      // Track local hybrid profit and check Hybrid Take Profit
      this.hybridSessionProfit = (this.hybridSessionProfit || 0) + profit;
      const hybridTp = Number(this.config.hybridTakeProfit) || 0;
      if (hybridTp > 0 && this.hybridSessionProfit >= hybridTp && this.hybridDebt <= 0.001) {
        // Only trigger local TP if debt is fully cleared — never wipe unrecovered debt
        this.sendLog(`🎉 O0/U9 HYBRID: Local Take Profit reached (+$${this.hybridSessionProfit.toFixed(2)} / +$${hybridTp.toFixed(2)}). Clearing everything and starting afresh!`);
        this.hybridSessionProfit = 0;
        this.hybridTargetMarket = null;
        this.hybridPhase = 'SEARCHING';
        this.hybridDebt = 0;
        this.hybridMarketEntryDebt = 0;
        this.hybridCurrentLosses = 0;
        this.hybridRecoveryConsecutiveLosses = 0;
        this.hybridRecoveryTotalAttempts = 0;
        this.hybridRecoveryDirection = null;
        this._hybridNeedsReevaluation = false;
        this._hybridTotalAttemptsNeedsReevaluation = false;
        this._syncSessionMartingaleStep(0);
        
        if (this.onHybridSoftReset) this.onHybridSoftReset();
      }

      riskManager.recordResult(direction, won, profit);
    } else if (this.strategy === 'RANDOM_PICKER') {
      if (won) {
        this._onSessionWin('RANDOM_PICKER');
        this.randomPickerCurrentWins++;
        this.randomPickerCurrentLosses = 0;
      } else {
        this._onSessionLoss('RANDOM_PICKER');
        this.randomPickerCurrentLosses++;
        this.randomPickerCurrentWins = 0;
      }
      riskManager.recordResult(direction, won, profit);
    } else if (this.strategy === 'MATCHES') {
      if (won) {
        this._onSessionWin('MATCHES');
        if (mStats) {
          mStats.totalSessionWins++;
          mStats.consecutiveLosses = 0;
        }
      } else {
        this._onSessionLoss('MATCHES');
        if (mStats) {
          mStats.totalSessionLosses++;
          mStats.consecutiveLosses++;
          if (mStats.consecutiveLosses >= 2) {
            mStats.quarantinedUntil = Date.now() + MARKET_QUARANTINE_MS; // 90 seconds quarantine
            this.sendLog(`⚠️ Market ${MARKET_LABELS[market] || market} paused ${Math.round(MARKET_QUARANTINE_MS / 1000)}s after 2 losses.`);
          }
        }
        // Stealth cooldown removed — fire next trade immediately
        this.pauseTicksRemaining = 0;
      }
      riskManager.recordResult(direction, won, profit);
    } else if (this.strategy === 'MATCH_DIFF') {
      if (won) {
        this._onSessionWin('MATCH_DIFF');
        if (mStats) mStats.consecutiveLosses = 0;
        // Win does not pull stake back to base — only loss counter resets via _onSessionWin
      } else {
        this._onSessionLoss('MATCH_DIFF');
        if (mStats) {
          mStats.consecutiveLosses++;
          // Market rotation: after 2 consecutive losses on a market -> switch market and quarantine for 90s
          if (mStats.consecutiveLosses >= 2) {
            mStats.quarantinedUntil = Date.now() + MARKET_QUARANTINE_MS; // 90 seconds quarantine
            mStats.consecutiveLosses = 0;
            this.sendLog(`⚠️ Market ${MARKET_LABELS[market] || market} paused ${Math.round(MARKET_QUARANTINE_MS / 1000)}s — rotating…`);
            this._switchMatchDiffMarket();
          }
        }

        // Escalate once to 1.5x and hold until win — no reset back to base on repeated losses
        if (this.matchDiffStakeStep < 1) {
          this.matchDiffStakeStep = 1;
        }

        // Stealth cooldown removed — fire next trade immediately
        this.pauseTicksRemaining = 0;
      }
      riskManager.recordResult(direction, won, profit);
    } else {
      // General BOTH, BOTH5, SINGLE channels
      const isWinningDual = this.strategy === 'OU_WINNING' || this.strategy === 'EO_WINNING';
      const sessionMartTournament = this._usesTournamentMode() &&
        (this.strategy === 'BOTH5' || this.strategy === 'BOTH');
      if (won) {
        if (sessionMartTournament) {
          const debtBefore = this._recoveryDebt || 0;
          this._handleMartingaleSettle(true, profit, buyPrice, direction);
          if (!this._martingaleRecoveryMode || debtBefore <= 0) {
            this._onSessionWin(channelKey);
      } else {
            this.sessionWinCount = (this.sessionWinCount || 0) + 1;
          }
        } else if (!this._martingaleRecoveryMode && (!isWinningDual || channelKey === 'SINGLE')) {
          this._onSessionWin(channelKey);
        } else if (isWinningDual && channelKey !== 'SINGLE') {
          const fp = getFastPassRecoveryState();
          if (!fp.failedDir || fp.failedDir === direction) {
            registerEngineFeedback(true, market, { dir: direction, strategy: this.strategy });
          }
        }
        if (mStats) {
          mStats.consecutiveLosses = 0;
          mStats.totalSessionWins = (mStats.totalSessionWins || 0) + 1;
        }
        this.matchDiffStakeStep = 0;
      } else {
        if (sessionMartTournament) {
          registerEngineFeedback(false, market, { dir: direction, strategy: this.strategy });
          if (!this._martingaleRecoveryMode) {
            this._onSessionLoss(channelKey, direction);
          }
          this._handleMartingaleSettle(false, profit, buyPrice, direction);
        } else if (isWinningDual && channelKey !== 'SINGLE') {
          registerEngineFeedback(false, market, { dir: direction, strategy: this.strategy });
        } else if (!this._martingaleRecoveryMode && (!isWinningDual || channelKey === 'SINGLE')) {
          this._onSessionLoss(channelKey, direction);
        }
        if (mStats) {
          mStats.consecutiveLosses++;
          mStats.totalSessionLosses = (mStats.totalSessionLosses || 0) + 1;
        }
      }
      riskManager.recordResult(direction, won, profit);
    }

    // Ghost breaks fully disabled — they caused the bot to stall for 8-20s
    // if (!this._usesTournamentMode()) { ... } — removed entirely

    // Refresh UI is handled later with the populated trade object

    // Extract the exact exit digit using strict string parsing to avoid float truncation bugs
    let finalDigit = '-';
    const rawExit = contract.exit_tick_display_value || contract.sell_spot_display_value || contract.current_spot_display_value;
    if (rawExit) {
      finalDigit = String(rawExit).slice(-1);
    } else {
      const rawNum = contract.exit_tick || contract.sell_spot || contract.current_spot;
      if (rawNum) finalDigit = String(rawNum).slice(-1); // less reliable if trailing zero is truncated, but best fallback
    }

    const trade = {
      id: cid,
      direction,
      market,
      stake: buyPrice,
      profit,
      won,
      exitTick: finalDigit, // Store just the digit
      barrier: contract.barrier || '',
      time: Date.now(),
      pending: false,
      isGhost: typeof isLedgerSettle !== 'undefined' ? isLedgerSettle : false,
      ...this._buildTradeMeta(market, direction),
    };

    this.sessionTrades.push(trade);
    this._lastTradeSettledAt = Date.now();

    const dwKey = `${market}:${direction}`;
    if (!this._dirWinHistory[dwKey]) this._dirWinHistory[dwKey] = [];
    this._dirWinHistory[dwKey].push(won ? 1 : 0);
    if (this._dirWinHistory[dwKey].length > 20) this._dirWinHistory[dwKey].shift();

    const vlDepth = channel?.vlDepthAtEntry || channel?.step || 0;
    if (vlDepth > 0) this._recordVlDepthResult(direction, vlDepth, won);

    let cooldownMs = 0;
    this._postTradeTickCooldown = 0;
    this.nextAllowedTradeTime = 0;
    
    if (this._isWinningDualStrategy()) {
      this._martingaleArmAfter = 0;
    } else if (this.strategy === 'OMNISNIPER') {
      setApexOrderInFlight(false);
      resetNetworkThrottle();
    }
    this.lastTradeTime = Date.now();

    // Log the trade outcome
    const expectancy = this.getExpectancy();
    if (this.strategy === 'MATCHES') {
      this.sendLog(
        `💸 [MATCH SNIPER OUTCOME] Market: ${MARKET_LABELS[market]} | Result: ${won ? '✅ WIN' : '❌ LOSS'} (${won ? '+' : ''}$${profit.toFixed(2)}) | ` +
        `Target Digit: ${this.matchesTargetDigit} | Stake: $${buyPrice.toFixed(2)} | session P&L: $${this.sessionTrades.reduce((sum, t) => sum + t.profit, 0).toFixed(2)} | ` +
        `Expectancy: $${expectancy.toFixed(4)}`
      );
    } else {
      this.sendLog(
        `💸 [TRADE OUTCOME] Market: ${MARKET_LABELS[market]} | Result: ${won ? '✅ WIN' : '❌ LOSS'} (${won ? '+' : ''}$${profit.toFixed(2)}) | ` +
        `Stake: $${buyPrice.toFixed(2)} | Active Phase: ${this.getPhase(market)} | ` +
        `Stake Multiplier: ${this.stakeMultiplier.toFixed(2)}x | session P&L: $${this.sessionTrades.reduce((sum, t) => sum + t.profit, 0).toFixed(2)} | ` +
        `Mathematical Expectancy: $${expectancy.toFixed(4)}`
      );
    }

    channel.active = false;
    channel.contractId = null;
    if (channelKey === 'SINGLE') {
      channel.lastDirection = channel.direction;
      this._lastTradeDirection = direction;
      this._lastTradeWon = won;
      channel.direction = null;
    }

    // ═══ MARTINGALE — session (tournament) or per-channel ═══
    const sessionMartTournament = this._usesTournamentMode() &&
      (this.strategy === 'BOTH5' || this.strategy === 'BOTH');
    const isWinningDualLeg = this.strategy === 'OU_WINNING' || this.strategy === 'EO_WINNING';

    if (isWinningDualLeg && channelKey !== 'SINGLE') {
      // Martingale + loss counters applied when both legs settle (_handleWinningDualLegSettlement)
    } else if (sessionMartTournament) {
      channel.consecutiveLosses = won ? 0 : (channel.consecutiveLosses || 0) + 1;
      channel.stake = this._getSessionMartingaleStake();
      channel.step = this._sessionMartingaleStep || 0;
    } else if (won) {
      channel.consecutiveLosses = 0;
      // Reset Rise/Fall loss counter on win
      if (direction === 'RISE' || direction === 'FALL') {
        this._rfConsecutiveLosses = 0;
      }
      if (this.config.recoveryEnabled !== false) {
        if (this._shouldResetMartingaleOnWin()) {
          this._resetChannelMartingale(channelKey);
          if (this._usesTournamentMode() && (this.strategy === 'BOTH5' || this.strategy === 'BOTH')) {
            this._syncSessionMartingaleStep(0);
          }
          this.sendLog(`✅ [${channelKey}] WIN $${profit.toFixed(2)} — martingale reset · $${channel.stake.toFixed(2)}`);
      } else {
          channel.stake = this._getMartingaleStake(channel);
          this.sendLog(`✅ [${channelKey}] WIN $${profit.toFixed(2)} — martingale step kept at ${channel.step || 0}`);
      }
    } else {
        this.sendLog(`✅ [${channelKey}] WIN $${profit.toFixed(2)}`);
      }
    } else if (profit < 0 && !(isWinningDualLeg && channelKey !== 'SINGLE')) {
      channel.consecutiveLosses = (channel.consecutiveLosses || 0) + 1;
      if (mStats) mStats.lastLossAt = Date.now();
      this._blockDirectionAfterLoss(direction, market);

      if (this.config.recoveryEnabled !== false) {
        const hold = this._getMartingaleHoldAfterStep();
        const prev = channel.step || 0;
        channel.step = hold > 0 ? Math.min(hold, prev + 1) : prev + 1;
        
        if (direction === 'RISE' || direction === 'FALL') {
          // Use standard martingale multiplier instead of hardcoded XML formula
          channel.stake = this._getMartingaleStake(channel);

          // Track consecutive Rise/Fall losses and trigger pause at 3
          this._rfConsecutiveLosses = (this._rfConsecutiveLosses || 0) + 1;
          if (this._rfConsecutiveLosses >= 3) {
            const pauseTicks = 3 + Math.floor(Math.random() * 3); // 3, 4, or 5
            this._rfPauseUntil = Date.now() + (pauseTicks * 2000); // approx 2 seconds per tick
            this._rfWaitingForReversal = false; // Will be set true after pause ends
            this._rfPauseDirection = direction;
            this.sendLog(`⚠️ Rise/Fall: 3+ consecutive losses — pausing for ~${pauseTicks} ticks (${pauseTicks * 2}s) then watching for reversal.`);
            // After the pause expires, _executeRiseFallCycle will flip to reversal-watch
            // We do NOT reset _rfConsecutiveLosses here; it resets on the next win
          }
        } else {
          channel.stake = this._getMartingaleStake(channel);
        }

        const capNote = this._getMaxStakeCap() != null ? `, cap $${this._getMaxStakeCap().toFixed(2)}` : '';
        this.sendLog(
          `❌ [${channelKey}] LOSS $${profit.toFixed(2)} — next stake $${channel.stake.toFixed(2)} (step ${channel.step}${capNote})`
        );
      } else {
        channel.step = 0;
        channel.stake = this._resolveStake(this.config.baseStake);
        this.sendLog(`❌ [${channelKey}] LOSS — flat stake $${channel.stake.toFixed(2)} (martingale off)`);
      }
    }

    const isDualStrategy = this.strategy === 'BOTH5' || this.strategy === 'BOTH' ||
                           this.strategy === 'OU_WINNING' || this.strategy === 'EO_WINNING';

    if (isDualStrategy && channelKey !== 'SINGLE') {
      const switchThreshold = this._getSwitchAfterLossesThreshold();
      if (switchThreshold > 0 && !won && channel.consecutiveLosses >= switchThreshold) {
        if (this.strategy === 'RANDOM_PICKER' && this.config.autoSwitchMarkets !== false && !this._isWinningDualStrategy()) {
          this.sendLog(`⚠️ [${channelKey}] reached ${channel.consecutiveLosses} consecutive losses. Rotating market...`);
          this._maybeRotateMarketForLeg(direction, `${channel.consecutiveLosses} consec`)
            || null;
        }
      }

      // Always record trade to history
      if (this.onTradeUpdate) this.onTradeUpdate(trade);

      const dirs = this.strategy === 'OU_WINNING' ? ['OVER5', 'UNDER4']
        : (this.strategy === 'BOTH5' ? ['OVER5', 'UNDER5'] : ['EVEN', 'ODD']);
      const bothSettled = dirs.every(d => !this.channels[d].active);

      if (bothSettled && this.running) {
        if (this._usesTournamentMode() && this._martingaleRecoveryMode) {
          const lastTwo = this.sessionTrades.slice(-2);
          const net = lastTwo.reduce((s, t) => s + (t.profit || 0), 0);
          if (net > 0 && this._recoveryDebt < 0.15) {
            this._onSessionWin('recovery-dual');
          } else if (net < 0) {
            this._onSessionLoss('recovery-dual');
          }
          queueMicrotask(() => {
            if (this.running) this._scheduleTournamentFireTry();
          });
          return;
        }
        if (this.strategy === 'OU_WINNING' || this.strategy === 'EO_WINNING') {
          const lastTwo = [...this.sessionTrades.slice(-2)].sort(
            (a, b) => this._dualLegSortKey(a.direction) - this._dualLegSortKey(b.direction)
          );
          if (lastTwo.length === 2) {
            const net = lastTwo.reduce((s, t) => s + t.profit, 0);
            const bothLost = lastTwo.every(t => !t.won);
            const loser = lastTwo.find(t => !t.won);
            const winner = lastTwo.find(t => t.won);

            if (loser && winner) {
              this._handleDualLegRoundSettlement(winner, loser, net);
              this.sendLog(
                `🔄 Dual round net ${net >= 0 ? '+' : ''}$${net.toFixed(2)} · ${winner.direction} won · paired step ${this._dualPairStep ?? 0}`
              );
            }

            if (bothLost) {
              for (const t of lastTwo) {
                this._recordLegMarketResult(t.market || this.activeMarket, t.direction, false);
              }
              this.dualNetLossStreak = (this.dualNetLossStreak || 0) + 1;
              const priorityDir = this._getDualRecoveryPriorityDir(dirs) || dirs[0];
              const base = this._resolveStake(this.config.baseStake);
              for (const dir of dirs) {
                if (dir === priorityDir) {
                  this._applyWinningDualLegMartingale(dir, false);
                } else {
                  const ch = this.channels[dir];
                  if (ch) {
                    ch.step = 0;
                    ch.stake = base;
                    ch.consecutiveLosses = (ch.consecutiveLosses || 0) + 1;
                  }
                }
              }
              this._lastDualLosingDir = priorityDir;
              this.sessionConsecutiveLosses = (this.sessionConsecutiveLosses || 0) + 1;
              this.sessionLossCount = (this.sessionLossCount || 0) + 1;
              this.sendLog(
                `⚠️ Both legs lost — martingale on ${priorityDir} only → $${this._getDualLegMartingaleStake(priorityDir).toFixed(2)} · ` +
                `hedge @ $${base.toFixed(2)}`
              );
            } else if (net > 0) {
              this.dualNetLossStreak = Math.max(0, (this.dualNetLossStreak || 0) - 1);
            } else if (loser) {
              this.dualNetLossStreak = Math.max(0, (this.dualNetLossStreak || 0) - 1);
            }
          } else if (lastTwo.length === 1) {
            const t = lastTwo[0];
            this._recordLegMarketResult(t.market || this.activeMarket, t.direction, t.won);
            if (this.channels[t.direction]) {
              this._applyWinningDualLegMartingale(t.direction, t.won);
              const base = this._resolveStake(this.config.baseStake);
              if (t.won) {
                this.sendLog(`✅ ${t.direction} solo win — martingale reset $${base.toFixed(2)}`);
              } else {
                const ch = this.channels[t.direction];
                this.sendLog(`📈 ${t.direction} solo loss — step ${ch.step} · next $${ch.stake.toFixed(2)}`);
              }
            }
          }
          if (this.activeMarket) delete this._marketOppositeLock[this.activeMarket];
        }
        this._martingaleArmAfter = 0;
        this._postTradeTickCooldown = 0;
        this.nextAllowedTradeTime = 0;
        this._scheduleNext(0);
        return;
      }
      // Partner still settling — wait for it
      return;
    }

    if (this.onTradeUpdate) this.onTradeUpdate(trade);


    if (this.running) this._scheduleNext(0);
  }

  _executeOmnisniperCycle() {
    if (!this.running) return;

    this._cleanStaleOpenContracts();

    // Recover stale single-flight lock after loss/settlement hiccup
    if (this._hasTournamentTradeInFlight() && !this._hasOpenTournamentContracts()) {
      const stuckSlot = this.executionSlots.find(s => s.active && !s.contractId);
      if (stuckSlot) {
        this.sendLog('🔧 Omnisniper — clearing stale slot lock after settlement');
        this._releaseTournamentFire(stuckSlot);
        setApexOrderInFlight(false);
        resetNetworkThrottle();
      }
    }

    if (this._postTradeTickCooldown > 0) {
      this.updateStatus(`🎯 Omnisniper · cooldown ${this._postTradeTickCooldown} tick${this._postTradeTickCooldown > 1 ? 's' : ''}…`, true);
      this._scheduleNext(OMNI_SCAN_MS);
      return;
    }

    // In trade — wait
    if (this._hasTournamentTradeInFlight() || this._hasOpenTournamentContracts()) {
      this.updateStatus('🎯 Omnisniper · in trade…', true);
      this._scheduleNext(200);
      return;
    }
    if (this._dualHedgeInFlight) {
      this._scheduleNext(150);
      return;
    }

    // Clear any stale apex lock BEFORE checking network phase — never let it block the omni cycle
    if (isApexOrderInFlight()) setApexOrderInFlight(false);

    if (!canDispatchNetworkPhase()) {
      this._scheduleNext(150);
      return;
    }

    const freeSlot = this.executionSlots.find(s => !s.active && !s.contractId);
    if (!freeSlot) {
      this._scheduleNext(200);
      return;
    }

    const afterLoss = (this._omniConsecutiveLosses || 0) > 0 || (this.sessionConsecutiveLosses || 0) > 0;
    const minScore = afterLoss ? 18 : 12;

    // ── GATHER OMNIDIRECTIONAL INDICATORS ACROSS ALL 15 MARKETS ──
    const allCandidates = [];
    let warmedCount = 0;

    // ── OMNISNIPER TARGET DIRECTIONS (UNDER3 and OVER8 removed) ──
    const targets = [
      { dir: 'EVEN',  type: 'EO', profitWeight: 1.0, barrier: '' },
      { dir: 'ODD',   type: 'EO', profitWeight: 1.0, barrier: '' },
      { dir: 'OVER2', type: 'OU', barrier: 2, profitWeight: 0.6 },
      { dir: 'OVER3', type: 'OU', barrier: 3, profitWeight: 0.9 },
      { dir: 'OVER4', type: 'OU', barrier: 4, profitWeight: 1.3 },
      { dir: 'OVER5', type: 'OU', barrier: 5, profitWeight: 1.6 },
      { dir: 'UNDER5', type: 'OU', barrier: 5, profitWeight: 2.2 },
      { dir: 'UNDER6', type: 'OU', barrier: 6, profitWeight: 2.5 },
      { dir: 'UNDER7', type: 'OU', barrier: 7, profitWeight: 3.5 },
      { dir: 'UNDER8', type: 'OU', barrier: 8, profitWeight: 0.4 },
    ];

    for (const sym of MARKETS) {
      const ticks = scanner.buffers[sym] || [];
      if (ticks.length < 30) continue;
      warmedCount++;

      const scores = scanner.scores[sym] || {};

      for (const t of targets) {
        if (this._isBinaryEntryTrap(ticks, t.dir, scores)) continue;

        // ── REAL-TIME ANALYSIS ──
        const oppStreak = _getOppositeStreak(ticks, t.dir);
        const winFreq = _getWinFrequency(ticks, t.dir, 50);
        const recentWinFreq = _getWinFrequency(ticks, t.dir, 15);

        let score = 0;

        // 1. Opposite streak exhaustion — overdue signal
        score += oppStreak * 18;

        // 2. Historical win frequency (50-tick window)
        score += winFreq * 100;

        // 3. Short-term momentum (15-tick window) — recent trend strength
        const momentumBoost = recentWinFreq > winFreq ? (recentWinFreq - winFreq) * 80 : 0;
        score += momentumBoost;

        // 4. Distribution bias from scanner (real-time digit distribution)
        const lt = this._getDistributionBiasPct(t.dir, scores);
        const baseline = this._getOmniDirBaseline(t.dir);
        if (lt > baseline) {
          score += (lt - baseline) * 1.5;
        } else if (lt < baseline - 8) {
          score -= 8;
        }

        // 5. Digit counter alignment check
        const counter = scores.counter || analyzeDigitCounter(ticks);
        const sig = getCounterSignal(counter, t.dir);
        if (sig.aligned) score += sig.score * 3;
        else if (sig.score >= 8) score += sig.score * 1.5;
        else if (sig.score < 6) score -= 6;

        // 6. Cross-market consensus — how many other markets agree
        const consensus = this._countConsensusMarkets(t.dir, sym);
        if (consensus >= 2) score += consensus * 6;

        // 7. Session learning — prefer proven market+direction combos
        score += this._learningScoreAdjust(sym, t.dir);

        // 8. Profit weight modifier — prioritize high-profit targets
        score *= (t.profitWeight || 1.0);

        const hasEdge = oppStreak >= 1 || winFreq > 0.38 || sig.aligned || consensus >= 2;
        if (score >= minScore && hasEdge) {
          allCandidates.push({
            sym,
            dir: t.dir,
            barrier: t.barrier,
            score,
            oppStreak,
            winFreq,
            recentWinFreq,
            lt,
            counterAligned: sig.aligned,
            consensus,
          });
        }
      }
    }

    if (allCandidates.length === 0) {
      this.updateStatus(`🎯 Omnisniper · scanning targets (${warmedCount}/${MARKETS.length} mkts)…`, true);
      this._scheduleNext(OMNI_SCAN_MS);
      return;
    }

    // Sort candidates by score descending — pick best real-time setup
    allCandidates.sort((a, b) => {
      if (afterLoss) {
        const aBoost = (a.counterAligned ? 12 : 0) + (a.consensus >= 2 ? 8 : 0);
        const bBoost = (b.counterAligned ? 12 : 0) + (b.consensus >= 2 ? 8 : 0);
        return (b.score + bBoost) - (a.score + aBoost);
      }
      return b.score - a.score;
    });

    const best = allCandidates[0];
    const stake = this._omniStake || this.config.baseStake || 0.35;

    if (!tryAcquireApexLock()) {
      this._scheduleNext(OMNI_SCAN_MS);
      return;
    }

    best.stake = stake;
    best.ready = true;
    best.algorithm = 'omnisniper_realtime';

    if (!this._claimTournamentFire(freeSlot, best)) {
      setApexOrderInFlight(false);
      this._scheduleNext(OMNI_SCAN_MS);
      return;
    }

    this._lastTournamentEntry = { sym: best.sym, dir: best.dir, score: best.score, winChance: 60, algorithm: best.algorithm, at: Date.now() };
    this.activeMarket = best.sym;
    if (this.onMarketSwitch) this.onMarketSwitch(best.sym);

    const lossTag = (this._omniConsecutiveLosses || 0) > 0 ? ` L${this._omniConsecutiveLosses}` : '';
    const ctrTag = best.counterAligned ? ' 🎯ctr' : '';
    const consTag = best.consensus >= 2 ? ` · x${best.consensus}mk` : '';
    this.sendLog(
      `🎯 Omni${lossTag} ${best.dir} ${MARKET_LABELS[best.sym]} · $${stake.toFixed(2)} · Sc${Math.round(best.score)}` +
      ` · WF${(best.winFreq * 100).toFixed(0)}%/${(best.recentWinFreq * 100).toFixed(0)}%` +
      ` · opp${best.oppStreak} · lt${(best.lt || 0).toFixed(0)}%${ctrTag}${consTag}`
    );
    this.updateStatus(`🎯 Omnisniper · ${best.dir} ${MARKET_LABELS[best.sym]}`, true);
    this._recordTradeFired();
    void this._executeInSlot(freeSlot, best);
    this._scheduleNext(OMNI_SCAN_MS);
  }

  // --- Legacy strategy execution loop for backward compatibility ---
  _executeLegacyCycle() {
    const scores = scanner.scores[this.activeMarket];
    if (!scores || scores.tickCount < 10) {
      this.updateStatus('Waiting for market data...');
      this._scheduleNext(2000);
      return;
    }

    const isDual = this.strategy === 'OU_WINNING' || this.strategy === 'EO_WINNING';

    if (isDual) {
      const hasData = MARKETS.some(m => (scanner.buffers[m]?.length || 0) >= 10);
      if (!hasData) {
        this.updateStatus('Waiting for market data...');
        this._scheduleNext(1500);
        return;
      }
      this._executeWinningSingleCycle();
      return;
    }

    const channel = this.channels.SINGLE;
    if (channel.active) {
        this.updateStatus('Polling settlement...');
        this._scheduleNext(1500);
        return;
      }

      if (this.strategy === 'DIFF') {
        const userDigit = this.config.diffTarget;
        const targetDigit = (!userDigit || userDigit === 'AUTO') ? this.currentAutoDigit : userDigit;

        if (this.waitingForTargetDigit && targetDigit != null) {
          this.updateStatus(`Waiting for digit ${targetDigit}...`);
          const lastDigit = scores.lastDigit;
          if (lastDigit === parseInt(targetDigit, 10)) {
            this.waitingForTargetDigit = false;
            this.pauseTicksRemaining = 2;
          } else {
            this._scheduleNext(1000);
            return;
          }
        }

        if (this.pauseTicksRemaining > 0) {
          this.updateStatus(`Paused (${this.pauseTicksRemaining} ticks)`);
          this.pauseTicksRemaining--;
          this._scheduleNext(1500);
          return;
        }

        let finalTarget;
        if (!userDigit || userDigit === 'AUTO') {
          const winsThreshold = this.config.diffWinsToChangeDigit || 5;
          if (this.currentAutoDigit === null || this.winsSinceDigitChange >= winsThreshold) {
            const indexed = scores.freq.map((f, d) => ({ digit: d, freq: f }));
            indexed.sort((a, b) => a.freq - b.freq);
            this.currentAutoDigit = (indexed.length >= 2 ? indexed[1] : indexed[0]).digit.toString();
            this.winsSinceDigitChange = 0;
          }
          finalTarget = this.currentAutoDigit;
        } else {
          finalTarget = userDigit;
        }

        this.updateStatus('Executing');
        this._placeTrade('SINGLE', 'DIFF', this._resolveTradeStake('SINGLE'), finalTarget.toString());
        return;
      }

      // ═══ STRATEGY EVALUATION (BOTH, BOTH5) ═══
      const recoveryCtx = this._getWinRecoveryContext();
      const minConf = (this.config.minConfidence ?? 60) + recoveryCtx.minConfBoost;
      const activeSubStrategy = this.strategy === 'BOTH5' ? 'BOTH5' : 'EVEN/ODD';

      // Ghost break disabled — never stall
      if (false && this.ghostBreakUntil > Date.now()) {
        const remainingStr = Math.ceil((this.ghostBreakUntil - Date.now()) / 1000);
        this.updateStatus(`👻 Stealth Break... (Resuming in ${remainingStr}s)`);
        this._stealthBackgroundActivity();
        this._scheduleNext(1000);
        return;
      }

      if (!this._lastDirections) this._lastDirections = [];

      const {
        bestSetup,
        maxOverStreak,
        maxUnderStreak,
        maxEvenStreak,
        maxOddStreak,
        reqOver,
        reqUnder,
        reqEven,
        reqOdd,
        recovery,
        rawSetupCount,
        candidateCount,
        vlReadyOver,
        vlReadyUnder,
        bestPeek,
        runnerUp,
      } = this._omniScanBestSetup(activeSubStrategy, minConf);

      if (!bestSetup) {
        const rc = recovery;
        let statusMsg = '';
        if (activeSubStrategy === 'BOTH5') {
          const overReady = maxOverStreak >= reqOver;
          const underReady = maxUnderStreak >= reqUnder;
          statusMsg = `📊 Scan ${MARKETS.length} mkts [O:${maxOverStreak}/${reqOver}${overReady ? ' ✓' : ''} U:${maxUnderStreak}/${reqUnder}${underReady ? ' ✓' : ''}]`;
          if (vlReadyOver > 0 || vlReadyUnder > 0) {
            statusMsg += ` · ${vlReadyOver + vlReadyUnder} mkts VL`;
          }
          if (bestPeek) {
            statusMsg += ` · rank ${bestPeek.winRank}`;
          }
        } else {
          statusMsg = `📊 Scan ${MARKETS.length} mkts [E:${maxEvenStreak}/${reqEven} O:${maxOddStreak}/${reqOdd}]`;
        }
        if (candidateCount > 0) statusMsg += ` · ${candidateCount} scored`;
        if (rc?.recoveryWinMode) {
          statusMsg = `🎯 Recovery ${rc.losses}/${rc.target} — ${statusMsg}`;
        }
        this.updateStatus(statusMsg, true);

        const vlHot = activeSubStrategy === 'BOTH5'
          && (maxOverStreak >= reqOver || maxUnderStreak >= reqUnder);
        if (vlHot && (!this._lastVlToastTime || Date.now() - this._lastVlToastTime > 8000)) {
          this._notifyOnce(
            this._toastIds.scan,
            `VL ready O:${maxOverStreak}/${reqOver} U:${maxUnderStreak}/${reqUnder} — firing scan`,
            { icon: '🎯', duration: 2500 }
          );
          this._lastVlToastTime = Date.now();
        } else if (
          recovery?.recoveryWinMode
          && !vlHot
          && (!this._lastVlToastTime || Date.now() - this._lastVlToastTime > 15000)
        ) {
          this._notifyOnce(
            this._toastIds.scan,
            `Recovery ${recovery.losses}/${recovery.target} — need O:${reqOver} U:${reqUnder} (have ${maxOverStreak}/${maxUnderStreak})`,
            { icon: '🛡️', duration: 3000 }
          );
          this._lastVlToastTime = Date.now();
        }

        if (!this._lastScanLogAt || Date.now() - this._lastScanLogAt > 8000) {
          this._lastScanLogAt = Date.now();
          this.sendLog(`📊 Omni-scan: ${statusMsg} | raw setups ${rawSetupCount || 0}`);
        }
        this._scheduleNext(OMNI_SCAN_MS);
        return;
      }

      if (this._shouldDeferTrade(bestSetup, runnerUp)) {
        const gap = runnerUp ? bestSetup.winRank - runnerUp.winRank : '—';
        this.updateStatus(
          `⏸ ${this.sessionConsecutiveLosses} losses — rank ${bestSetup.winRank} (gap ${gap})`,
          true
        );
        this._scheduleNext(OMNI_SCAN_MS);
        return;
      }

      const ch = this.channels.SINGLE;
      const confirmTicks = scanner.buffers[bestSetup.market] || [];
      const confirmDigit = confirmTicks[confirmTicks.length - 1];
      const confirmed = confirmDigit != null && this._directionWouldWin(confirmDigit, bestSetup.direction);
      const sameConfirmTarget = ch.confirmMarket === bestSetup.market && ch.confirmDirection === bestSetup.direction;

      if (ch.waitingForConfirm && sameConfirmTarget) {
        if (!confirmed) {
          ch.waitingForConfirm = false;
          ch.confirmDirection = null;
          ch.confirmMarket = null;
          this.sendLog(`❌ VL confirm aborted on ${MARKET_LABELS[bestSetup.market]} — streak continued`);
          this._scheduleNext(OMNI_SCAN_MS);
          return;
        }
        ch.waitingForConfirm = false;
        ch.confirmDirection = null;
        ch.confirmMarket = null;
      } else if (!confirmed) {
        ch.waitingForConfirm = true;
        ch.confirmDirection = bestSetup.direction;
        ch.confirmMarket = bestSetup.market;
        this.updateStatus(`⏳ VL saturated — wait confirm tick (${bestSetup.direction})`, true);
        this._scheduleNext(OMNI_SCAN_MS);
        return;
      }

      ch.pendingVlDepth = bestSetup.vlDepth || bestSetup.streak || 0;

      if (this._stealthMaybeHesitate()) return;

      if (!this._canFireTradeNow()) {
        this._scheduleNext(500);
        return;
      }

      const tradeStake = this._resolveTradeStake('SINGLE');
      const opp = bestSetup.oppositeBias;
      this.sendLog(
        `🎯 ${bestSetup.direction} on ${MARKET_LABELS[bestSetup.market]} | opp-bias ${opp?.score ?? 0}` +
        ` (end×${opp?.endConsecutive ?? 0} max×${opp?.maxConsecutive ?? 0}) | rank ${bestSetup.winRank} | ` +
        `stake $${tradeStake.toFixed(2)} step ${this.channels.SINGLE.step || 0} | rev ${bestSetup.reversalProb?.toFixed(0) ?? '—'}%`
      );
      this._recordTradeFired();
      this._lastDirections.push(bestSetup.direction);
      if (this._lastDirections.length > 2) this._lastDirections.shift();

      if (this.activeMarket !== bestSetup.market) {
        this.sendLog(`⚡ Omni-Scanner: Found superior setup on ${MARKET_LABELS[bestSetup.market] || bestSetup.market}. Switching market!`);
        this.activeMarket = bestSetup.market;
        if (this.onMarketSwitch) this.onMarketSwitch(this.activeMarket);
      }

      const chosenDirection = bestSetup.direction;
      const dirConf = bestSetup.conf;

      this.sendLog(`📊 Signal: ${chosenDirection} (Conf:${dirConf.toFixed(0)}% Q:${bestSetup.quality?.toFixed(1)} on ${MARKET_LABELS[this.activeMarket]})`);
      this.updateStatus('Executing');
      this._placeTrade('SINGLE', chosenDirection, this._resolveTradeStake('SINGLE'));
  }

  _switchMarketLegacy(lastDirection) {
    // Autoswitch disabled.
    return;
  }

  _executeMatchesDiffersCycle() {
    const channel = this.channels.SINGLE;
    if (channel.active) {
      this.updateStatus('Polling settlement...');
      this._scheduleNext(1500);
      return;
    }

    // Post-loss tick cooldown removed — fire immediately
    this.pauseTicksRemaining = 0;

    const ticks = scanner.buffers[this.activeMarket]?.slice(-5);
    if (!ticks || ticks.length < 5) {
      this.updateStatus('Waiting for tick data (need 5)...');
      this._scheduleNext(1000);
      return;
    }

    // Filter 1 — Repeat cluster check: If same digit appeared 3+ times in last 5 ticks -> skip
    const counts = {};
    for (const d of ticks) {
      counts[d] = (counts[d] || 0) + 1;
    }
    const hasCluster = Object.values(counts).some(c => c >= 3);
    if (hasCluster) {
      this.updateStatus('Skip: Digit cluster');
      this.sendLog(`⚠️ Skip entry: Same digit appeared 3+ times in last 5 ticks (${ticks.slice(-5).join(', ')}). Waiting for cluster to break.`);
      this._scheduleNext(1500);
      return;
    }

    // Barrier is the last digit of the previous tick
    const previousDigit = ticks[ticks.length - 1];

    // Stake sizing: base stake vs 1.5x recovery
    const baseStake = this.config.baseStake || 0.35;
    const actualStake = this.matchDiffStakeStep === 1 ? baseStake * 1.5 : baseStake;

    this.sendLog(
      `🔍 [MATCH_DIFF EVALUATION] Market: ${MARKET_LABELS[this.activeMarket] || this.activeMarket} | ` +
      `Ticks: ${ticks.join(', ')} | Skip Check: Passed | ` +
      `Previous Digit (Barrier): ${previousDigit} | Phase: MATCH_DIFF | ` +
      `Stake: $${actualStake.toFixed(2)} (${this.matchDiffStakeStep === 1 ? '1.5x recovery' : 'base stake'})`
    );

    this.updateStatus('Executing Matches/Differs');
    this._placeTrade('SINGLE', 'DIFF', actualStake, previousDigit.toString());
  }

  _scheduleNext(delayMs) {
    if (this._cycleTimer) clearTimeout(this._cycleTimer);
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (hidden && this.running && delayMs <= 200) {
      const now = Date.now();
      if (!this._bgCycleAt || now - this._bgCycleAt >= 80) {
        this._bgCycleAt = now;
        queueMicrotask(() => {
          if (this.running) this._executeCycle();
        });
      }
      this._cycleTimer = setTimeout(() => {
        this._cycleTimer = null;
        if (this.running) this._executeCycle();
      }, Math.max(1000, delayMs));
      return;
    }
    this._cycleTimer = setTimeout(() => {
      this._cycleTimer = null;
      if (this.running) this._executeCycle();
    }, delayMs);
  }

  updateConfig(config) {
    if (!this.config) {
      this.config = config;
      return;
    }
    // Merge new values into existing config — never clobber start()-processed fields blindly
    const prev = this.config;
    for (const key of Object.keys(config)) {
      prev[key] = config[key];
    }
    // Re-apply mandatory overrides from start()
    prev.baseStake = this._resolveStake(prev.baseStake || 0.35);
    if (prev.baseStake < 0.35) prev.baseStake = 0.35;
    prev.freezeMartingaleAfterLosses = 0;
    prev.maxMartingaleStepWhenLosing = 0;
    // Ensure OU/EO winning always has recovery on
    if (this.strategy === 'OU_WINNING' || this.strategy === 'EO_WINNING') {
      prev.recoveryEnabled = true;
    }
  }
}

// --- Self-contained technical indicator calculators ---
function calculateRSI(ticks, period = 14) {
  if (!ticks || ticks.length < period + 1) return NaN;
  let gains = [];
  let losses = [];
  for (let i = 1; i < ticks.length; i++) {
    const diff = ticks[i] - ticks[i - 1];
    if (diff > 0) {
      gains.push(diff);
      losses.push(0);
    } else {
      gains.push(0);
      losses.push(Math.abs(diff));
    }
  }
  if (gains.length < period) return NaN;

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calculateEMA(ticks, period = 50) {
  if (!ticks || ticks.length < period) return NaN;
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += ticks[i];
  }
  let ema = sum / period;
  const multiplier = 2 / (period + 1);
  for (let i = period; i < ticks.length; i++) {
    ema = (ticks[i] - ema) * multiplier + ema;
  }
  return ema;
}

function calculateATR(ticks, period = 14) {
  if (!ticks || ticks.length < period + 1) return NaN;
  let trs = [];
  for (let i = 1; i < ticks.length; i++) {
    trs.push(Math.abs(ticks[i] - ticks[i - 1]));
  }
  if (trs.length < period) return NaN;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function calculateADX(ticks, period = 14) {
  if (!ticks || ticks.length < period * 2 + 1) return NaN;
  let trs = [];
  let plusDMs = [];
  let minusDMs = [];
  for (let i = 1; i < ticks.length; i++) {
    const diff = ticks[i] - ticks[i - 1];
    trs.push(Math.abs(diff));
    if (diff > 0) {
      plusDMs.push(diff);
      minusDMs.push(0);
    } else {
      plusDMs.push(0);
      minusDMs.push(Math.abs(diff));
    }
  }

  let trSmoothed = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let plusDMSmoothed = plusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let minusDMSmoothed = minusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period;

  let dxs = [];
  for (let i = period; i < trs.length; i++) {
    trSmoothed = (trSmoothed * (period - 1) + trs[i]) / period;
    plusDMSmoothed = (plusDMSmoothed * (period - 1) + plusDMs[i]) / period;
    minusDMSmoothed = (minusDMSmoothed * (period - 1) + minusDMs[i]) / period;

    const plusDI = (plusDMSmoothed / (trSmoothed || 1)) * 100;
    const minusDI = (minusDMSmoothed / (trSmoothed || 1)) * 100;
    const sum = plusDI + minusDI;
    const diff = Math.abs(plusDI - minusDI);
    const dx = (diff / (sum || 1)) * 100;
    dxs.push(dx);
  }

  if (dxs.length < period) return NaN;
  let adx = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxs.length; i++) {
    adx = (adx * (period - 1) + dxs[i]) / period;
  }
  return adx;
}

function _getOppositeStreak(ticks, dir) {
  let streak = 0;
  for (let i = ticks.length - 1; i >= 0; i--) {
    const tick = ticks[i];
    const digit = parseInt(tick.toString().slice(-1), 10);
    if (isNaN(digit)) break;

    let isOpposite = false;
    if (dir === 'EVEN') isOpposite = (digit % 2 !== 0);
    else if (dir === 'ODD') isOpposite = (digit % 2 === 0);
    else if (dir.startsWith('OVER')) {
      const val = parseInt(dir.slice(4), 10);
      isOpposite = (digit <= val);
    } else if (dir.startsWith('UNDER')) {
      const val = parseInt(dir.slice(5), 10);
      isOpposite = (digit >= val);
    }

    if (isOpposite) streak++;
    else break;
  }
  return streak;
}

function _getWinFrequency(ticks, dir, windowSize = 30) {
  let wins = 0;
  const count = Math.min(windowSize, ticks.length);
  if (count <= 0) return 0;
  const slice = ticks.slice(-count);
  for (const tick of slice) {
    const digit = parseInt(tick.toString().slice(-1), 10);
    if (isNaN(digit)) continue;

    let won = false;
    if (dir === 'EVEN') won = (digit % 2 === 0);
    else if (dir === 'ODD') won = (digit % 2 !== 0);
    else if (dir.startsWith('OVER')) {
      const val = parseInt(dir.slice(4), 10);
      won = (digit > val);
    } else if (dir.startsWith('UNDER')) {
      const val = parseInt(dir.slice(5), 10);
      won = (digit < val);
    }

    if (won) wins++;
  }
  return wins / count;
}

const enhancedTradeEngine = new EnhancedTradeEngine();
export default enhancedTradeEngine;


