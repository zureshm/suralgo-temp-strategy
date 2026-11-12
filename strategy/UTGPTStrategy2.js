// =============================================================================
// utGptStrategy2 — Dual UT Bot (GREEN on normal candles + PALEGREEN on Heikin-Ashi)
//
//   - GREEN     (UT Bot): Key Value = 2,   ATR Period = 10 — NORMAL candles
//   - PALEGREEN (UT Bot): Key Value = 0.8, ATR Period = 10 — HEIKIN-ASHI candles
//
// BUY (GREEN):     GREEN flips bullish (normal candles) while PALEGREEN is
//                  already bullish (Heikin-Ashi).
// BUY (PALEGREEN): PALEGREEN flips bullish (Heikin-Ashi) while GREEN is
//                  already bullish (normal candles).
// SELL:            PALEGREEN flips bearish (Heikin-Ashi). Nothing else.
// =============================================================================

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

function heikinAshi(O, H, L, C) {
  const n = C.length;
  const haO = new Array(n), haH = new Array(n), haL = new Array(n), haC = new Array(n);
  for (let i = 0; i < n; i++) {
    haC[i] = (O[i] + H[i] + L[i] + C[i]) / 4;
    haO[i] = i === 0 ? (O[i] + C[i]) / 2 : (haO[i - 1] + haC[i - 1]) / 2;
    haH[i] = Math.max(H[i], haO[i], haC[i]);
    haL[i] = Math.min(L[i], haO[i], haC[i]);
  }
  return { O: haO, H: haH, L: haL, C: haC };
}

function utGptStrategy2(candles) {
  if (!candles || candles.length < 20) {
    return { signal: "WAIT", reason: "Not enough data" };
  }

  const O = candles.map(c => Number(c.open));
  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));
  const N = C.length;

  const ha = heikinAshi(O, H, L, C);
  const green = utBotSeries(H, L, C, 2, 10);                  // GREEN — normal candles
  const paleGreen = utBotSeries(ha.H, ha.L, ha.C, 0.8, 10);   // PALEGREEN — Heikin-Ashi

  const i = N - 1;
  const greenBullFlip = green.pos[i] === 1 && green.pos[i - 1] !== 1;
  const paleBullFlip = paleGreen.pos[i] === 1 && paleGreen.pos[i - 1] !== 1;
  const paleBearFlip = paleGreen.pos[i] === -1 && paleGreen.pos[i - 1] !== -1;

  let signal = "WAIT";
  let reason = "No flip";

  if (paleBearFlip) {
    signal = "SELL";
    reason = "PALEGREEN flipped bearish (Heikin-Ashi)";
  } else if (greenBullFlip && paleGreen.pos[i] === 1) {
    signal = "BUY";
    reason = "GREEN flipped bullish (normal) while PALEGREEN already bullish (Heikin-Ashi)";
  } else if (paleBullFlip && green.pos[i] === 1) {
    signal = "BUY";
    reason = "PALEGREEN flipped bullish (Heikin-Ashi) while GREEN already bullish (normal)";
  }

  return {
    signal,
    reason,
    greenPos: green.pos[i],
    greenTrail: green.trail[i],
    paleGreenPos: paleGreen.pos[i],
    paleGreenTrail: paleGreen.trail[i],
    close: C[i]
  };
}

module.exports = { utGptStrategy2 };
