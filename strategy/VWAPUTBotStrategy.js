// =============================================================================
// VWAPUTBotStrategy — EMA Crossover + MACD + ATR Sideways Filter (Heikin-Ashi)
//
// Based on chatGptStrategy logic, adapted to use Heikin-Ashi candles.
//
// INDICATORS & CONFIGURATION:
//   - EMA 10 and EMA 20 on Heikin-Ashi close (crossover detection)
//   - MACD (fast=6, slow=26, signal=9) on Heikin-Ashi close
//   - ATR(14) on Heikin-Ashi candles for sideways filter
//
// Candles are converted to Heikin-Ashi before all calculations.
//
// BUY:  EMA10 crosses above EMA20 AND MACD line > signal line
//       AND not sideways (14-candle range >= ATR*2)
//       AND current HA candle is green (close > open).
// SELL: EMA10 crosses below EMA20 AND MACD line < signal line
//       AND not sideways
//       AND current HA candle is red (close < open).
// =============================================================================

// ── Indicator helpers ────────────────────────────────────────────────────────

function trueRangeSeries(H, L, C) {
  const tr = [];
  for (let i = 0; i < C.length; i++) {
    if (i === 0) { tr.push(H[i] - L[i]); continue; }
    tr.push(Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])));
  }
  return tr;
}

function rmaSeries(src, period) {
  const out = new Array(src.length).fill(null);
  if (src.length < period) return out;
  let s = 0;
  for (let i = 0; i < period; i++) s += src[i];
  out[period - 1] = s / period;
  for (let i = period; i < src.length; i++) out[i] = (out[i - 1] * (period - 1) + src[i]) / period;
  return out;
}

function atrSeries(H, L, C, period) { return rmaSeries(trueRangeSeries(H, L, C), period); }

// ── EMA series ───────────────────────────────────────────────────────────────
function emaSeries(src, period) {
  const out = new Array(src.length).fill(null);
  if (src.length < period) return out;
  const k = 2 / (period + 1);
  let s = 0;
  for (let i = 0; i < period; i++) s += src[i];
  out[period - 1] = s / period;
  for (let i = period; i < src.length; i++) out[i] = src[i] * k + out[i - 1] * (1 - k);
  return out;
}

// ── MACD series (returns macdLine and signalLine arrays) ─────────────────────
function macdSeries(src, fastPeriod, slowPeriod, signalPeriod) {
  const emaFast = emaSeries(src, fastPeriod);
  const emaSlow = emaSeries(src, slowPeriod);
  const N = src.length;
  const macdLine = new Array(N).fill(null);
  for (let i = 0; i < N; i++) {
    if (emaFast[i] != null && emaSlow[i] != null) macdLine[i] = emaFast[i] - emaSlow[i];
  }
  // Signal line = EMA of MACD line (only non-null values)
  const macdValid = macdLine.filter(v => v != null);
  const signalRaw = emaSeries(macdValid, signalPeriod);
  const signalLine = new Array(N).fill(null);
  const offset = N - macdValid.length;
  for (let i = 0; i < macdValid.length; i++) {
    signalLine[offset + i] = signalRaw[i];
  }
  return { macdLine, signalLine };
}

// ── Main strategy ─────────────────────────────────────────────────────────────

function VWAPUTBotStrategy(candles) {
  if (!candles || candles.length < 50) {
    return { signal: "WAIT", reason: "Not enough data (need 50+)" };
  }

  // ── Convert to Heikin-Ashi ──
  const ha = [];
  for (let i = 0; i < candles.length; i++) {
    const o = Number(candles[i].open);
    const h = Number(candles[i].high);
    const l = Number(candles[i].low);
    const c = Number(candles[i].close);
    const haClose = (o + h + l + c) / 4;
    const haOpen  = i === 0 ? (o + c) / 2 : (ha[i - 1].open + ha[i - 1].close) / 2;
    const haHigh  = Math.max(h, haOpen, haClose);
    const haLow   = Math.min(l, haOpen, haClose);
    ha.push({ open: haOpen, high: haHigh, low: haLow, close: haClose });
  }

  const H = ha.map(c => c.high);
  const L = ha.map(c => c.low);
  const C = ha.map(c => c.close);
  const O = ha.map(c => c.open);
  const N = C.length;

  // Indicators
  const ema10 = emaSeries(C, 10);
  const ema20 = emaSeries(C, 20);
  const { macdLine, signalLine } = macdSeries(C, 6, 26, 9);
  const atr14 = atrSeries(H, L, C, 14);

  let lastSignal = "WAIT", lastReason = "No signal";

  for (let i = 1; i < N; i++) {
    const e10_prev = ema10[i - 1];
    const e10_now  = ema10[i];
    const e20_prev = ema20[i - 1];
    const e20_now  = ema20[i];
    const macd_now = macdLine[i];
    const signal_now = signalLine[i];
    const atr_now = atr14[i];

    if (e10_prev == null || e10_now == null || e20_prev == null || e20_now == null) continue;
    if (macd_now == null || signal_now == null) continue;

    // Sideways filter: 14-candle range vs ATR*2
    let sideways = false;
    if (atr_now != null && i >= 13) {
      let recentHigh = -Infinity, recentLow = Infinity;
      for (let j = i - 13; j <= i; j++) {
        if (H[j] > recentHigh) recentHigh = H[j];
        if (L[j] < recentLow) recentLow = L[j];
      }
      const range = recentHigh - recentLow;
      sideways = range < atr_now * 2;
    }

    const isGreen = C[i] > O[i];
    const isRed   = C[i] < O[i];

    let sig = "WAIT", reason = "No signal";

    // ── BUY: EMA10 crosses above EMA20 + MACD bullish + not sideways + green HA candle ──
    if (e10_prev <= e20_prev && e10_now > e20_now && macd_now > signal_now && !sideways && isGreen) {
      sig = "BUY";
      reason = "EMA10 crossed above EMA20 + MACD bullish + not sideways + green HA candle";
    }
    // ── SELL: EMA10 crosses below EMA20 + MACD bearish + not sideways + red HA candle ──
    else if (e10_prev >= e20_prev && e10_now < e20_now && macd_now < signal_now && !sideways && isRed) {
      sig = "SELL";
      reason = "EMA10 crossed below EMA20 + MACD bearish + not sideways + red HA candle";
    }

    lastSignal = sig;
    lastReason = reason;
  }

  return {
    signal: lastSignal,
    reason: lastReason,
    ema10: ema10[N - 1],
    ema20: ema20[N - 1],
    macd: macdLine[N - 1],
    macdSignal: signalLine[N - 1],
    atr: atr14[N - 1],
    close: C[N - 1]
  };
}

module.exports = { VWAPUTBotStrategy };
