// =============================================================================
// claudSurStrategy (copy of utGptStrategy2) — Sumesh UT Bot on Heikin-Ashi candles
//
// Same signal engine as SumeshStrategy. GREEN is computed on NORMAL candles,
// while INFRAGREEN and all EMA/WMA gates are on Heikin-Ashi candles.
//
// INDICATORS & CONFIGURATION:
//   - GREEN (UT Bot 1): Key Value = 2, ATR Period = 10 (on NORMAL candles)
//   - PALEGREEN (UT Bot): Key Value = 1.5, ATR Period = 10 (on NORMAL candles)
//   - INFRAGREEN (UT Bot 2): Key Value = 0.8, ATR Period = 10 (on HA candles)
//   - 10EMA / 30EMA on HA close
//   - WMA30 / WMA60 on HA close
//   - SRMA (Sentiment Range MA, ChartPrime defaults) on normal candles —
//     replaces the VWAP gate for buy-side signals
//   - Candles are converted to Heikin-Ashi for INFRAGREEN + EMA/WMA gates
//
// BUY (CYAN): CYAN (UT Bot, Key=2, ATR=200, HA candles) flips bullish,
//          only for candles between 9:15 and 10:00, AND only while 10EMA > 30EMA (HA).
// SELL:    GREEN flips bearish.
// BUY (PALEGREEN): PALEGREEN bullish flip with price above SRMA,
//          10EMA>30EMA, 10EMA rising vs 3 candles ago, WMA30>WMA60,
//          WMA30 below 10EMA, candle fully above WMA30 (neither wick nor body touching it).
// BUY (INFRAGREEN): GREEN already bullish AND INFRAGREEN flips bullish,
//          AND price (normal close) above SRMA,
//          AND 10EMA already above 30EMA (upward cross has occurred),
//          AND 10EMA rising vs 5 candles ago,
//          AND WMA30 above WMA60 (already crossed upwards),
//          AND WMA30 below 10EMA,
//          AND candle fully above WMA30 (neither wick nor body touching it).
// REENTER: GREEN already bullish AND INFRAGREEN flips bullish,
//          AND price (normal close) above SRMA,
//          AND 10EMA already above 30EMA (upward cross has occurred),
//          AND 10EMA rising vs 5 candles ago,
//          AND WMA30 above WMA60 (already crossed upwards),
//          AND WMA30 below 10EMA,
//          AND candle fully above WMA30 (neither wick nor body touching it).
//          (BUY/SELL logic untouched — REENTER is an additional signal only.)
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

// ── Sentiment Range MA [ChartPrime] ──────────────────────────────────────────
// Port of surStrategy.js — stateful MA that re-anchors to source whenever the
// smoothed candle top/bottom escapes the ATR×multiplier bands, then smooths
// the anchor step-series with WMA∘SMA ("double filter").

function smaAt(arr, i, len) {
  if (i < len - 1) return NaN;
  let sum = 0;
  for (let j = i - len + 1; j <= i; j++) {
    const v = arr[j];
    if (!Number.isFinite(v)) return NaN;
    sum += v;
  }
  return sum / len;
}

function wmaAt(arr, i, len) {
  if (i < len - 1) return NaN;
  const denom = (len * (len + 1)) / 2;
  let sum = 0;
  for (let j = 0; j < len; j++) {
    const v = arr[i - j];
    if (!Number.isFinite(v)) return NaN;
    sum += v * (len - j);
  }
  return sum / denom;
}

function smoothSeries(src, len, doubleFilter) {
  const out = new Array(src.length).fill(NaN);
  if (doubleFilter) {
    const sma = new Array(src.length).fill(NaN);
    for (let i = 0; i < src.length; i++) sma[i] = smaAt(src, i, len);
    for (let i = 0; i < src.length; i++) out[i] = wmaAt(sma, i, len);
  } else {
    for (let i = 0; i < src.length; i++) out[i] = wmaAt(src, i, len);
  }
  return out;
}

function sentimentRangeMA(O, H, L, C, opts = {}) {
  const outLen = Math.max(1, (opts.length ?? 20) + 1);
  const doubleFilter = opts.doubleFilter ?? true;
  const trigLen = Math.max(1, (opts.triggerSmoothing ?? 4) + 1);
  const atrLen = Math.max(1, Math.floor(opts.atrLength ?? 200));
  const mult = opts.multiplier ?? 6;
  const wick = opts.rangeStyle === "wick";

  const n = C.length;
  const ma = new Array(n).fill(null);
  const top = new Array(n).fill(null);
  const bottom = new Array(n).fill(null);
  const tone = new Array(n).fill(null);
  if (n === 0 || !Number.isFinite(mult)) return { ma, top, bottom, tone };

  const candleTop = new Array(n);
  const candleBottom = new Array(n);
  const smoothTop = new Array(n).fill(NaN);
  const smoothBottom = new Array(n).fill(NaN);
  const atr = new Array(n).fill(NaN);
  const tr = new Array(n);

  for (let i = 0; i < n; i++) {
    const t = wick ? H[i] : Math.max(O[i], C[i]);
    const b = wick ? L[i] : Math.min(O[i], C[i]);
    candleTop[i] = t;
    candleBottom[i] = b;
    tr[i] = t - b;
  }
  for (let i = trigLen - 1; i < n; i++) {
    smoothTop[i] = smaAt(candleTop, i, trigLen);
    smoothBottom[i] = smaAt(candleBottom, i, trigLen);
  }
  for (let i = atrLen - 1; i < n; i++) atr[i] = smaAt(tr, i, atrLen);

  const rawMa = new Array(n).fill(NaN);
  const rawTop = new Array(n).fill(NaN);
  const rawBottom = new Array(n).fill(NaN);
  let curRange = NaN;
  let topRange = NaN;
  let bottomRange = NaN;

  for (let i = 0; i < n; i++) {
    const st = smoothTop[i];
    const sb = smoothBottom[i];
    const flag =
      !Number.isFinite(curRange) ||
      (Number.isFinite(st) && st > topRange) ||
      (Number.isFinite(sb) && sb < bottomRange);
    if (flag) {
      const src = C[i];
      rawMa[i] = src;
      const a = atr[i];
      curRange = Number.isFinite(a) ? a * mult : NaN;
      topRange = Number.isFinite(curRange) ? src + curRange : NaN;
      bottomRange = Number.isFinite(curRange) ? src - curRange : NaN;
    } else {
      rawMa[i] = i > 0 ? rawMa[i - 1] : NaN;
    }
    rawTop[i] = topRange;
    rawBottom[i] = bottomRange;
  }

  const smMa = smoothSeries(rawMa, outLen, doubleFilter);
  const smTop = smoothSeries(rawTop, outLen, doubleFilter);
  const smBottom = smoothSeries(rawBottom, outLen, doubleFilter);

  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(smMa[i]) || !Number.isFinite(smTop[i]) || !Number.isFinite(smBottom[i])) continue;
    ma[i] = smMa[i];
    top[i] = smTop[i];
    bottom[i] = smBottom[i];
    const prev = i > 0 ? smMa[i - 1] : NaN;
    const prevV = Number.isFinite(prev) ? prev : 0;
    const d = smMa[i] - prevV;
    tone[i] = d > 0 ? "bull" : d < 0 ? "bear" : "neutral";
  }

  return { ma, top, bottom, tone };
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

function claudSurStrategy(candles) {
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

  const srma = sentimentRangeMA(nO, nH, nL, nC); // SRMA on normal candles (frontend defaults)

  const i = N - 1;
  let signal = "WAIT";
  let reason = "No flip";

  if (green.pos[i] === -1 && green.pos[i - 1] !== -1) {
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
    const closeAboveSrma = srma.ma[i] != null && nC[i] > srma.ma[i]; // normal close above SRMA

    // ── Extra gates (WMA30<10EMA + no WMA30 touch) ──
    const wma30UnderEma10 = wma30[i] != null && ema10[i] != null && wma30[i] < ema10[i];
    const clearOfWma30 = wma30[i] != null && ha[i].low > wma30[i]; // wick+body fully above WMA30

    if (paleGreenFlipBuy && closeAboveSrma && emaCrossedUp && wmaCrossedUp && ema10Rising3 && wma30UnderEma10 && clearOfWma30) {
      signal = "BUY";
      reason = "PALEGREEN flip bullish above SRMA (K1.5/ATR10, normal candles) → BUY, 10EMA>30EMA rising, WMA30<10EMA, candle clear of WMA30 (HA)";
    } else if (green.pos[i] === 1 && infraGreenFlipBuy && closeAboveSrma && emaCrossedUp && wmaCrossedUp) {
      if (ema10Rising && wma30UnderEma10 && clearOfWma30) {
        signal = "BUY";
        reason = "INFRAGREEN flip bullish above SRMA (K0.8/ATR10) → BUY while GREEN bullish, 10EMA>30EMA rising, WMA30<10EMA, candle clear of WMA30 (HA)";
      } else if (ema10Rising && wma30UnderEma10 && clearOfWma30) {
        signal = "REENTER";
        reason = "INFRAGREEN flip bullish above SRMA (K0.8/ATR10) while GREEN bullish, 10EMA>30EMA rising, WMA30>WMA60, WMA30<10EMA, candle clear of WMA30 (HA)";
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
    srma: srma.ma[i],
    ema10: ema10[i],
    ema30: ema30[i],
    wma30: wma30[i],
    wma60: wma60[i],
    close: C[i]
  };
}

module.exports = { claudSurStrategy, utGptStrategy2: claudSurStrategy };
