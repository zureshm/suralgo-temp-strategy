// =============================================================================
// UTGPTStrategy4 — Dual UTBOT Strategy (Dynamic CYAN + GREEN)
//
// INDICATORS & CONFIGURATION:
//   - CYAN  (UT Bot 1): Dynamic Key (6-16 based on close), ATR Period = 1000
//     Key tiers: <100→6, 100-120→7, 120-150→8, 150-200→9,
//     220→10, 250→11, 300→12, 320→13, 350→14, 400→15, 400+→16
//   - GREEN (UT Bot 2): Key Value = 4, ATR Period = 10
//
// BUY:  Both CYAN and GREEN are bullish AND at least one just flipped bullish.
// SELL: Either CYAN or GREEN flips bearish.
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

// ── Dynamic Key for CYAN based on close price ───────────────────────────────
function getDynamicCyanKey(close) {
  if (close < 100) return 6;
  if (close < 120) return 7;
  if (close < 140) return 8;
  if (close < 180) return 9;
  if (close < 200) return 10;
  if (close < 220) return 11;
  if (close < 240) return 12;
  if (close < 280) return 13;
  if (close < 300) return 14;
  if (close < 350) return 15;
  if (close < 400) return 16;
  return 17;
}

// ── UT Bot with dynamic key (key changes per candle based on close) ─────────
function utBotSeriesDynamicKey(H, L, C, atrPeriod) {
  const N = C.length;
  const atr = atrSeries(H, L, C, atrPeriod);
  const posArr = new Array(N).fill(0);
  const tsArr = new Array(N).fill(null);

  let ts = 0, pos = 0;
  for (let i = 1; i < N; i++) {
    if (atr[i] == null) { posArr[i] = pos; tsArr[i] = ts; continue; }
    const keyValue = getDynamicCyanKey(C[i]);
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

function utGptStrategy4(candles) {
  if (!candles || candles.length < 100) {
    return { signal: "WAIT", reason: "Not enough data (need 100+)" };
  }

  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));
  const N = C.length;

  const cyan  = utBotSeriesDynamicKey(H, L, C, 1000); // CYAN (Dynamic Key, ATR=1000)
  const green = utBotSeries(H, L, C, 4, 10);          // GREEN (Key=4, ATR=10)

  let inPosition = false;
  let lastSignal = "WAIT", lastReason = "No signal";

  for (let i = 1; i < N; i++) {
    const cyanBull  = cyan.pos[i] === 1;
    const greenBull = green.pos[i] === 1;

    const cyanFlipBuy  = cyan.pos[i] === 1 && cyan.pos[i - 1] !== 1;
    const greenFlipBuy = green.pos[i] === 1 && green.pos[i - 1] !== 1;

    const cyanFlipSell  = cyan.pos[i] === -1 && cyan.pos[i - 1] !== -1;
    const greenFlipSell = green.pos[i] === -1 && green.pos[i - 1] !== -1;

    let sig = "WAIT", reason = "No signal";

    // ── BUY: both bullish + at least one just flipped ──
    if (!inPosition && cyanBull && greenBull && (cyanFlipBuy || greenFlipBuy)) {
      inPosition = true;
      sig = "BUY";
      if (cyanFlipBuy && greenFlipBuy) reason = "CYAN & GREEN both flip bullish";
      else if (cyanFlipBuy) reason = "CYAN flip (Dynamic/ATR1000) + GREEN already bullish";
      else reason = "GREEN flip (K4/ATR10) + CYAN already bullish";
    }
    // ── SELL: either flips bearish ──
    else if (inPosition && (cyanFlipSell || greenFlipSell)) {
      inPosition = false;
      sig = "SELL";
      if (cyanFlipSell) reason = "CYAN sell flip (Dynamic/ATR1000)";
      else reason = "GREEN sell flip (K4/ATR10)";
    }

    lastSignal = sig;
    lastReason = reason;
  }

  return {
    signal: lastSignal,
    reason: lastReason,
    cyanPos: cyan.pos[N - 1],
    cyanTrail: cyan.trail[N - 1],
    greenPos: green.pos[N - 1],
    greenTrail: green.trail[N - 1],
    close: C[N - 1]
  };
}

module.exports = { utGptStrategy4 };
