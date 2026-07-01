// =============================================================================
// UTGPTStrategy3 — Simplified UTBOT Strategy
// Uses only UTBOT with Key Value = 3, ATR Period = 10
//
// BUY:     When UTBOT becomes bullish (flips to bullish)
// SELL:    When UTBOT becomes bearish (flips to bearish)
// REENTER: UTBOT bullish + BLACK (K=1, ATR=10) flips bullish
// REEXIT:  UTBOT bullish + BLACK (K=1, ATR=10) flips bearish
// =============================================================================

function trueRangeSeries(H, L, C) {
  const tr = [];
  for (let i = 0; i < C.length; i++) {
    if (i === 0) { tr.push(H[i] - L[i]); continue; }
    tr.push(Math.max(
      H[i] - L[i],
      Math.abs(H[i] - C[i - 1]),
      Math.abs(L[i] - C[i - 1])
    ));
  }
  return tr;
}

function rmaSeries(src, period) {
  const out = new Array(src.length).fill(null);
  if (src.length < period) return out;
  let s = 0;
  for (let i = 0; i < period; i++) s += src[i];
  out[period - 1] = s / period;
  for (let i = period; i < src.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + src[i]) / period;
  }
  return out;
}

function atrSeries(H, L, C, period) {
  return rmaSeries(trueRangeSeries(H, L, C), period);
}

function computeUTBot(candles, keyValue, atrPeriod) {
  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));
  const N = C.length;
  const atr = atrSeries(H, L, C, atrPeriod);

  let ts = 0, pos = 0;
  let flippedBuy = false, flippedSell = false;

  for (let i = 1; i < N; i++) {
    if (atr[i] == null) continue;
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

    const prevPos = pos;
    if (C[i - 1] < prevTS && C[i] > prevTS) pos = 1;
    else if (C[i - 1] > prevTS && C[i] < prevTS) pos = -1;

    const buy = pos === 1 && prevPos !== 1;
    const sell = pos === -1 && prevPos !== -1;

    if (i === N - 1) {
      flippedBuy = buy;
      flippedSell = sell;
    }
  }

  return { pos, flippedBuy, flippedSell, trail: ts };
}

function utGptStrategy3(candles) {
  if (!candles || candles.length < 15) {
    return { signal: "WAIT", utbotPos: null, utbotTrail: null };
  }

  const utbot = computeUTBot(candles, 3, 10);
  const black = computeUTBot(candles, 1, 10);

  if (utbot.flippedBuy) {
    return {
      signal: "BUY",
      reason: "UTBOT bullish flip (K=3, ATR=10)",
      utbotPos: utbot.pos,
      utbotTrail: utbot.trail,
      blackPos: black.pos,
      blackTrail: black.trail
    };
  }

  if (utbot.flippedSell) {
    return {
      signal: "SELL",
      reason: "UTBOT bearish flip (K=3, ATR=10)",
      utbotPos: utbot.pos,
      utbotTrail: utbot.trail,
      blackPos: black.pos,
      blackTrail: black.trail
    };
  }

  // ── REENTER/REEXIT: only when main UTBOT is bullish ──
  if (utbot.pos === 1 && black.flippedBuy) {
    return {
      signal: "REENTER",
      reason: "BLACK re-entry flip bullish (K1/ATR10) while UTBOT bullish",
      utbotPos: utbot.pos,
      utbotTrail: utbot.trail,
      blackPos: black.pos,
      blackTrail: black.trail
    };
  }

  if (utbot.pos === 1 && black.flippedSell) {
    return {
      signal: "REEXIT",
      reason: "BLACK re-exit flip bearish (K1/ATR10) while UTBOT bullish",
      utbotPos: utbot.pos,
      utbotTrail: utbot.trail,
      blackPos: black.pos,
      blackTrail: black.trail
    };
  }

  return {
    signal: "WAIT",
    utbotPos: utbot.pos,
    utbotTrail: utbot.trail,
    blackPos: black.pos,
    blackTrail: black.trail
  };
}

module.exports = { utGptStrategy3 };
