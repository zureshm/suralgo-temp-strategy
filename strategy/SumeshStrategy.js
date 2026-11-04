// =============================================================================
// SumeshStrategy — Single UT Bot with INFRAGREEN Re-entry (normal candles)
//
// INDICATORS & CONFIGURATION:
//   - UT Bot (main): Key Value = 2, ATR Period = 10
//   - INFRAGREEN (UT Bot 2): Key Value = 0.8, ATR Period = 10 (re-entry trigger)
//   - 10EMA / 30EMA on close
//   - WMA30 / WMA60 on close
//   - Normal candles (no Heikin-Ashi)
//
// BUY:     UT Bot flips bullish.
// SELL:    UT Bot flips bearish.
// REENTER: UT Bot already bullish AND INFRAGREEN flips bullish,
//          AND 10EMA already above 30EMA (upward cross has occurred),
//          AND 10EMA rising vs 5 candles ago,
//          AND WMA30 above WMA60 (already crossed upwards).
//          (BUY/SELL logic untouched — REENTER is an additional signal only.)
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

// ── EMA (Exponential Moving Average) ─────────────────────────────────────────
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

// ── WMA (Weighted Moving Average) ────────────────────────────────────────────
function wmaSeries(src, period) {
  const out = new Array(src.length).fill(null);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < src.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += src[i - j] * (period - j);
    out[i] = sum / denom;
  }
  return out;
}

// ── Standard UT Bot (fixed key) ─────────────────────────────────────────────
function utBotSeries(H, L, C, keyValue, atrPeriod) {
  const N = C.length;
  const atr = atrSeries(H, L, C, atrPeriod);
  const posArr = new Array(N).fill(0);
  const tsArr = new Array(N).fill(null);

  let ts = 0, pos = 0;
  for (let i = 1; i < N; i++) {
    if (atr[i] == null) { posArr[i] = pos; tsArr[i] = ts; continue; }
    const nLoss = keyValue * atr[i];
    const prevTS = ts;

    if (C[i] > prevTS && C[i - 1] > prevTS) {
      ts = Math.max(prevTS, C[i] - nLoss);
    } else if (C[i] < prevTS && C[i - 1] < prevTS) {
      ts = Math.min(prevTS, C[i] + nLoss);
    } else if (C[i] > prevTS) {
      ts = C[i] - nLoss;
    } else {
      ts = C[i] + nLoss;
    }

    if (C[i - 1] < prevTS && C[i] > prevTS) pos = 1;
    else if (C[i - 1] > prevTS && C[i] < prevTS) pos = -1;

    posArr[i] = pos;
    tsArr[i] = ts;
  }

  return { pos: posArr, trail: tsArr };
}

// ── Main strategy ────────────────────────────────────────────────────────────

// 10EMA rising lookback for REENTER (candles ago), same as DINKAN/TOMMAN
const REENTER_EMA_LOOKBACK = 5;

function sumeshStrategy(candles) {
  if (!candles || candles.length < 20) {
    return { signal: "WAIT", reason: "Not enough data" };
  }

  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));
  const N = C.length;

  const bot = utBotSeries(H, L, C, 2, 10);          // main UT Bot (Key=2, ATR=10)
  const infraGreen = utBotSeries(H, L, C, 0.8, 10); // INFRAGREEN (Key=0.8, ATR=10)

  const ema10 = emaSeries(C, 10); // 10EMA on close
  const ema30 = emaSeries(C, 30); // 30EMA on close

  const wma30 = wmaSeries(C, 30); // WMA30 on close
  const wma60 = wmaSeries(C, 60); // WMA60 on close

  const i = N - 1;
  let signal = "WAIT";
  let reason = "No flip";

  if (bot.pos[i] === 1 && bot.pos[i - 1] !== 1) {
    signal = "BUY";
    reason = "UT Bot flipped bullish";
  } else if (bot.pos[i] === -1 && bot.pos[i - 1] !== -1) {
    signal = "SELL";
    reason = "UT Bot flipped bearish";
  } else {
    // ── REENTER gates ──
    const infraGreenFlipBuy = infraGreen.pos[i] === 1 && infraGreen.pos[i - 1] !== 1;
    const emaCrossedUp = ema10[i] != null && ema30[i] != null && ema10[i] > ema30[i];
    const ema10Rising = i >= REENTER_EMA_LOOKBACK
      && ema10[i] != null && ema10[i - REENTER_EMA_LOOKBACK] != null
      && ema10[i] > ema10[i - REENTER_EMA_LOOKBACK];
    const wmaCrossedUp = wma30[i] != null && wma60[i] != null && wma30[i] > wma60[i];

    if (bot.pos[i] === 1 && infraGreenFlipBuy && emaCrossedUp && ema10Rising && wmaCrossedUp) {
      signal = "REENTER";
      reason = "INFRAGREEN flip bullish (K0.8/ATR10) while UT Bot bullish, 10EMA>30EMA rising, WMA30>WMA60";
    }
  }

  return {
    signal,
    reason,
    botPos: bot.pos[i],
    botTrail: bot.trail[i],
    infraGreenPos: infraGreen.pos[i],
    ema10: ema10[i],
    ema30: ema30[i],
    wma30: wma30[i],
    wma60: wma60[i],
    close: C[i]
  };
}

module.exports = { sumeshStrategy };
