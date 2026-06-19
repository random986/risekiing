/**
 * CSV / JSON export for trade analytics.
 */

export const TRADE_CSV_COLUMNS = [
  'time_iso',
  'market',
  'direction',
  'strategy',
  'stake',
  'profit',
  'won',
  'exit_tick',
  'score',
  'sniper_score',
  'virtual_win_rate',
  'streak',
  'martingale_level',
  'entry_algorithm',
  'session_loss_streak',
  'rolling_wr_10',
  'rolling_wr_50',
  'binary_win_pct',
  'binary_edge',
];

function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowToCsvRecord(trade) {
  return {
    time_iso: trade.time ? new Date(trade.time).toISOString() : '',
    market: trade.market,
    direction: trade.direction,
    strategy: trade.strategy,
    stake: trade.stake,
    profit: trade.profit,
    won: trade.won ? 1 : 0,
    exit_tick: trade.exitTick,
    score: trade.score,
    sniper_score: trade.sniperScore,
    virtual_win_rate: trade.virtualWinRate,
    streak: trade.streak,
    martingale_level: trade.martingaleLevel,
    entry_algorithm: trade.entryAlgorithm,
    session_loss_streak: trade.sessionLossStreak,
    rolling_wr_10: trade.rollingWinRate10,
    rolling_wr_50: trade.rollingWinRate50,
    binary_win_pct: trade.binaryWinPct,
    binary_edge: trade.binaryEdge,
  };
}

export function tradesToCsv(trades, columns = TRADE_CSV_COLUMNS) {
  const settled = (trades || []).filter(t => !t.pending);
  const header = columns.join(',');
  const rows = settled.map(t => {
    const rec = rowToCsvRecord(t);
    return columns.map(c => csvEscape(rec[c])).join(',');
  });
  return [header, ...rows].join('\n');
}

export function downloadTextFile(content, filename, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadTradesCsv(trades, prefix = 'derivprinter_trades') {
  downloadTextFile(
    tradesToCsv(trades),
    `${prefix}_${Date.now()}.csv`
  );
}

export function downloadTradesJson(trades, prefix = 'derivprinter_trades') {
  downloadTextFile(
    JSON.stringify(trades, null, 2),
    `${prefix}_${Date.now()}.json`,
    'application/json'
  );
}
