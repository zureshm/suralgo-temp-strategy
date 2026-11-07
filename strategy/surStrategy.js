// =============================================================================
// surStrategy — SumeshStrategy copy + Sentiment Range MA (SRMA) filter
//
// Same signal engine as SumeshStrategy (normal candles):
//   - UT Bot (main): Key Value = 2, ATR Period = 10
//   - INFRAGREEN (UT Bot 2): Key Value = 0.8, ATR Period = 10 (re-entry trigger)
//   - 10EMA / 30EMA on close
//   - WMA30 / WMA60 on close
//   - SRMA (Sentiment Range MA [ChartPrime]) — faithful port of the frontend
//     implementation in suralgo-frontend/lib/strategy-chart.ts
//     (calculateSentimentRangeMA). Defaults: Length=20 (+1), Double Filter=ON,
//     Trigger Smoothing=4 (+1), ATR Length=200, Multiplier=6, Range=Body,
//     Color Style=MA Direction.
//
// BUY:     UT Bot flips bullish — ONLY when SRMA is not red.
//          (SRMA red/bear tone → BUY suppressed. Grey/green or not yet
//           warmed up → BUY allowed.)
// SELL:    UT Bot flips bearish (unchanged).
// REENTER: UT Bot already bullish AND INFRAGREEN flips bullish,
//          AND 10EMA already above 30EMA (upward cross has occurred),
//          AND 10EMA rising vs 5 candles ago,
//          AND WMA30 above WMA60 (already crossed upwards).
//          (unchanged — REENTER not gated by SRMA)
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
// Port of suralgo-frontend/lib/strategy-chart.ts calculateSentimentRangeMA.
// Stateful MA that re-anchors to source whenever the smoothed candle
// top/bottom escapes the ATR×multiplier bands, then smooths the anchor
// step-series with WMA (or WMA∘SMA "double filter").

function smaAt(arr, i, len) {
  // SMA ending at index i over arr[i-len+1..i]; NaN if any value missing/non-finite
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
  // WMA ending at index i; most recent weight = len, oldest = 1
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
    // ta.wma(ta.sma(src, len), len) — SMA first (tail-aligned), then WMA over it
    const sma = new Array(src.length).fill(NaN);
    for (let i = 0; i < src.length; i++) sma[i] = smaAt(src, i, len);
    for (let i = 0; i < src.length; i++) out[i] = wmaAt(sma, i, len);
  } else {
    for (let i = 0; i < src.length; i++) out[i] = wmaAt(src, i, len);
  }
  return out;
}

// Returns { ma, top, bottom, tone } parallel arrays (null where not finite).
// tone: "bull" | "bear" | "neutral" | null (MA Direction color style).
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

  // Stateful anchor pass — mirrors the Pine var-block:
  // flag uses PREVIOUS bar's top/bottom/current_range; on flag, re-anchor.
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
    // MA Direction color style: compare against previous smoothed value
    const prev = i > 0 ? smMa[i - 1] : NaN;
    const prevV = Number.isFinite(prev) ? prev : 0;
    const d = smMa[i] - prevV;
    tone[i] = d > 0 ? "bull" : d < 0 ? "bear" : "neutral";
  }

  return { ma, top, bottom, tone };
}

// ── Main strategy ────────────────────────────────────────────────────────────

// 10EMA rising lookback for REENTER (candles ago), same as DINKAN/TOMMAN
const REENTER_EMA_LOOKBACK = 5;

function surStrategy(candles) {
  if (!candles || candles.length < 20) {
    return { signal: "WAIT", reason: "Not enough data" };
  }

  const O = candles.map(c => Number(c.open));
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

  const srma = sentimentRangeMA(O, H, L, C); // SRMA, frontend defaults

  const i = N - 1;
  let signal = "WAIT";
  let reason = "No flip";

  const srmaRed = srma.tone[i] === "bear"; // SRMA red → no BUY

  if (bot.pos[i] === 1 && bot.pos[i - 1] !== 1) {
    if (srmaRed) {
      reason = "UT Bot flipped bullish but SRMA is red — BUY suppressed";
    } else {
      signal = "BUY";
      reason = "UT Bot flipped bullish";
    }
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
    srma: srma.ma[i],
    srmaTop: srma.top[i],
    srmaBottom: srma.bottom[i],
    srmaTone: srma.tone[i],
    close: C[i]
  };
}

module.exports = { surStrategy };
