// =============================================================================
// VWAPUTBotStrategy — Quad UTBOT Confluence Strategy
//
// INDICATORS & CONFIGURATION:
//   - GREEN  (UT Bot 1): Key Value = 4, ATR Period = 10
//   - BLUE   (UT Bot 2): Key Value = 3, ATR Period = 10
//   - PURPLE (UT Bot 3): Key Value = 5, ATR Period = 20
//   - CYAN   (UT Bot 4): Key Value = 5, ATR Period = 1000
//
// BUY CONDITIONS (any one fires BUY):
//   1) CYAN flips bullish + GREEN bullish + PURPLE bearish right now.
//   2) PURPLE & CYAN both flip bullish same candle + GREEN bullish
//      (overrides PURPLE-bearish requirement of rule 1).
//   3) BLUE flips bullish + GREEN & PURPLE & CYAN bullish on that candle.
//   4) PURPLE flips bullish + GREEN & BLUE & CYAN bullish on that candle.
//   5) GREEN flips bullish + CYAN & BLUE & PURPLE bullish on that candle.
//
// SELL CONDITIONS:
//   BLUE OR CYAN OR GREEN OR PURPLE flips bearish → SELL.
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

// Wilder RMA (TradingView `ta.rma`): SMA-seeded over the first `period` samples,
// then Wilder smoothing. Returns null until `period` samples exist.
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

function VWAPUTBotStrategy(candles) {
  // Require only ~100 real candles.
  if (!candles || candles.length < 100) {
    return { signal: "WAIT", reason: "Not enough data (need 100+)" };
  }

  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));
  const N = C.length;

  // Four UT Bots
  const green  = utBotSeries(H, L, C, 4, 10);   // GREEN  (Key=4, ATR=10)
  const blue   = utBotSeries(H, L, C, 3, 10);   // BLUE   (Key=3, ATR=10)
  const purple = utBotSeries(H, L, C, 5, 20);   // PURPLE (Key=5, ATR=20)
  const cyan   = utBotSeries(H, L, C, 5, 1000); // CYAN   (Key=5, ATR=1000)

  let inPosition = false;
  let lastSignal = "WAIT", lastReason = "No signal";

  for (let i = 1; i < N; i++) {
    const greenBull  = green.pos[i] === 1;
    const blueBull   = blue.pos[i] === 1;
    const purpleBull = purple.pos[i] === 1;
    const cyanBull   = cyan.pos[i] === 1;

    const greenFlipBuy  = green.pos[i] === 1 && green.pos[i - 1] !== 1;
    const blueFlipBuy   = blue.pos[i] === 1 && blue.pos[i - 1] !== 1;
    const purpleFlipBuy = purple.pos[i] === 1 && purple.pos[i - 1] !== 1;
    const cyanFlipBuy   = cyan.pos[i] === 1 && cyan.pos[i - 1] !== 1;

    const greenFlipSell  = green.pos[i] === -1 && green.pos[i - 1] !== -1;
    const blueFlipSell   = blue.pos[i] === -1 && blue.pos[i - 1] !== -1;
    const purpleFlipSell = purple.pos[i] === -1 && purple.pos[i - 1] !== -1;
    const cyanFlipSell   = cyan.pos[i] === -1 && cyan.pos[i - 1] !== -1;

    let sig = "WAIT", reason = "No signal";

    // ── BUY CONDITIONS ──
    // 1) CYAN flips + GREEN bullish + PURPLE bearish right now
    const buy1 = cyanFlipBuy && greenBull && !purpleBull;
    // 2) PURPLE & CYAN both flip same candle + GREEN bullish
    const buy2 = purpleFlipBuy && cyanFlipBuy && greenBull;
    // 3) BLUE flips + GREEN & PURPLE & CYAN bullish
    const buy3 = blueFlipBuy && greenBull && purpleBull && cyanBull;
    // 4) PURPLE flips + GREEN & BLUE & CYAN bullish
    const buy4 = purpleFlipBuy && greenBull && blueBull && cyanBull;
    // 5) GREEN flips + CYAN & BLUE & PURPLE bullish
    const buy5 = greenFlipBuy && cyanBull && blueBull && purpleBull;

    if (!inPosition && (buy1 || buy2 || buy3 || buy4 || buy5)) {
      inPosition = true;
      sig = "BUY";
      if (buy1) reason = "CYAN flip (K5/ATR1000) + GREEN bullish + PURPLE bearish";
      else if (buy2) reason = "PURPLE & CYAN flip same candle + GREEN bullish";
      else if (buy3) reason = "BLUE flip (K3/ATR10) + GREEN & PURPLE & CYAN bullish";
      else if (buy4) reason = "PURPLE flip (K5/ATR20) + GREEN & BLUE & CYAN bullish";
      else reason = "GREEN flip (K4/ATR10) + CYAN & BLUE & PURPLE bullish";
    }
    // ── SELL: any of the 4 bots flips bearish ──
    else if (inPosition && (greenFlipSell || blueFlipSell || purpleFlipSell || cyanFlipSell)) {
      inPosition = false;
      sig = "SELL";
      if (cyanFlipSell) reason = "CYAN sell flip (K5/ATR1000)";
      else if (greenFlipSell) reason = "GREEN sell flip (K4/ATR10)";
      else if (blueFlipSell) reason = "BLUE sell flip (K3/ATR10)";
      else reason = "PURPLE sell flip (K5/ATR20)";
    }

    lastSignal = sig;
    lastReason = reason;
  }

  return {
    signal: lastSignal,
    reason: lastReason,
    greenPos: green.pos[N - 1],
    greenTrail: green.trail[N - 1],
    bluePos: blue.pos[N - 1],
    blueTrail: blue.trail[N - 1],
    purplePos: purple.pos[N - 1],
    purpleTrail: purple.trail[N - 1],
    cyanPos: cyan.pos[N - 1],
    cyanTrail: cyan.trail[N - 1],
    close: C[N - 1]
  };
}

module.exports = { VWAPUTBotStrategy };
