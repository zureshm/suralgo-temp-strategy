// =============================================================================
// claudSurStrategy — Triple UTBOT Confluence Strategy
//
// Uses the standard TradingView UT Bot (ATR trailing stop) — the same UT Bot
// implementation used across our other strategies.
//
// INDICATORS & CONFIGURATION:
//   - CYAN  (UT Bot 1): Key Value = 4, ATR Period = 1000
//   - GREEN (UT Bot 2): Key Value = 4, ATR Period = 10
//   - BLUE  (UT Bot 3): Key Value = 3, ATR Period = 10
//
// NOTE ON ATR + SHORT INTRADAY HISTORY:
//   Uses ONLY the available candles (no padding). ATR is an expanding average of
//   true range until `period` samples exist, then switches to Wilder RMA. So
//   CYAN's ATR Period = 1000 is defined and evolves across a ~350-candle session
//   (it just behaves as the running average true range over all bars so far).
//
// BUY CONDITIONS (any one fires BUY; same-candle flips also qualify):
//   1) CYAN flips bullish  + GREEN & BLUE already bullish.
//   2) GREEN flips bullish + CYAN & BLUE already bullish.
//   3) BLUE flips bullish  + CYAN & GREEN already bullish.
//   (Net effect: all three must be bullish together, and at least one flipped
//    bullish on the current candle.)
//
// SELL CONDITIONS:
//   CYAN OR GREEN flips bearish → SELL (whichever occurs first).
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

// ATR base: expanding simple average of true range until `period` samples
// exist, then Wilder RMA. Defined from the first bar, so large periods (e.g.
// 1000) still produce a usable, evolving value on short histories (~350 bars).
function rmaSeries(src, period) {
  const out = new Array(src.length).fill(null);
  if (!src.length) return out;
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    if (i < period) {
      // Expanding simple average until we have `period` samples.
      sum += src[i];
      out[i] = sum / (i + 1);
    } else {
      // Standard Wilder RMA once enough samples exist.
      out[i] = (out[i - 1] * (period - 1) + src[i]) / period;
    }
  }
  return out;
}

function atrSeries(H, L, C, period) { return rmaSeries(trueRangeSeries(H, L, C), period); }

// ── Standard UT Bot (ATR trailing stop) ──────────────────────────────────────
// Returns per-candle position series (1 = bullish, -1 = bearish) and the
// trailing stop series. Identical logic to the UT Bot used in our other scripts.

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

    // Canonical UT Bot crossover (uses the PREVIOUS trailing stop on both sides)
    if (C[i - 1] < prevTS && C[i] > prevTS) pos = 1;
    else if (C[i - 1] > prevTS && C[i] < prevTS) pos = -1;

    posArr[i] = pos;
    tsArr[i] = ts;
  }

  return { pos: posArr, trail: tsArr };
}

// ── Main strategy ─────────────────────────────────────────────────────────────

function claudSurStrategy(candles) {
  // Require only ~100 real candles.
  if (!candles || candles.length < 100) {
    return { signal: "WAIT", reason: "Not enough data (need 100+)" };
  }

  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));
  const N = C.length;

  // Three UT Bots
  const cyan  = utBotSeries(H, L, C, 4, 1000); // CYAN  (Key=4, ATR=1000)
  const green = utBotSeries(H, L, C, 4, 10);   // GREEN (Key=4, ATR=10)
  const blue  = utBotSeries(H, L, C, 3, 10);   // BLUE  (Key=3, ATR=10)

  let inPosition = false;
  let lastSignal = "WAIT", lastReason = "No signal";

  for (let i = 1; i < N; i++) {
    const cyanBull = cyan.pos[i] === 1;
    const greenBull = green.pos[i] === 1;
    const blueBull = blue.pos[i] === 1;

    const cyanFlipBuy  = cyan.pos[i] === 1 && cyan.pos[i - 1] !== 1;
    const greenFlipBuy = green.pos[i] === 1 && green.pos[i - 1] !== 1;
    const blueFlipBuy  = blue.pos[i] === 1 && blue.pos[i - 1] !== 1;

    const cyanFlipSell  = cyan.pos[i] === -1 && cyan.pos[i - 1] !== -1;
    const greenFlipSell = green.pos[i] === -1 && green.pos[i - 1] !== -1;

    let sig = "WAIT", reason = "No signal";

    // ── BUY: all three bullish together AND at least one flipped bullish now ──
    const buy1 = cyanFlipBuy  && greenBull && blueBull;  // CYAN trigger
    const buy2 = greenFlipBuy && cyanBull  && blueBull;  // GREEN trigger
    const buy3 = blueFlipBuy  && cyanBull  && greenBull; // BLUE trigger

    if (!inPosition && (buy1 || buy2 || buy3)) {
      inPosition = true;
      sig = "BUY";
      if (buy1) reason = "CYAN flip bullish (K4/ATR1000) + GREEN & BLUE bullish";
      else if (buy2) reason = "GREEN flip bullish (K4/ATR10) + CYAN & BLUE bullish";
      else reason = "BLUE flip bullish (K3/ATR10) + CYAN & GREEN bullish";
    }
    // ── SELL: CYAN or GREEN flips bearish ──
    else if (inPosition && (cyanFlipSell || greenFlipSell)) {
      inPosition = false;
      sig = "SELL";
      reason = cyanFlipSell
        ? "CYAN sell flip (K4/ATR1000)"
        : "GREEN sell flip (K4/ATR10)";
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
    bluePos: blue.pos[N - 1],
    blueTrail: blue.trail[N - 1],
    close: C[N - 1]
  };
}

module.exports = { claudSurStrategy };