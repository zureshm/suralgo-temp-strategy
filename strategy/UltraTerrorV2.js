// =============================================================================
// ultraTerrorV2 (copy of UTGPTStrategy2) — Sumesh UT Bot on Heikin-Ashi candles
//
// Same signal engine as SumeshStrategy. GREEN is computed on NORMAL candles,
// while INFRAGREEN and all EMA/WMA gates are on Heikin-Ashi candles.
// Standalone — no imports.
//
// INDICATORS & CONFIGURATION:
//   - GREEN (UT Bot 1): Key Value = 2, ATR Period = 10 (on NORMAL candles)
//   - PALEGREEN (UT Bot): Key Value = 1.5, ATR Period = 10 (on NORMAL candles)
//   - INFRAGREEN (UT Bot 2): Key Value = 0.8, ATR Period = 10 (on HA candles)
//   - 10EMA / 30EMA on HA close
//   - WMA30 / WMA60 on HA close
//   - VWAP on normal candles (typical price, resets daily)
//   - Candles are converted to Heikin-Ashi for INFRAGREEN + EMA/WMA gates
//
// BUY (CYAN): CYAN (UT Bot, Key=2, ATR=200, HA candles) flips bullish,
//          only for candles between 9:15 and 10:00, AND only while 10EMA > 30EMA (HA).
// BUY:     GREEN flips bullish (on normal candles).
// SELL:    GREEN flips bearish.
// BUY (PALEGREEN): PALEGREEN bullish flip with price above VWAP,
//          10EMA>30EMA, 10EMA rising vs 3 candles ago, WMA30>WMA60,
//          WMA30 below 10EMA, candle fully above WMA30 (neither wick nor body touching it).
// BUY (INFRAGREEN): GREEN already bullish AND INFRAGREEN flips bullish,
//          AND price (normal close) above VWAP,
//          AND 10EMA already above 30EMA (upward cross has occurred),
//          AND 10EMA rising vs 5 candles ago,
//          AND WMA30 above WMA60 (already crossed upwards),
//          AND WMA30 below 10EMA,
//          AND candle fully above WMA30 (neither wick nor body touching it).
// BUY (INFRAEXTRA): same full INFRAGREEN condition set, but without needing
//          the fresh UT Bot flip — the combined set itself is the trigger.
//          Fires ONCE per eligible phase on the exact candle where the set
//          transitions false→true, provided the firing candle is non-RED on
//          the NORMAL candle (close >= open; HA can paint green while the
//          real bar closed red). A red candle breaks eligibility, re-arming.
//
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

// ── VWAP (typical price, resets each day) ────────────────────────────────────
function vwapSeries(candles) {
  const out = new Array(candles.length).fill(null);
  let cumPV = 0, cumV = 0, day = null;
  for (let i = 0; i < candles.length; i++) {
    const d = candles[i].time != null ? String(candles[i].time).slice(0, 10) : null;
    if (d !== day) { day = d; cumPV = 0; cumV = 0; }
    const tp = (Number(candles[i].high) + Number(candles[i].low) + Number(candles[i].close)) / 3;
    const v = Number(candles[i].volume) || 0;
    cumPV += tp * v;
    cumV += v;
    out[i] = cumV > 0 ? cumPV / cumV : tp;
  }
  return out;
}

// CYAN BUY is only allowed for candles stamped 09:15 through 10:00 (inclusive)
function inCyanWindow(time) {
  const m = /[ T](\d{2}):(\d{2})/.exec(String(time));
  if (!m) return false;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins >= 9 * 60 + 15 && mins <= 10 * 60;
}

// ── Main strategy ────────────────────────────────────────────────────────────

// 10EMA rising lookback for REENTER (candles ago), same as DINKAN/TOMMAN
const REENTER_EMA_LOOKBACK = 5;
const PALEGREEN_EMA_LOOKBACK = 3;
const INFRAEXTRA_SAMPLE_EVERY = 5; // check the loose INFRAEXTRA set every 5 candles

// Full INFRAGREEN eligibility at bar k (state check — no flip required):
// GREEN bull, INFRAGREEN bull, close>VWAP, 10EMA>30EMA, 10EMA rising vs 5,
// WMA30>WMA60, WMA30<10EMA, HA candle low clear of WMA30.
function infraEligible(k, green, infraGreen, nC, vwap, ema10, ema30, wma30, wma60, ha) {
  if (k < REENTER_EMA_LOOKBACK) return false;
  if (green.pos[k] !== 1 || infraGreen.pos[k] !== 1) return false;
  if (!(vwap[k] != null && nC[k] > vwap[k])) return false;
  if (!(ema10[k] != null && ema30[k] != null && ema10[k] > ema30[k])) return false;
  if (!(ema10[k] != null && ema10[k - REENTER_EMA_LOOKBACK] != null
      && ema10[k] > ema10[k - REENTER_EMA_LOOKBACK])) return false;
  if (!(wma30[k] != null && wma60[k] != null && wma30[k] > wma60[k])) return false;
  if (!(wma30[k] != null && ema10[k] != null && wma30[k] < ema10[k])) return false;
  if (!(wma30[k] != null && ha[k].low > wma30[k])) return false;
  return true;
}

function ultraTerrorV2(candles) {
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
  const N = C.length;

  // GREEN & PALEGREEN on normal candles; INFRAGREEN on Heikin-Ashi
  const nO = candles.map(c => Number(c.open));
  const nH = candles.map(c => Number(c.high));
  const nL = candles.map(c => Number(c.low));
  const nC = candles.map(c => Number(c.close));

  const green = utBotSeries(nH, nL, nC, 2, 10);       // GREEN on normal candles (Key=2, ATR=10)
  const palegreen = utBotSeries(nH, nL, nC, 1.5, 10); // PALEGREEN on normal candles (Key=1.5, ATR=10)
  const infraGreen = utBotSeries(H, L, C, 0.8, 10);   // INFRAGREEN on HA (Key=0.8, ATR=10)

  const cyan = utBotSeries(H, L, C, 2, 200);       // CYAN on HA (Key=2, ATR=200)

  const ema10 = emaSeries(C, 10); // 10EMA on HA close
  const ema30 = emaSeries(C, 30); // 30EMA on HA close

  const wma30 = wmaSeries(C, 30); // WMA30 on HA close
  const wma60 = wmaSeries(C, 60); // WMA60 on HA close

  const vwap = vwapSeries(candles); // VWAP on normal candles, resets daily

  const i = N - 1;
  let signal = "WAIT";
  let reason = "No flip";

  if (green.pos[i] === 1 && green.pos[i - 1] !== 1) {
    signal = "BUY";
    reason = "GREEN flipped bullish (normal candles)";
  } else if (green.pos[i] === -1 && green.pos[i - 1] !== -1) {
    signal = "SELL";
    reason = "GREEN flipped bearish (normal candles)";
  } else if (cyan.pos[i] === 1 && cyan.pos[i - 1] !== 1 && inCyanWindow(candles[i].time) && ema10[i] != null && ema30[i] != null && ema10[i] > ema30[i]) {
    signal = "BUY";
    reason = "CYAN flipped bullish (K2/ATR200, Heikin-Ashi) within 9:15-10:00 while 10EMA>30EMA";
  } else {
    // ── REENTER & Extra BUY gates ──
    const paleGreenFlipBuy = palegreen.pos[i] === 1 && palegreen.pos[i - 1] !== 1;
    const infraGreenFlipBuy = infraGreen.pos[i] === 1 && infraGreen.pos[i - 1] !== 1;
    const emaCrossedUp = ema10[i] != null && ema30[i] != null && ema10[i] > ema30[i];
    const ema10Rising = i >= REENTER_EMA_LOOKBACK
      && ema10[i] != null && ema10[i - REENTER_EMA_LOOKBACK] != null
      && ema10[i] > ema10[i - REENTER_EMA_LOOKBACK];
    const ema10Rising3 = i >= PALEGREEN_EMA_LOOKBACK
      && ema10[i] != null && ema10[i - PALEGREEN_EMA_LOOKBACK] != null
      && ema10[i] > ema10[i - PALEGREEN_EMA_LOOKBACK];
    const wmaCrossedUp = wma30[i] != null && wma60[i] != null && wma30[i] > wma60[i];
    const priceAboveVwap = vwap[i] != null && nC[i] > vwap[i]; // normal close above VWAP

    // ── Extra gates (WMA30<10EMA + no WMA30 touch) ──
    const wma30UnderEma10 = wma30[i] != null && ema10[i] != null && wma30[i] < ema10[i];
    const clearOfWma30 = wma30[i] != null && ha[i].low > wma30[i]; // wick+body fully above WMA30

    if (paleGreenFlipBuy && priceAboveVwap && emaCrossedUp && wmaCrossedUp && ema10Rising3 && wma30UnderEma10 && clearOfWma30) {
      signal = "BUY";
      reason = "PALEGREEN flip bullish above VWAP (K1.5/ATR10, normal candles) → BUY, 10EMA>30EMA rising, WMA30<10EMA, candle clear of WMA30 (HA)";
    } else if (green.pos[i] === 1 && infraGreenFlipBuy && priceAboveVwap && emaCrossedUp && wmaCrossedUp
        && ema10Rising && wma30UnderEma10 && clearOfWma30) {
      signal = "BUY";
      reason = "INFRAGREEN flip bullish above VWAP (K0.8/ATR10) → BUY while GREEN bullish, 10EMA>30EMA rising, WMA30<10EMA, candle clear of WMA30 (HA)";
    } else {
      // ── INFRAEXTRA: loose INFRAGREEN BUY, sampled every 5 candles ──
      // No fresh flip needed — the full INFRAGREEN condition set holding is
      // enough. Fires on EVERY sampled candle where the set holds, but the
      // firing candle itself must be non-RED on the NORMAL candle
      // (HA candles can paint green even when the real bar closed red).
      const onSample = i % INFRAEXTRA_SAMPLE_EVERY === 0;
      const notRed = nC[i] >= nO[i]; // normal candle close not below its open
      const eligibleNow = onSample && notRed
        && infraEligible(i, green, infraGreen, nC, vwap, ema10, ema30, wma30, wma60, ha);
      if (eligibleNow) {
        signal = "BUY";
        reason = "(INFRAEXTRA) loose INFRAGREEN set holds on 5-candle sample, normal candle not red — GREEN bull, K0.8/ATR10 bull, close>VWAP, 10EMA>30EMA rising, WMA30>WMA60, WMA30<10EMA, candle clear of WMA30 (HA)";
      }
    }
  }

  return {
    signal,
    reason,
    greenPos: green.pos[i],
    greenTrail: green.trail[i],
    palegreenPos: palegreen.pos[i],
    palegreenTrail: palegreen.trail[i],
    cyanPos: cyan.pos[i],
    cyanTrail: cyan.trail[i],
    infraGreenPos: infraGreen.pos[i],
    infraGreenTrail: infraGreen.trail[i],
    vwap: vwap[i],
    ema10: ema10[i],
    ema30: ema30[i],
    wma30: wma30[i],
    wma60: wma60[i],
    close: C[i]
  };
}

module.exports = { ultraTerrorV2 };
