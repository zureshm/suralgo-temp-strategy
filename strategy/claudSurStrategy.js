// =============================================================================
// SUR_BUY_SELL_NOW — Pine Script v6 → Node.js (faithful conversion)
// Closed-candle evaluation, full-history bar-by-bar replay
// Signals: BUY, SELL, BUY_NOW (ENTRY), SELL_NOW (EXIT), WAIT
// =============================================================================

// ── Indicator helpers ────────────────────────────────────────────────────────

function emaSeries(src, period) {
  const out = new Array(src.length).fill(null);
  if (!src.length) return out;
  const k = 2 / (period + 1);
  out[0] = src[0];
  for (let i = 1; i < src.length; i++) out[i] = src[i] * k + out[i - 1] * (1 - k);
  return out;
}

function wmaSeries(src, period) {
  const out = new Array(src.length).fill(null);
  const denom = period * (period + 1) / 2;
  for (let i = period - 1; i < src.length; i++) {
    let s = 0;
    for (let j = 0; j < period; j++) s += src[i - period + 1 + j] * (j + 1);
    out[i] = s / denom;
  }
  return out;
}

function hmaSeries(src, period) {
  const halfLen = Math.floor(period / 2);
  const sqrtLen = Math.round(Math.sqrt(period));
  const wmaHalf = wmaSeries(src, halfLen);
  const wmaFull = wmaSeries(src, period);
  const diff = src.map((_, i) =>
    (wmaHalf[i] != null && wmaFull[i] != null) ? 2 * wmaHalf[i] - wmaFull[i] : null
  );
  const out = new Array(src.length).fill(null);
  const denom = sqrtLen * (sqrtLen + 1) / 2;
  for (let i = 0; i < src.length; i++) {
    if (i < sqrtLen - 1) continue;
    let valid = true, s = 0;
    for (let j = 0; j < sqrtLen; j++) {
      const val = diff[i - sqrtLen + 1 + j];
      if (val == null) { valid = false; break; }
      s += val * (j + 1);
    }
    if (valid) out[i] = s / denom;
  }
  return out;
}

function smaAt(arr, end, len) {
  if (end - len + 1 < 0) return null;
  let s = 0;
  for (let i = end - len + 1; i <= end; i++) { if (arr[i] == null) return null; s += arr[i]; }
  return s / len;
}

function highestAt(arr, end, len) {
  if (end - len + 1 < 0) return null;
  let m = -Infinity;
  for (let i = end - len + 1; i <= end; i++) if (arr[i] > m) m = arr[i];
  return m;
}

function lowestAt(arr, end, len) {
  if (end - len + 1 < 0) return null;
  let m = Infinity;
  for (let i = end - len + 1; i <= end; i++) if (arr[i] < m) m = arr[i];
  return m;
}

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

function macdAll(C, fast, slow, sig) {
  const f = emaSeries(C, fast), s = emaSeries(C, slow);
  const ml = C.map((_, i) => (f[i] != null && s[i] != null) ? f[i] - s[i] : null);
  const safe = ml.map(v => v == null ? 0 : v);
  const raw = emaSeries(safe, sig);
  const sl = ml.map((v, i) => v != null ? raw[i] : null);
  const hi = ml.map((v, i) => (v != null && sl[i] != null) ? v - sl[i] : null);
  return { macdLine: ml, signalLine: sl, hist: hi };
}

function stochKSeries(C, H, L, kLen, smoothK) {
  const raw = C.map((_, i) => {
    const hh = highestAt(H, i, kLen), ll = lowestAt(L, i, kLen);
    if (hh == null || ll == null) return null;
    const r = hh - ll; return r === 0 ? 0 : ((C[i] - ll) / r) * 100;
  });
  return C.map((_, i) => smaAt(raw, i, smoothK));
}

function stochDSeries(kArr, dLen) { return kArr.map((_, i) => smaAt(kArr, i, dLen)); }

function xover(pA, pB, nA, nB) { return pA != null && pB != null && nA != null && nB != null && pA <= pB && nA > nB; }
function xunder(pA, pB, nA, nB) { return pA != null && pB != null && nA != null && nB != null && pA >= pB && nA < nB; }

// ── Main strategy engine ────────────────────────────────────────────────────

// ── Supertrend (faithful Pine Script conversion) ────────────────────────────

function supertrendSeries(H, L, C, period, multiplier) {
  const atr = atrSeries(H, L, C, period);
  const len = C.length;
  const st = new Array(len).fill(null);
  const dir = new Array(len).fill(0);
  const up = new Array(len).fill(null);
  const dn = new Array(len).fill(null);

  for (let i = 0; i < len; i++) {
    if (atr[i] == null) continue;
    const hl2 = (H[i] + L[i]) / 2;
    const rawUp = hl2 - multiplier * atr[i];
    const rawDn = hl2 + multiplier * atr[i];

    if (i > 0 && up[i - 1] != null && C[i - 1] > up[i - 1]) {
      up[i] = Math.max(rawUp, up[i - 1]);
    } else {
      up[i] = rawUp;
    }

    if (i > 0 && dn[i - 1] != null && C[i - 1] < dn[i - 1]) {
      dn[i] = Math.min(rawDn, dn[i - 1]);
    } else {
      dn[i] = rawDn;
    }

    if (i === 0 || dir[i - 1] === 0) {
      dir[i] = C[i] > dn[i] ? 1 : -1;
    } else if (dir[i - 1] === -1 && C[i] > dn[i - 1]) {
      dir[i] = 1;
    } else if (dir[i - 1] === 1 && C[i] < up[i - 1]) {
      dir[i] = -1;
    } else {
      dir[i] = dir[i - 1];
    }

    st[i] = dir[i] === 1 ? up[i] : dn[i];
  }

  return { supertrend: st, direction: dir };
}

function claudSurStrategy(candles) {
  if (!candles || candles.length < 35) {
    return { signal: "WAIT", ema10: null, ema20: null };
  }

  const O = candles.map(c => Number(c.open));
  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));
  const N = C.length;

  // Pre-compute indicator series
  const ema8  = emaSeries(C, 8);
  const ema16 = emaSeries(C, 16);
  const hma120 = hmaSeries(C, 120);
  const atr14 = atrSeries(H, L, C, 14);
  const atr1  = atrSeries(H, L, C, 1);
  const md    = macdAll(C, 6, 26, 9);
  const mL = md.macdLine, sL = md.signalLine, mH = md.hist;
  const stK   = stochKSeries(C, H, L, 14, 3);
  const stD   = stochDSeries(stK, 3);

  // Supertrend (ATR Length 10, Factor 3)
  const { supertrend: stLine, direction: stDir } = supertrendSeries(H, L, C, 10, 3);

  // ── Pine "var" persistent state ──
  let emaCrossFlag = false;
  let inBuyZone = false, inSellZone = false, wasSideways = false;
  let mainBuyCycleActive = false, mainSellCycleActive = false;
  let inPosition = false, waitForIn = false, waitForIsBuyAfterIn = false;
  let inSellPosition = false, waitForOut = false, waitForIsSellAfterOut = false;
  let pendingBuyWindow = 0, pendingSellWindow = 0;
  let stPendingWindow = 0;
  let trailStop = null, trendDir = 0;

  let lastSignal = "WAIT", lastTrade = null, lastReason = "No signal";
  const barLogs = [];

  for (let i = 1; i < N; i++) {
    let sig = "WAIT", trade = null, reason = "No signal";

    // ATR sideways
    const h14 = highestAt(H, i, 14), l14 = lowestAt(L, i, 14);
    let sideways = false;
    if (h14 != null && l14 != null && atr14[i] != null) sideways = (h14 - l14) < atr14[i] * 2.5;

    // emaCrossFlag (Pine: strategy.position_size==0 always true — no entries/exits called)
    if (xover(ema8[i - 1], ema16[i - 1], ema8[i], ema16[i])) emaCrossFlag = true;

    const buyCondition  = emaCrossFlag && mL[i] != null && sL[i] != null && mL[i] > 0 && sL[i] > 0 && !sideways;
    const sellCondition = xunder(ema8[i - 1], ema16[i - 1], ema8[i], ema16[i]) && !sideways;

    // sideways ended
    const sidewaysEnded = wasSideways && !sideways;
    wasSideways = sideways;
    if (sidewaysEnded && mL[i] != null && sL[i] != null && ema8[i] != null && ema16[i] != null) {
      if (mL[i] > 0 && sL[i] > 0 && ema8[i] > ema16[i]) { inBuyZone = true; inSellZone = false; }
      else if (ema8[i] < ema16[i]) { inBuyZone = false; inSellZone = true; }
    }

    if (buyCondition)  { inBuyZone = true;  inSellZone = false; }
    if (sellCondition) { inBuyZone = false; inSellZone = true;  }
    if (sideways)      { inBuyZone = false; inSellZone = false; }

    // BUY label
    if (buyCondition) {
      // cycle start — internal only, not a trade signal
      emaCrossFlag = false;
      mainBuyCycleActive = true; mainSellCycleActive = false;
      inPosition = false; waitForIn = false; waitForIsBuyAfterIn = false;
      pendingBuyWindow = 0;
    }

    // SELL label
    if (sellCondition) {
      // cycle start — internal only, not a trade signal
      mainBuyCycleActive = false; mainSellCycleActive = true;
      inSellPosition = false; waitForOut = false; waitForIsSellAfterOut = false;
      pendingSellWindow = 0;
    }

    // ── UT Bot ──
    if (trailStop === null && atr1[i] != null) trailStop = C[i] - 2 * atr1[i];

    let mixLong = false, mixShort = false;
    if (trailStop !== null && atr1[i] != null) {
      const prevTS = trailStop;
      if (C[i] > trailStop) { trailStop = Math.max(trailStop, C[i] - 2 * atr1[i]); trendDir = 1; }
      if (C[i] < trailStop) { trailStop = Math.min(trailStop, C[i] + 2 * atr1[i]); trendDir = -1; }
      // Pine crossover(close, trailStop) => prev close <= prev trailStop AND cur close > cur trailStop
      mixLong  = C[i - 1] <= prevTS && C[i] > trailStop;
      mixShort = C[i - 1] >= prevTS && C[i] < trailStop;
    }

    // ── Stochastic + composite ──
    const h3 = highestAt(H, i, 3), l3 = lowestAt(L, i, 3);
    let isBullishPA = false, isBearishPA = false;
    if (h3 != null && l3 != null && i >= 3) {
      const mid = (h3 + l3) / 2;
      isBullishPA = C[i] > mid && C[i] > C[i - 3];
      isBearishPA = C[i] < mid && C[i] < C[i - 3];
    }

    const histStrong = mH[i] != null && Math.abs(mH[i]) > 0.3;
    const green = C[i] > O[i], red = C[i] < O[i];

    const isBuy = mL[i] != null && sL[i] != null && ema8[i] != null && ema16[i] != null &&
      stK[i] != null && stD[i] != null &&
      mL[i] > sL[i] && histStrong && ema8[i] > ema16[i] && stK[i] > stD[i] && trendDir === 1 && isBullishPA;

    const isSell = mL[i] != null && sL[i] != null && ema8[i] != null && ema16[i] != null &&
      stK[i] != null && stD[i] != null &&
      mL[i] < sL[i] && histStrong && ema8[i] < ema16[i] && stK[i] < stD[i] && trendDir === -1 && isBearishPA;

    // ── BUY NOW logic ──
    if (mainBuyCycleActive && !inPosition && !waitForIn && !waitForIsBuyAfterIn && isBuy) pendingBuyWindow = 5;
    if (mainBuyCycleActive && waitForIsBuyAfterIn && isBuy) { pendingBuyWindow = 5; waitForIsBuyAfterIn = false; }
    const stBullish = stDir[i] === 1;
    if (pendingBuyWindow > 0) {
      if (green && stBullish) { inPosition = true; pendingBuyWindow = 0; sig = "BUY"; trade = "ENTRY"; reason = "Buy now entry"; }
      else { pendingBuyWindow -= 1; }
    }
    if (mainBuyCycleActive && inPosition && mixShort) { inPosition = false; waitForIn = true; pendingBuyWindow = 0; }
    if (mainBuyCycleActive && waitForIn && mixLong) { waitForIn = false; waitForIsBuyAfterIn = true; }

    // ── SELL NOW logic (EMA8 crosses below EMA16 or HMA120 — whichever first) ──
    if (inPosition || waitForIn || waitForIsBuyAfterIn) {
      const ema8XunderEma16  = xunder(ema8[i - 1], ema16[i - 1], ema8[i], ema16[i]);
      const ema8XunderHma120 = xunder(ema8[i - 1], hma120[i - 1], ema8[i], hma120[i]);
      if (ema8XunderEma16 || ema8XunderHma120) {
        inPosition = false; waitForIn = false; waitForIsBuyAfterIn = false;
        pendingBuyWindow = 0;
        sig = "SELL"; trade = "EXIT"; reason = "Sell now exit";
      }
    }

    // ── Bar log ──
    const snap = { barIndex: i, emaCrossFlag, mainBuyCycleActive, mainSellCycleActive,
      inPosition, inSellPosition, waitForIn, waitForOut, waitForIsBuyAfterIn, waitForIsSellAfterOut,
      pendingBuyWindow, pendingSellWindow, trailStop, trendDir, signal: sig };
    barLogs.push(snap);
    // NOTE: Verbose per-bar logs are collected into barLogs. We intentionally do not
    // console.log them to avoid flooding the server output.

    lastSignal = sig; lastTrade = trade; lastReason = reason;
  }

  return {
    signal: lastSignal,
    ema10: ema8[N - 1],
    ema20: ema16[N - 1],
    hma120: hma120[N - 1],
    supertrend: stLine[N - 1],
    stDirection: stDir[N - 1]
  };
}

module.exports = { claudSurStrategy };