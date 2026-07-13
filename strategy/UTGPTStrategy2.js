// =============================================================================
// UTGPTStrategy2 — Triple UTBOT Strategy with Re-entry
//
// INDICATORS & CONFIGURATION:
//   - GREEN (UT Bot 1): Key Value = 2, ATR Period = 10
//   - BLUE  (UT Bot 2): Key Value = 3, ATR Period = 10
//   - CYAN  (UT Bot 3): Key Value = 1, ATR Period = 10
//
// BUY:      BLUE flips bullish, OR BLUE & CYAN already bullish and GREEN flips bullish.
// SELL:     Either BLUE or GREEN flips bearish.
// REENTER:  Both GREEN and BLUE are bullish, and CYAN becomes bullish.
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

function utGptStrategy2(candles) {
  if (!candles || candles.length < 100) {
    return { signal: "WAIT", reason: "Not enough data (need 100+)" };
  }

  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));
  const N = C.length;

  const green = utBotSeries(H, L, C, 2, 10); // GREEN (Key=2, ATR=10)
  const blue  = utBotSeries(H, L, C, 3, 10); // BLUE  (Key=3, ATR=10)
  const cyan  = utBotSeries(H, L, C, 1, 10); // CYAN  (Key=1, ATR=10)

  let lastSignal = "WAIT", lastReason = "No signal";

  for (let i = 1; i < N; i++) {
    const blueBull  = blue.pos[i] === 1;
    const greenBull = green.pos[i] === 1;
    const cyanBull  = cyan.pos[i] === 1;

    const blueFlipBuy   = blue.pos[i] === 1 && blue.pos[i - 1] !== 1;
    const greenFlipBuy  = green.pos[i] === 1 && green.pos[i - 1] !== 1;
    const cyanFlipBuy   = cyan.pos[i] === 1 && cyan.pos[i - 1] !== 1;

    const blueFlipSell  = blue.pos[i] === -1 && blue.pos[i - 1] !== -1;
    const greenFlipSell = green.pos[i] === -1 && green.pos[i - 1] !== -1;

    let sig = "WAIT", reason = "No signal";

    // ── SELL: either BLUE or GREEN flips bearish ──
    if (blueFlipSell || greenFlipSell) {
      sig = "SELL";
      if (blueFlipSell && greenFlipSell) reason = "BLUE & GREEN both flip bearish (K3/ATR10 & K2/ATR10)";
      else if (blueFlipSell) reason = "BLUE flip bearish (K3/ATR10)";
      else reason = "GREEN flip bearish (K2/ATR10)";
    }
    // ── BUY: BLUE flips bullish ──
    else if (blueFlipBuy) {
      sig = "BUY";
      reason = "BLUE flip bullish (K3/ATR10)";
    }
    // ── BUY: BLUE & CYAN already bullish, GREEN flips bullish ──
    else if (blueBull && cyanBull && greenFlipBuy) {
      sig = "BUY";
      reason = "GREEN flip bullish (K2/ATR10) while BLUE & CYAN bullish";
    }
    // ── REENTER: GREEN & BLUE bullish, CYAN flips bullish ──
    else if (greenBull && blueBull && cyanFlipBuy) {
      sig = "REENTER";
      reason = "CYAN re-entry flip bullish (K1/ATR10) while GREEN & BLUE bullish";
    }

    lastSignal = sig;
    lastReason = reason;
  }

  return {
    signal: lastSignal,
    reason: lastReason,
    greenPos: green.pos[N - 1],
    bluePos: blue.pos[N - 1],
    cyanPos: cyan.pos[N - 1],
    greenTrail: green.trail[N - 1],
    blueTrail: blue.trail[N - 1],
    cyanTrail: cyan.trail[N - 1],
    close: C[N - 1]
  };
}

module.exports = { utGptStrategy2 };
