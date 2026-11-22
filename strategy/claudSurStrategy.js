// =============================================================================
// claudSurStrategy — HYBRID: PatternBreakout entries + indicator re-entries
//
// BUY comes from PatternBreakout's pattern engine (imported below):
//   - ORB: first close above the 09:15–09:29 range high (once/day, ≤11:30,
//     range ≤8%), stop = range low.
//   - Cup & handle: rolling detector on NORMAL candles, fresh close above
//     the rim, stop = handle low.
//   - MAX_TRADES_PER_DAY = 3, no new entries after 15:00.
//
// REENTER comes from this file's original BUY-condition flips, demoted to
// re-entry signals and armed ONLY after the day's first pattern BUY:
//   - PALEGREEN (K1.5/ATR10, normal) flips bullish +
//     10EMA>30EMA + WMA30>WMA60 + 10EMA rising(3) + WMA30<10EMA +
//     candle fully above WMA30.
//   - INFRAGREEN (K0.8/ATR10, HA) flips bullish while GREEN bullish +
//     10EMA>30EMA + WMA30>WMA60 + 10EMA rising(5) +
//     WMA30<10EMA + candle fully above WMA30.
//   REENTER never touches inTrade — it is a signal for the execution layer.
//
// SELL is pattern-side only: close below the pattern stop, or EOD
// square-off at 15:20. (The old GREEN-flip SELL is gone.)
//
// INDICATORS & CONFIGURATION (unchanged):
//   - GREEN (UT Bot 1): Key Value = 2, ATR Period = 10 (on NORMAL candles)
//   - PALEGREEN (UT Bot): Key Value = 1.5, ATR Period = 10 (on NORMAL candles)
//   - INFRAGREEN (UT Bot 2): Key Value = 0.8, ATR Period = 10 (on HA candles)
//   - CYAN (UT Bot): Key Value = 2, ATR Period = 200 (on HA candles)
//   - 10EMA / 30EMA, WMA30 / WMA60 on HA close
//   - SRMA (Sentiment Range MA, ChartPrime defaults) on normal candles
// =============================================================================

const {
  findCupBreakout,
  timeToMinutes,
  ORB_START_MIN,
  ORB_END_MIN,
  ORB_ENTRY_CUTOFF,
  ORB_MAX_RANGE_PCT
} = require("./PatternBreakout");

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

// ── Main strategy — hybrid ───────────────────────────────────────────────────
// BUY:    PatternBreakout's pattern engine (ORB + cup & handle)
// REENTER: this file's old BUY-condition flips (CYAN/PALEGREEN/INFRAGREEN),
//          armed only after the day's first pattern BUY
// SELL:   pattern stop or 15:20 EOD only

const NO_ENTRY_AFTER = 15 * 60;      // no new entries after 15:00
const EOD_EXIT_MIN = 15 * 60 + 20;   // square-off 15:20
const MAX_TRADES_PER_DAY = 3;
const REENTER_EMA_LOOKBACK = 5;
const PALEGREEN_EMA_LOOKBACK = 3;

function claudSurStrategy(candles) {
  if (!candles || candles.length < 20) {
    return { signal: "WAIT", reason: "Not enough data (need 20+)" };
  }

  const N = candles.length;
  const nO = candles.map(c => Number(c.open));
  const nH = candles.map(c => Number(c.high));
  const nL = candles.map(c => Number(c.low));
  const nC = candles.map(c => Number(c.close));

  // ── Heikin-Ashi series (INFRAGREEN + EMA/WMA gates) ──
  const ha = [];
  for (let i = 0; i < N; i++) {
    const haClose = (nO[i] + nH[i] + nL[i] + nC[i]) / 4;
    const haOpen  = i === 0 ? (nO[i] + nC[i]) / 2 : (ha[i - 1].open + ha[i - 1].close) / 2;
    ha.push({
      open: haOpen,
      high: Math.max(nH[i], haOpen, haClose),
      low:  Math.min(nL[i], haOpen, haClose),
      close: haClose
    });
  }
  const H = ha.map(c => c.high);
  const L = ha.map(c => c.low);
  const C = ha.map(c => c.close);

  // Indicator series — GREEN & PALEGREEN on normal candles; INFRAGREEN & CYAN on HA
  const green = utBotSeries(nH, nL, nC, 2, 10);       // GREEN (Key=2, ATR=10)
  const palegreen = utBotSeries(nH, nL, nC, 1.5, 10); // PALEGREEN (Key=1.5, ATR=10)
  const infraGreen = utBotSeries(H, L, C, 0.8, 10);   // INFRAGREEN (Key=0.8, ATR=10)
  const cyan = utBotSeries(H, L, C, 2, 200);          // CYAN (Key=2, ATR=200)

  const ema10 = emaSeries(C, 10);
  const ema30 = emaSeries(C, 30);
  const wma30 = wmaSeries(C, 30);
  const wma60 = wmaSeries(C, 60);
  const srma = sentimentRangeMA(nO, nH, nL, nC);

  // ── Pattern state (PatternBreakout's model — replay the whole array) ──
  let day = null;
  let orbHigh = null, orbLow = null, orbSealed = false, orbTraded = false;
  let inTrade = false, stop = null, tradesToday = 0;
  let lastRim = null;
  let signal = "WAIT", reason = "No pattern";

  for (let i = 1; i < N; i++) {
    const t = candles[i].time;
    const d = t != null ? String(t).slice(0, 10) : null;
    const mins = timeToMinutes(t);

    if (d !== day) {
      day = d;
      orbHigh = orbLow = null; orbSealed = false; orbTraded = false;
      inTrade = false; stop = null; tradesToday = 0;
    }

    // ── Build the opening range (normal candles) ──
    if (!orbSealed && mins != null) {
      if (mins >= ORB_START_MIN && mins < ORB_END_MIN) {
        orbHigh = orbHigh == null ? nH[i] : Math.max(orbHigh, nH[i]);
        orbLow  = orbLow  == null ? nL[i] : Math.min(orbLow,  nL[i]);
      } else if (mins >= ORB_END_MIN) {
        orbSealed = true;
        if (orbHigh == null || orbLow == null || orbHigh <= orbLow
            || (orbHigh - orbLow) / orbLow > ORB_MAX_RANGE_PCT) {
          orbHigh = orbLow = null; // invalid range → no ORB today
        }
      }
    }

    signal = "WAIT";
    reason = "No pattern";

    // ── Indicator REENTER conditions at bar i — the old BUY logic, demoted.
    // Armed only after the day's first pattern BUY (tradesToday > 0).
    let reenterReason = null;
    if (tradesToday > 0 && (mins == null || mins < NO_ENTRY_AFTER)) {
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
      const wma30UnderEma10 = wma30[i] != null && ema10[i] != null && wma30[i] < ema10[i];
      const clearOfWma30 = wma30[i] != null && ha[i].low > wma30[i];

      if (paleGreenFlipBuy && emaCrossedUp && wmaCrossedUp
          && ema10Rising3 && wma30UnderEma10 && clearOfWma30) {
        reenterReason = "PALEGREEN flip bullish (K1.5/ATR10, normal candles), 10EMA>30EMA rising, WMA30<10EMA, candle clear of WMA30 (HA)";
      } else if (green.pos[i] === 1 && infraGreenFlipBuy && emaCrossedUp
                 && wmaCrossedUp && ema10Rising && wma30UnderEma10 && clearOfWma30) {
        reenterReason = "INFRAGREEN flip bullish (K0.8/ATR10) while GREEN bullish, 10EMA>30EMA rising, WMA30<10EMA, candle clear of WMA30 (HA)";
      }
    }

    if (inTrade) {
      if (mins != null && mins >= EOD_EXIT_MIN) {
        signal = "SELL";
        reason = "EOD square-off at 15:20";
        inTrade = false;
      } else if (nC[i] <= stop) {
        signal = "SELL";
        reason = `close below pattern stop (${stop.toFixed(2)})`;
        inTrade = false;
      } else if (reenterReason) {
        signal = "REENTER";
        reason = reenterReason;
      }
    } else {
      // Fresh patterns FIRST — a new breakout outranks a re-entry signal.
      if (tradesToday < MAX_TRADES_PER_DAY
          && (mins == null || mins < NO_ENTRY_AFTER)) {
        if (!orbTraded && orbHigh != null && mins != null
            && mins >= ORB_END_MIN && mins <= ORB_ENTRY_CUTOFF
            && nC[i] > orbHigh && nC[i - 1] <= orbHigh) {
          signal = "BUY";
          reason = `ORB breakout: close above 9:15-9:30 range high ${orbHigh.toFixed(2)}`;
          inTrade = true;
          stop = orbLow;
          orbTraded = true;
          tradesToday++;
        } else {
          const cup = findCupBreakout(nH, nL, nC, i);
          if (cup) {
            lastRim = cup.rimHigh;
            signal = "BUY";
            reason = `Cup & handle breakout above rim ${cup.rimHigh.toFixed(2)} (cup ${cup.cupLen} bars, handle ${cup.handleLen})`;
            inTrade = true;
            stop = cup.handleLow;
            tradesToday++;
          }
        }
      }
      // Re-entry — fires only if no fresh pattern fired this bar.
      // Signal only — do NOT touch inTrade, or the state re-locks and
      // blocks all fresh patterns till EOD.
      if (signal === "WAIT" && reenterReason) {
        signal = "REENTER";
        reason = reenterReason;
      }
    }
  }

  const last = N - 1;
  return {
    signal,
    reason,
    inTrade,
    stop,
    tradesToday,
    orbHigh,
    orbLow,
    rim: lastRim,
    greenPos: green.pos[last],
    greenTrail: green.trail[last],
    palegreenPos: palegreen.pos[last],
    palegreenTrail: palegreen.trail[last],
    cyanPos: cyan.pos[last],
    cyanTrail: cyan.trail[last],
    infraGreenPos: infraGreen.pos[last],
    infraGreenTrail: infraGreen.trail[last],
    srma: srma.ma[last],
    ema10: ema10[last],
    ema30: ema30[last],
    wma30: wma30[last],
    wma60: wma60[last],
    close: nC[last]
  };
}

module.exports = { claudSurStrategy, utGptStrategy2: claudSurStrategy };
