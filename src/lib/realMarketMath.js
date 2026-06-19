/**
 * Real Market Algorithmic Trading Math Utilities
 */

export function EMA(values, period) {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

export function Wilder_EMA(values, period) {
  if (values.length === 0) return 0;
  if (values.length < period) return values[values.length - 1]; // Fallback
  
  const k = 1 / period;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let ema = sum / period;
  
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

// highs, lows, closes are arrays of same length
export function ATR(highs, lows, closes, period = 14) {
  if (closes.length < 2) return 0;
  const TR = [highs[0] - lows[0]];
  for (let i = 1; i < closes.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    TR.push(Math.max(hl, hc, lc));
  }
  return Wilder_EMA(TR, period);
}

export function BollingerBands(closes, period = 20, multiplier = 3) {
  if (closes.length < period) return { upper: 0, lower: 0, middle: 0 };
  const slice = closes.slice(-period);
  const sum = slice.reduce((a, b) => a + b, 0);
  const middle = sum / period;
  const variance = slice.reduce((s, v) => s + Math.pow(v - middle, 2), 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: middle + multiplier * std,
    lower: middle - multiplier * std,
    middle
  };
}

export function EfficiencyRatio(prices, n = 100) {
  if (prices.length <= n) return 0;
  const direction = Math.abs(prices[prices.length - 1] - prices[prices.length - 1 - n]);
  let noise = 0;
  for (let i = prices.length - n; i < prices.length; i++) {
    noise += Math.abs(prices[i] - prices[i - 1]);
  }
  if (noise === 0 || noise < 1e-10) return 0;
  return direction / noise;
}

export function VelocityAcceleration(ticks) {
  // ticks = [{price, epoch}, ...]
  if (ticks.length < 7) return 0;
  const velocities = ticks.map((t, i) => {
    if (i === 0) return 0;
    const dt = t.epoch - ticks[i - 1].epoch;
    if (dt === 0) return 0; // Prevent div by 0
    return Math.abs(t.price - ticks[i - 1].price) / dt;
  });
  
  const v_smooth = EMA(velocities.slice(-5), 5);
  const v_prev = EMA(velocities.slice(-6, -1), 5);
  return v_smooth - v_prev;
}

export function TickIntensityIndex(ticks) {
  if (ticks.length < 1200) return 0; // need enough ticks
  const recent5 = ticks.slice(-300); // roughly 5 mins
  const hist20 = ticks.slice(-1200); // roughly 20 mins
  
  const avgSize = (arr) => {
    let sum = 0;
    for(let i=1; i<arr.length; i++) {
      sum += Math.abs(arr[i].price - arr[i-1].price);
    }
    return arr.length > 1 ? sum / (arr.length - 1) : 0;
  };
  
  const s5 = avgSize(recent5);
  const s20 = avgSize(hist20);
  if (hist20.length === 0 || s20 === 0) return 0;
  
  return (recent5.length * s5) / (hist20.length * s20);
}

// Math logic complete.
