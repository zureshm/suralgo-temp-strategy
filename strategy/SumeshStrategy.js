// =============================================================================
// SumeshStrategy — Single UT Bot (normal candles)
//
// INDICATORS & CONFIGURATION:
//   - UT Bot: Key Value = 2, ATR Period = 10
//   - Normal candles (no Heikin-Ashi)
//
// BUY:  UT Bot flips bullish.
// SELL: UT Bot flips bearish.
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

function sumeshStrategy(candles) {
  if (!candles || candles.length < 20) {
    return { signal: "WAIT", reason: "Not enough data" };
  }

  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));
  const N = C.length;

  const bot = utBotSeries(H, L, C, 2, 10); // UT Bot (Key=2, ATR=10)

  const i = N - 1;
  let signal = "WAIT";
  let reason = "No flip";

  if (bot.pos[i] === 1 && bot.pos[i - 1] !== 1) {
    signal = "BUY";
    reason = "UT Bot flipped bullish";
  } else if (bot.pos[i] === -1 && bot.pos[i - 1] !== -1) {
    signal = "SELL";
    reason = "UT Bot flipped bearish";
  }

  return {
    signal,
    reason,
    botPos: bot.pos[i],
    botTrail: bot.trail[i],
    close: C[i]
  };
}

module.exports = { sumeshStrategy };
