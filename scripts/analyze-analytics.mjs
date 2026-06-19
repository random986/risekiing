import fs from 'fs';

const paths = process.argv.slice(2);
function parse(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const hdr = lines[0].split(',');
  return lines.slice(1).filter(Boolean).map((l) => {
    const cols = l.split(',');
    const o = {};
    hdr.forEach((h, i) => { o[h] = cols[i] ?? ''; });
    o.won = +o.won;
    o.profit = +o.profit;
    o.stake = +o.stake;
    o.virtual_win_rate = +o.virtual_win_rate || 0;
    o.martingale_level = +o.martingale_level || 0;
    o.exit_tick = +o.exit_tick;
    o.score = +o.score || 0;
    return o;
  });
}

const all = paths.flatMap(parse);
const uniq = new Map();
for (const t of all) uniq.set(`${t.time_iso}|${t.market}|${t.direction}|${t.stake}`, t);
const trades = [...uniq.values()];

function wouldOppWin(t) {
  const d = t.exit_tick;
  const dir = t.direction;
  if (dir === 'EVEN') return d % 2 !== 0;
  if (dir === 'ODD') return d % 2 === 0;
  if (dir === 'OVER5') return d <= 5;
  if (dir === 'UNDER5') return d >= 5;
  return false;
}

function oppDir(d) {
  if (d === 'OVER5') return 'UNDER5';
  if (d === 'UNDER5') return 'OVER5';
  if (d === 'EVEN') return 'ODD';
  if (d === 'ODD') return 'EVEN';
  return d;
}

const w = trades.filter((t) => t.won === 1).length;
const byDir = {};
for (const t of trades) {
  if (!byDir[t.direction]) byDir[t.direction] = { w: 0, l: 0, p: 0 };
  if (t.won) byDir[t.direction].w++;
  else byDir[t.direction].l++;
  byDir[t.direction].p += t.profit;
}

console.log(JSON.stringify({
  total: trades.length,
  wins: w,
  wr: +(w / trades.length * 100).toFixed(1),
  netPl: +trades.reduce((s, t) => s + t.profit, 0).toFixed(2),
  invertWr: +(trades.filter(wouldOppWin).length / trades.length * 100).toFixed(1),
  mart4Losses: trades.filter((t) => !t.won && t.martingale_level >= 4).length,
  mart4Pl: +trades.filter((t) => t.martingale_level >= 4).reduce((s, t) => s + t.profit, 0).toFixed(2),
  byDir,
  vwr100: trades.filter((t) => t.virtual_win_rate >= 100).length,
  vwr100wr: trades.filter((t) => t.virtual_win_rate >= 100).length
    ? +(trades.filter((t) => t.virtual_win_rate >= 100 && t.won).length
      / trades.filter((t) => t.virtual_win_rate >= 100).length * 100).toFixed(1)
    : null,
  score100wr: trades.filter((t) => t.score >= 100).length
    ? +(trades.filter((t) => t.score >= 100 && t.won).length
      / trades.filter((t) => t.score >= 100).length * 100).toFixed(1)
    : null,
}, null, 2));
