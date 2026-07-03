// =============================================================================
// UTGPTStrategy4X — Quad UTBOT Strategy with Re-entry / Re-exit
// Upgrade of UTGPTStrategy4 with added VIOLET UT Bot for extra REENTER.
//
// INDICATORS & CONFIGURATION:
//   - BLUE   (UT Bot 1): Key Value = 4, ATR Period = 10
//   - GREEN  (UT Bot 2): Key Value = 3, ATR Period = 10
//   - BLACK  (UT Bot 3): Key Value = 1, ATR Period = 10
//   - VIOLET (UT Bot 4): Key Value = 1, ATR Period = 1
//
// BUY:      Either BLUE or GREEN becomes bullish.
// SELL:     Either BLUE or GREEN becomes bearish.
// REENTER:  Both BLUE and GREEN are bullish, and BLACK or VIOLET becomes bullish.
// REEXIT:   Both BLUE and GREEN are bullish, and BLACK becomes bearish.
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

function utGptStrategy4X(candles) {
  if (!candles || candles.length < 100) {
    return { signal: "WAIT", reason: "Not enough data (need 100+)" };
  }

  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));
  const N = C.length;

  const blue   = utBotSeries(H, L, C, 4, 10); // BLUE   (Key=4, ATR=10)
  const green  = utBotSeries(H, L, C, 3, 10); // GREEN  (Key=3, ATR=10)
  const black  = utBotSeries(H, L, C, 1, 10); // BLACK  (Key=1, ATR=10)
  const violet = utBotSeries(H, L, C, 1, 1);  // VIOLET (Key=1, ATR=1)

  let lastSignal = "WAIT", lastReason = "No signal";

  for (let i = 1; i < N; i++) {
    const blueBull  = blue.pos[i] === 1;
    const greenBull = green.pos[i] === 1;

    const blueFlipBuy  = blue.pos[i] === 1 && blue.pos[i - 1] !== 1;
    const greenFlipBuy = green.pos[i] === 1 && green.pos[i - 1] !== 1;
    const blueFlipSell  = blue.pos[i] === -1 && blue.pos[i - 1] !== -1;
    const greenFlipSell = green.pos[i] === -1 && green.pos[i - 1] !== -1;

    const blackFlipBuy  = black.pos[i] === 1 && black.pos[i - 1] !== 1;
    const blackFlipSell = black.pos[i] === -1 && black.pos[i - 1] !== -1;

    const violetFlipBuy  = violet.pos[i] === 1 && violet.pos[i - 1] !== 1;

    let sig = "WAIT", reason = "No signal";

    // ── SELL: either BLUE or GREEN flips bearish ──
    if (blueFlipSell || greenFlipSell) {
      sig = "SELL";
      if (blueFlipSell && greenFlipSell) reason = "BLUE & GREEN both flip bearish (K4/ATR10 & K3/ATR10)";
      else if (blueFlipSell) reason = "BLUE flip bearish (K4/ATR10)";
      else reason = "GREEN flip bearish (K3/ATR10)";
    }
    // ── BUY: either BLUE or GREEN flips bullish ──
    else if (blueFlipBuy || greenFlipBuy) {
      sig = "BUY";
      if (blueFlipBuy && greenFlipBuy) reason = "BLUE & GREEN both flip bullish (K4/ATR10 & K3/ATR10)";
      else if (blueFlipBuy) reason = "BLUE flip bullish (K4/ATR10)";
      else reason = "GREEN flip bullish (K3/ATR10)";
    }
    // ── REENTER (BLACK): both BLUE & GREEN bullish, BLACK flips bullish ──
    else if (blueBull && greenBull && blackFlipBuy) {
      sig = "REENTER";
      reason = "BLACK re-entry flip bullish (K1/ATR10) while BLUE & GREEN bullish";
    }
    // ── REENTER (VIOLET): both BLUE & GREEN bullish, VIOLET flips bullish ──
    else if (blueBull && greenBull && violetFlipBuy) {
      sig = "REENTER";
      reason = "VIOLET re-entry flip bullish (K1/ATR1) while BLUE & GREEN bullish";
    }
    // ── REEXIT: both BLUE & GREEN bullish, BLACK flips bearish ──
    else if (blueBull && greenBull && blackFlipSell) {
      sig = "REEXIT";
      reason = "BLACK re-exit flip bearish (K1/ATR10) while BLUE & GREEN bullish";
    }

    lastSignal = sig;
    lastReason = reason;
  }

  return {
    signal: lastSignal,
    reason: lastReason,
    bluePos: blue.pos[N - 1],
    blueTrail: blue.trail[N - 1],
    greenPos: green.pos[N - 1],
    greenTrail: green.trail[N - 1],
    blackPos: black.pos[N - 1],
    blackTrail: black.trail[N - 1],
    violetPos: violet.pos[N - 1],
    violetTrail: violet.trail[N - 1],
    close: C[N - 1]
  };
}

module.exports = { utGptStrategy4X };
