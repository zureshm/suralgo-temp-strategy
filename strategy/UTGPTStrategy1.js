// =============================================================================
// UTGPTStrategy1 — NIFTY Smart Liquidity Breakout
//
// Converted from Pine Script "NIFTY Smart Liquidity Breakout" (v5).
// Candles are converted to Heikin-Ashi before all indicator calculations.
//
// INDICATORS:
//   - EMA Fast (20) and EMA Slow (50) on close
//   - VWAP (session-reset, close × volume weighted)
//   - Supertrend (factor=3.0, ATR=10)
//   - ATR(14) with SMA(20) for volatility filter
//   - Swing High/Low: highest/lowest over last 10 bars (shifted 1)
//
// BUY:  Not in trade, cooldown OK (20 bars since last signal),
//       bullTrend: EMA20 > EMA50, close > VWAP, Supertrend bullish (dir<0), volatilityOK,
//       bullBreakout: close > swingHigh AND close > prev high.
//
// SELL: In trade, and any of:
//       EMA20 crosses under EMA50, OR Supertrend turns bearish (dir>0),
//       OR close < swingLow.
//
// NOTE: Pine Script HTF (5-min) filter omitted — no multi-timeframe support.
// =============================================================================

// ── Indicator helpers ────────────────────────────────────────────────────────

function _emaSeries(src, period) {
  const out = new Array(src.length).fill(null);
  if (src.length < period) return out;
  const k = 2 / (period + 1);
  let s = 0;
  for (let i = 0; i < period; i++) s += src[i];
  out[period - 1] = s / period;
  for (let i = period; i < src.length; i++) out[i] = src[i] * k + out[i - 1] * (1 - k);
  return out;
}

function _smaSeries(src, period) {
  const out = new Array(src.length).fill(null);
  for (let i = period - 1; i < src.length; i++) {
    let sum = 0, valid = true;
    for (let j = i - period + 1; j <= i; j++) {
      if (src[j] == null) { valid = false; break; }
      sum += src[j];
    }
    if (valid) out[i] = sum / period;
  }
  return out;
}

function _atrSeries(H, L, C, period) {
  // True range
  const tr = [];
  for (let i = 0; i < C.length; i++) {
    if (i === 0) { tr.push(H[i] - L[i]); continue; }
    tr.push(Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])));
  }
  // Wilder smoothing (RMA)
  const out = new Array(C.length).fill(null);
  if (C.length < period) return out;
  let s = 0;
  for (let i = 0; i < period; i++) s += tr[i];
  out[period - 1] = s / period;
  for (let i = period; i < C.length; i++) out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  return out;
}

function _supertrendSeries(H, L, C, factor, atrPeriod) {
  const N = C.length;
  const atr = _atrSeries(H, L, C, atrPeriod);
  const dirArr = new Array(N).fill(1); // 1 = bearish, -1 = bullish
  const stArr  = new Array(N).fill(null);

  let upperBand = null, lowerBand = null, dir = 1;

  for (let i = 1; i < N; i++) {
    if (atr[i] == null) { dirArr[i] = dir; continue; }

    const hl2 = (H[i] + L[i]) / 2;
    const basicUpper = hl2 + factor * atr[i];
    const basicLower = hl2 - factor * atr[i];

    // Upper band only moves down (or resets when price crosses above it)
    let newUpper = (upperBand === null || basicUpper < upperBand || C[i - 1] > upperBand)
      ? basicUpper : upperBand;

    // Lower band only moves up (or resets when price crosses below it)
    let newLower = (lowerBand === null || basicLower > lowerBand || C[i - 1] < lowerBand)
      ? basicLower : lowerBand;

    // Direction: 1 = bearish (price below upper band), -1 = bullish (price above lower band)
    if (dir > 0) {
      dir = C[i] > newUpper ? -1 : 1;
    } else {
      dir = C[i] < newLower ? 1 : -1;
    }

    upperBand = newUpper;
    lowerBand = newLower;
    dirArr[i] = dir;
    stArr[i]  = dir < 0 ? newLower : newUpper;
  }

  return { dir: dirArr, st: stArr };
}

function _timeToMinutes(timeStr) {
  if (!timeStr) return null;
  const m = /(\d{1,2}):(\d{2})/.exec(String(timeStr));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function _vwapSeries(C, V, times) {
  // Resets each session (when candle time-of-day goes backwards)
  const N = C.length;
  const out = new Array(N).fill(null);
  let cumPV = 0, cumV = 0;
  let prevMins = null;

  for (let i = 0; i < N; i++) {
    const curMins = _timeToMinutes(times[i]);
    // New session detected
    if (curMins !== null && prevMins !== null && curMins < prevMins) {
      cumPV = 0;
      cumV  = 0;
    }
    const vol = V[i] > 0 ? V[i] : 1; // avoid divide-by-zero; use 1 as fallback
    cumPV += C[i] * vol;
    cumV  += vol;
    out[i] = cumPV / cumV;
    prevMins = curMins;
  }
  return out;
}

// ── Main strategy ────────────────────────────────────────────────────────────

function utGptStrategy1(candles) {
  if (!candles || candles.length < 100) {
    return { signal: "WAIT", reason: "Not enough data (need 100+)" };
  }

  const N = candles.length;
  const V     = candles.map(c => Number(c.volume) || 0);
  const times = candles.map(c => c.time);

  // ── Convert to Heikin-Ashi ──
  const ha = [];
  for (let i = 0; i < N; i++) {
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

  // Parameters (matching Pine Script defaults)
  const EMA_FAST    = 20;
  const EMA_SLOW    = 50;
  const ST_FACTOR   = 3.0;
  const ST_ATR      = 10;
  const SWING_LEN   = 10;
  const ATR_LEN     = 14;
  const COOLDOWN    = 20;

  // Indicators
  const ema20  = _emaSeries(C, EMA_FAST);
  const ema50  = _emaSeries(C, EMA_SLOW);
  const atr14  = _atrSeries(H, L, C, ATR_LEN);
  const atrAvg = _smaSeries(atr14, 20); // SMA(ATR, 20)
  const vwap   = _vwapSeries(C, V, times);
  const { dir: stDir, st: stVal } = _supertrendSeries(H, L, C, ST_FACTOR, ST_ATR);

  // State (replayed from scratch each call — same model as other strategies)
  let inTrade       = false;
  let lastSignalBar = -Infinity;
  let lastSignal    = "WAIT";
  let lastReason    = "No signal";

  for (let i = 1; i < N; i++) {
    // Skip until all indicators are available
    if (ema20[i] == null || ema50[i] == null || atr14[i] == null || atrAvg[i] == null) continue;
    // Need swingLen bars behind (shifted 1) — so i >= SWING_LEN + 1
    if (i < SWING_LEN + 1) continue;

    // ── Swing High/Low: highest/lowest of bars [i-SWING_LEN .. i-1] ──
    let swingHigh = -Infinity, swingLow = Infinity;
    for (let j = i - SWING_LEN; j < i; j++) {
      if (H[j] > swingHigh) swingHigh = H[j];
      if (L[j] < swingLow)  swingLow  = L[j];
    }

    // ── Volatility filter ──
    const volatilityOK = atr14[i] > atrAvg[i];

    // ── Breakout ──
    const bullBreakout = C[i] > swingHigh && C[i] > H[i - 1];
    // (bearBreakout not needed — no short entries)

    // ── Trend ──
    // htfBull (5-min multi-timeframe) omitted — no MTF support
    const bullTrend =
      ema20[i] > ema50[i] &&
      C[i] > vwap[i] &&
      stDir[i] < 0 &&      // Supertrend bullish
      volatilityOK;

    // ── Cooldown ──
    const cooldownOK = (i - lastSignalBar) > COOLDOWN;

    let sig = "WAIT", reason = "No signal";

    // ── BUY ──
    if (!inTrade && cooldownOK && bullTrend && bullBreakout) {
      sig    = "BUY";
      reason = "Breakout above swing high — EMA20>EMA50, above VWAP, Supertrend bullish, ATR strong";
      inTrade       = true;
      lastSignalBar = i;
    }

    // ── SELL (exit) ──
    if (inTrade && sig === "WAIT") {
      const ema20CrossUnder = ema20[i] < ema50[i] && ema20[i - 1] >= ema50[i - 1];
      const stBearish       = stDir[i] > 0;
      const belowSwingLow   = C[i] < swingLow;

      if (ema20CrossUnder || stBearish || belowSwingLow) {
        const parts = [];
        if (ema20CrossUnder) parts.push("EMA20 crossed under EMA50");
        if (stBearish)       parts.push("Supertrend turned bearish");
        if (belowSwingLow)   parts.push("close below swing low");
        sig    = "SELL";
        reason = parts.join(", ");
        inTrade       = false;
        lastSignalBar = i;
      }
    }

    lastSignal = sig;
    lastReason = reason;
  }

  return {
    signal:    lastSignal,
    reason:    lastReason,
    inTrade,
    ema20:     ema20[N - 1],
    ema50:     ema50[N - 1],
    vwap:      vwap[N - 1],
    stDir:     stDir[N - 1],
    stVal:     stVal[N - 1],
    atr:       atr14[N - 1],
    close:     C[N - 1]
  };
}

module.exports = { utGptStrategy1 };
