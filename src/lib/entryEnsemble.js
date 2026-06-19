/**
 * Entry signal algorithms for tournament mode (BOTH5 / BOTH).
 * Binary math ranks trades; 45% session win-rate floor gates every fire.
 */

export const TARGET_WIN_RATE = 0.45;
export const ACCOUNT_BLOW_WIN_RATE = 0.40;

export const ENTRY_ALGORITHMS = {
  DIGIT_COUNTER: 'digit_counter',
  DISTRIBUTION_BIAS: 'distribution_bias',
  SHORT_MOMENTUM: 'short_momentum',
  OPPOSITE_RUN: 'opposite_run',
  CHI_SKEW: 'chi_skew',
  LUNAR_MEMORY: 'lunar_memory',
  CROSS_MARKET: 'cross_market',
  REBOUND_TICK: 'rebound_tick',
  VL_STREAK: 'vl_streak',
};

/** Edge algos: Deriv RNG counter + distribution + cross-market + lunar. */
export const OMNI_ALGORITHM_ORDER = [
  ENTRY_ALGORITHMS.DIGIT_COUNTER,
  ENTRY_ALGORITHMS.DISTRIBUTION_BIAS,
  ENTRY_ALGORITHMS.CROSS_MARKET,
  ENTRY_ALGORITHMS.LUNAR_MEMORY,
];

export const ENTRY_ALGORITHM_ORDER = [
  ENTRY_ALGORITHMS.DIGIT_COUNTER,
  ENTRY_ALGORITHMS.DISTRIBUTION_BIAS,
  ENTRY_ALGORITHMS.SHORT_MOMENTUM,
  ENTRY_ALGORITHMS.OPPOSITE_RUN,
  ENTRY_ALGORITHMS.CHI_SKEW,
  ENTRY_ALGORITHMS.LUNAR_MEMORY,
  ENTRY_ALGORITHMS.CROSS_MARKET,
  ENTRY_ALGORITHMS.REBOUND_TICK,
  ENTRY_ALGORITHMS.VL_STREAK,
];

export const BINARY_WIN_P = {
  OVER1: 0.80, OVER2: 0.70, OVER3: 0.60, OVER4: 0.50, OVER5: 0.40, OVER6: 0.30, OVER7: 0.20,
  UNDER2: 0.20, UNDER3: 0.30, UNDER4: 0.40, UNDER5: 0.50, UNDER6: 0.60, UNDER7: 0.70, UNDER8: 0.80,
  EVEN: 0.50, ODD: 0.50, RISE: 0.50, FALL: 0.50, MATCH: 0.10, DIFF: 0.90,
};

export const BINARY_LOSS_P = {};
for (const [k, v] of Object.entries(BINARY_WIN_P)) {
  BINARY_LOSS_P[k] = 1 - v;
}

export const BINARY_BASELINE_PCT = {};
for (const [k, v] of Object.entries(BINARY_WIN_P)) {
  BINARY_BASELINE_PCT[k] = v * 100;
}

/** Strict dist bias — recovery / loss-streak mode only. */
export function minDistributionBias(dir) {
  const base = BINARY_BASELINE_PCT[dir] || 50;
  if (base >= 40 && base <= 60) return base + 8;
  return base + (base > 50 ? 6 : 12);
}

export function minDistributionBiasNormal(dir) {
  const base = BINARY_BASELINE_PCT[dir] || 50;
  // Increase required tick bias: OVER5 needs +4% above base, UNDER5 needs +1% above base
  return base > 50 ? base + 1 : base + 4;
}

export function hasRealDistributionEdge(dir, lt) {
  return (parseFloat(lt) || 0) >= minDistributionBias(dir);
}

export function hasNormalDistributionEdge(dir, lt) {
  return (parseFloat(lt) || 0) >= minDistributionBiasNormal(dir);
}

export const ALGO_META = {
  digit_counter: {
    label: 'Digit counter (RNG)',
    rating: '★★★★★',
    note: 'Tracks 0–9 deficit vs Deriv uniform model — mean-reversion entry',
  },
  distribution_bias: {
    label: 'Dist bias (binary)',
    rating: '★★★★★',
    note: '100-tick window must exceed binary baseline — required for fire',
  },
  short_momentum: {
    label: 'Short momentum',
    rating: '★★☆☆☆',
    note: 'Disabled in omni-scan — low edge on RNG digits',
  },
  opposite_run: {
    label: 'Opposite run',
    rating: '★★☆☆☆',
    note: 'Disabled in omni-scan — gambler fallacy risk',
  },
  chi_skew: {
    label: 'Chi² skew',
    rating: '★★☆☆☆',
    note: 'Disabled in omni-scan',
  },
  lunar_memory: {
    label: 'Lunar memory',
    rating: '★★★★☆',
    note: 'Post-streak reversal — omni secondary signal',
  },
  cross_market: {
    label: 'Cross-market',
    rating: '★★★★☆',
    note: 'Same direction confirmed on 2+ indices',
  },
  rebound_tick: {
    label: 'Rebound tick',
    rating: '★★☆☆☆',
    note: 'Disabled in omni-scan',
  },
  vl_streak: {
    label: 'VL streak',
    rating: '★☆☆☆☆',
    note: 'Disabled — streak depth alone is not edge',
  },
};

export function pickRandomAlgorithm(exclude = null) {
  const pool = exclude
    ? OMNI_ALGORITHM_ORDER.filter(a => a !== exclude)
    : OMNI_ALGORITHM_ORDER;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function streakLossProbability(dir, streak) {
  const p = BINARY_LOSS_P[dir] ?? 0.5;
  const n = Math.max(0, Math.floor(streak || 0));
  return Math.pow(p, n);
}

export function streakRarityScore(dir, streak, required = 3) {
  const p = streakLossProbability(dir, streak);
  if (p <= 0) return 100;
  const rarity = -Math.log10(p);
  const floor = -Math.log10(streakLossProbability(dir, required));
  return Math.max(0, Math.min(100, Math.round((rarity - floor) * 18)));
}

/**
 * Conservative win % — capped near realistic payout breakeven + small empirical lift.
 * (Displayed "68%" was inflated; this stays honest for 45% session target.)
 */
export function computeBinaryWinEstimate({
  dir,
  streak = 0,
  required = 3,
  lt = 0,
  rev = null,
  convergenceScore = 0,
  peers = 0,
  oppEnd = 0,
  counterScore = 0,
  counterAligned = false,
}) {
  const baseline = BINARY_BASELINE_PCT[dir] ?? 50;
  let est = baseline;

  const ltNum = parseFloat(lt) || 0;
  if (hasRealDistributionEdge(dir, ltNum)) {
    est += (ltNum - minDistributionBias(dir)) * 0.35;
  } else if (ltNum > baseline) {
    est += (ltNum - baseline) * 0.15;
  } else {
    est -= 4;
  }

  if (rev != null && Number.isFinite(rev) && rev >= baseline + 5) {
    est = est * 0.55 + rev * 0.45;
  }

  est += (() => {
    const excessStreak = Math.max(0, streak - required);
    if (excessStreak === 0) return 0;
    if (excessStreak === 1) return 2;
    if (excessStreak === 2) return 5;
    if (excessStreak === 3) return 8;
    return 11;
  })();
  est += Math.min(6, (peers || 0) * 1.5);
  est += Math.max(0, ((convergenceScore || 0) - 55) * 0.12);
  est += Math.min(3, (oppEnd || 0) * 0.5);
  if (counterAligned) est += Math.min(8, (counterScore || 0) * 0.22);
  else if ((counterScore || 0) < 12) est -= 3;

  const maxCap = baseline + 14;
  return Math.max(baseline, Math.min(maxCap, Math.round(est)));
}

export function computeBinaryEdge(candidate) {
  const dir = candidate.dir || candidate.direction;
  const binaryWinPct = computeBinaryWinEstimate({
    dir,
    streak: candidate.streak,
    required: candidate.required,
    lt: candidate.lt ?? candidate.distributionPct,
    rev: candidate.rev ?? candidate.reversalProb,
    convergenceScore: candidate.convergenceScore ?? 0,
    peers: candidate.consensus ?? candidate.peers ?? 0,
    oppEnd: candidate.oppEnd ?? 0,
    counterScore: candidate.counterScore ?? 0,
    counterAligned: candidate.counterAligned ?? false,
  });

  const agreement = candidate.algoAgreement ?? (candidate.algorithms?.length || 1);
  const conv = candidate.convergenceScore ?? 0;
  const lt = parseFloat(candidate.lt ?? candidate.distributionPct ?? 0) || 0;
  const distLift = hasRealDistributionEdge(dir, lt) ? (lt - minDistributionBias(dir)) * 2 : 0;

  const binaryEdge = Math.round(
    binaryWinPct * 1.1
    + conv * 0.65
    + distLift
    + Math.min(12, (agreement - 1) * 8)
    + (candidate.counterAligned ? Math.min(14, (candidate.counterScore ?? 0) * 0.35) : 0)
  );

  return { binaryWinPct, binaryEdge, streakRarity: streakRarityScore(dir, candidate.streak, candidate.required) };
}

export function applyBinaryScoring(candidate) {
  if (!candidate) return null;
  const { binaryWinPct, binaryEdge, streakRarity } = computeBinaryEdge(candidate);
  candidate.binaryWinPct = binaryWinPct;
  candidate.binaryEdge = binaryEdge;
  candidate.streakRarity = streakRarity;
  candidate.winChance = binaryWinPct;
  return candidate;
}

export function rankByBinaryEdge(candidates) {
  return [...candidates].sort((a, b) =>
    (b.binaryEdge ?? 0) - (a.binaryEdge ?? 0)
    || (b.binaryWinPct ?? 0) - (a.binaryWinPct ?? 0)
    || (b.convergenceScore ?? 0) - (a.convergenceScore ?? 0)
  );
}

/**
 * Unified ranking score (0–200) for cross-market comparison.
 * Every candidate — regardless of which algorithm generated it — gets
 * scored on the same scale so the #1 pick is the genuinely best market.
 */
export function computeUnifiedRankScore(candidate) {
  if (!candidate) return 0;
  const dir = candidate.dir || candidate.direction;
  const baseline = BINARY_BASELINE_PCT[dir] ?? 50;
  const lt = parseFloat(candidate.lt ?? candidate.distributionPct ?? 0) || 0;
  const conv = candidate.convergenceScore ?? 0;
  const counterScore = candidate.counterScore ?? 0;
  const counterAligned = candidate.counterAligned ?? false;
  const oppEnd = candidate.oppEnd ?? 0;
  const consensus = candidate.consensus ?? 0;
  const flowBonus = candidate.flowBonus ?? 0;
  const agree = candidate.algoAgreement ?? 1;

  // Distribution edge: how far above baseline (0–40 pts)
  const distEdge = Math.max(0, Math.min(40, (lt - baseline) * 2.5));

  // Counter deficit alignment (0–30 pts)
  const counterPts = counterAligned
    ? Math.min(30, counterScore * 1.2)
    : Math.min(10, counterScore * 0.3);

  // Convergence quality (0–30 pts)
  const convPts = Math.min(30, Math.max(0, (conv - 30) * 0.6));

  // Opposite run depth — deeper = more mean-reversion edge (0–25 pts)
  const oppPts = Math.min(25, oppEnd * 4.5);

  // Cross-market consensus (0–20 pts)
  const consensusPts = Math.min(20, consensus * 6);

  // Multi-algo agreement (0–20 pts)
  const agreePts = Math.min(20, (agree - 1) * 10);

  // Flow bonus/penalty (–20 to +15 pts)
  const flowPts = Math.max(-20, Math.min(15, flowBonus));

  // Momentum trap penalty (applied externally via candidate.momentumTrapped)
  const trapPenalty = candidate.momentumTrapped ? -40 : 0;

  return Math.round(
    distEdge + counterPts + convPts + oppPts
    + consensusPts + agreePts + flowPts + trapPenalty
  );
}

/**
 * Normal mode — pick best of 15 markets; VL-ready setups should fire regularly.
 */
export function passesNormalFireGate(candidate, opts = {}) {
  if (!candidate) return false;

  const dir = candidate.dir || candidate.direction;
  const lt = parseFloat(candidate.lt ?? candidate.distributionPct ?? 0) || 0;
  const conv = candidate.convergenceScore ?? 0;
  const win = candidate.binaryWinPct ?? candidate.winChance ?? 0;
  const reboundTicks = opts.reboundTicks ?? 0;
  const vlReady = candidate.ready === true;

  if (opts.apexPerfect) {
    return vlReady || win >= 38;
  }

  if (!vlReady && win < 42) return false;
  if (candidate.convBlocked) return false;
  if (conv < 34 && !vlReady) return false;
  if (!hasNormalDistributionEdge(dir, lt)) return false;
  if (reboundTicks < 1 && !vlReady) return false;

  return win >= 42 || (vlReady && win >= 40 && conv >= 34);
}

/** Entry thresholds from Settings — not hardcoded. */
export function getTournamentGateThresholds(config = {}, losses = 0) {
  const L = Math.max(0, Math.floor(Number(losses) || 0));
  const baseWin = Number(config.entryGateMinWin);
  const tighten = Number(config.entryGateTightenPerLoss);
  const baseConv = Number(config.entryGateMinConv);
  const baseEdge = Number(config.entryGateMinEdge);
  
  // Moderate thresholds that still allow recovery trades but demand high quality
  const minWin = (Number.isFinite(baseWin) ? baseWin : 54) + L * (Number.isFinite(tighten) ? tighten : 3);
  const minConv = (Number.isFinite(baseConv) ? baseConv : 50) + L * 2;
  const minEdge = (Number.isFinite(baseEdge) ? baseEdge : 115) + L * 8;
  const minOppEnd = L >= 1 ? (Number(config.entryGateMinOppEnd) || 4) : 4;
  const minOppStreak = L >= 1 ? (Number(config.entryGateMinOppStreak) || 4) : 4;
  
  return {
    minWin: Math.min(80, minWin),
    minConv: Math.min(70, minConv),
    minEdge: Math.min(180, minEdge),
    minOppEnd,
    minOppStreak,
  };
}

/**
 * BOTH / BOTH5 — only fire when mean-reversion edge is strong (targets higher win rate).
 */
export function passesTournamentWinGate(candidate, opts = {}) {
  if (!candidate) return false;

  const dir = candidate.dir || candidate.direction;
  const lt = parseFloat(candidate.lt ?? candidate.distributionPct ?? 0) || 0;
  const conv = candidate.convergenceScore ?? 0;
  const win = candidate.binaryWinPct ?? candidate.winChance ?? 0;
  const edge = candidate.binaryEdge ?? 0;
  const vlReady = candidate.ready === true || candidate.vlReady === true;
  const oppEnd = candidate.oppEnd ?? 0;
  const oppStreak = candidate.oppStreak ?? 0;
  const losses = opts.losses ?? 0;
  const agree = candidate.algoAgreement ?? (candidate.algorithms?.length || 1);
  const cfg = opts.config || {};
  const th = getTournamentGateThresholds(cfg, losses);

  if (candidate.convBlocked) return false;
  if (!hasNormalDistributionEdge(dir, lt)) return false;
  if (opts.flowOk === false) return false;

  const score = candidate.score ?? candidate.sniperScore ?? 0;
  const vwr = candidate.virtualWinRate ?? candidate.rate ?? 0;
  if (score >= 92 && vwr >= 92 && !vlReady && oppEnd < th.minOppEnd && oppStreak < th.minOppStreak) return false;

  if (win < th.minWin) return false;
  if (edge < th.minEdge && !candidate.apexPerfect) return false;

  const reversionSignal = oppEnd >= th.minOppEnd || oppStreak >= th.minOppStreak || vlReady;
  if (!reversionSignal) return false;

  if (candidate.apexPerfect) {
    const conf = candidate.confidenceScore ?? candidate.score ?? 0;
    const minConf = th.minWin + 4;
    if (conf >= 98 && vwr >= 98 && oppEnd < th.minOppEnd) return false;
    return conf >= minConf && conv >= th.minConv - 4 && reversionSignal;
  }

  if (!vlReady) return false;
  if (conv < th.minConv) return false;
  if (oppEnd < th.minOppEnd && oppStreak < th.minOppStreak) return false;

  if (losses >= 1 && agree < 2 && candidate.algorithm === 'apex_sniper_matrix') return false;
  if (losses >= 2 && agree < 2 && candidate.algorithm !== 'apex_matrix') return false;

  return true;
}

/**
 * Recovery mode — strict 45% floor after losses (counter + dist + conv).
 */
export function passesRecoveryFireGate(candidate, opts = {}) {
  if (!candidate) return false;

  const dir = candidate.dir || candidate.direction;
  const lt = parseFloat(candidate.lt ?? candidate.distributionPct ?? 0) || 0;
  const conv = candidate.convergenceScore ?? 0;
  const win = candidate.binaryWinPct ?? candidate.winChance ?? 0;
  const agree = candidate.algoAgreement ?? 1;
  const algos = candidate.algorithms || (candidate.algorithm ? [candidate.algorithm] : []);
  const hasDist = algos.includes(ENTRY_ALGORITHMS.DISTRIBUTION_BIAS);
  const rollingWr = opts.rollingWr;
  const losses = opts.losses ?? 0;
  const reboundTicks = opts.reboundTicks ?? 0;
  const counterAligned = opts.counterAligned ?? false;
  const counterScore = opts.counterScore ?? 0;

  if (!hasRealDistributionEdge(dir, lt)) return false;
  if (conv < 55) return false;
  if (reboundTicks < 2) return false;
  if (!counterAligned || counterScore < 18) return false;
  if (!hasDist && agree < 2) return false;

  if (rollingWr != null && rollingWr < ACCOUNT_BLOW_WIN_RATE && losses >= 2) {
    return win >= 52 && conv >= 62 && agree >= 2 && hasDist;
  }
  if (rollingWr != null && rollingWr < TARGET_WIN_RATE) {
    return win >= 50 && conv >= 58 && (hasDist || agree >= 2);
  }
  if (losses >= 3) {
    return win >= 50 && conv >= 58 && agree >= 2;
  }
  return win >= 48 && conv >= 55 && hasDist;
}

/** @deprecated alias */
export function passesFortyFivePercentGate(candidate, opts = {}) {
  return passesRecoveryFireGate(candidate, opts);
}

/** @deprecated use passesFortyFivePercentGate */
export function passesPerfectBinaryGate(candidate, tier = 'fast') {
  return passesFortyFivePercentGate(candidate, { tier });
}

/** Pause only in recovery mode — never block normal winning flow at session start. */
export function shouldPauseForLowWinRate(rollingWr, settledCount, consecutiveLosses, recoveryMode = false) {
  if (!recoveryMode) return false;
  if (settledCount < 15) return false;
  if (rollingWr != null && rollingWr < 0.35) return true;
  if (consecutiveLosses >= 8) return true;
  return false;
}
