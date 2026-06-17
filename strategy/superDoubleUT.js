// =============================================================================
// SuperDoubleUT — Supertrend + Dual UTBOT Strategy
//
// INDICATORS & CONFIGURATION:
//   - Supertrend: Period = 10, Multiplier = 3
//   - UT Bot 1:   Key Value = 4, ATR Period = 10
//   - UT Bot 2:   Key Value = 2, ATR Period = 300
//
// BUY CONDITIONS:
//   1) Supertrend bullish + UT Bot 1 flips bullish.
//   2) Supertrend already bullish + UT Bot 1 already bullish + UT Bot 2 flips bullish.
//
// SELL CONDITIONS:
//   UT Bot 2 flips bearish.
// =============================================================================

// ── Indicator helpers ────────────────────────────────────────────────────────

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

// ── UT Bot 1 (Key=4, ATR=10) ────────────────────────────────────────────────

function computeUTBot1(candles) {
  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));
  const N = C.length;
  const atr10 = atrSeries(H, L, C, 10);

  let ts = 0, pos = 0;
  let flippedBuy = false, flippedSell = false;

  for (let i = 1; i < N; i++) {
    if (atr10[i] == null) continue;
    const nLoss = 4 * atr10[i];
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

// ── UT Bot 2 (Key=2, ATR=300) ────────────────────────────────────────────────

function computeUTBot2(candles) {
  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));
  const N = C.length;
  const atr300 = atrSeries(H, L, C, 300);

  let ts = 0, pos = 0;
  let flippedBuy = false, flippedSell = false;

  for (let i = 1; i < N; i++) {
    if (atr300[i] == null) continue;
    const nLoss = 2 * atr300[i];
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

// ── Main strategy ───────────────────────────────────────────────────────────

function superDoubleUT(candles) {
  if (!candles || candles.length < 310) {
    return { signal: "WAIT", reason: "Not enough data (need 310+)" };
  }

  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));
  const N = C.length;

  // Precompute indicator series
  const atr10 = atrSeries(H, L, C, 10);
  const atr300 = atrSeries(H, L, C, 300);
  const { supertrend: stLine, direction: stDir } = supertrendSeries(H, L, C, 10, 3);

  // UT Bot 1 state (Key=4, ATR=10)
  let ts1 = 0, pos1 = 0;
  // UT Bot 2 state (Key=2, ATR=300)
  let ts2 = 0, pos2 = 0;

  let inPosition = false;
  let lastSignal = "WAIT", lastReason = "No signal";

  for (let i = 1; i < N; i++) {
    const stBullish = stDir[i] === 1;
    const stPrev = i >= 1 ? stDir[i - 1] : 0;
    const stFlippedBuy = stBullish && stPrev !== 1;

    // UT Bot 1 (Key=4, ATR=10)
    let ut1FlippedBuy = false, ut1FlippedSell = false;
    if (atr10[i] != null) {
      const nLoss1 = 4 * atr10[i];
      const prevTS1 = ts1;

      if (C[i] > prevTS1 && C[i - 1] > prevTS1) {
        ts1 = Math.max(prevTS1, C[i] - nLoss1);
      } else if (C[i] < prevTS1 && C[i - 1] < prevTS1) {
        ts1 = Math.min(prevTS1, C[i] + nLoss1);
      } else if (C[i] > prevTS1) {
        ts1 = C[i] - nLoss1;
      } else {
        ts1 = C[i] + nLoss1;
      }

      const prevPos1 = pos1;
      if (C[i - 1] < prevTS1 && C[i] > ts1) pos1 = 1;
      else if (C[i - 1] > prevTS1 && C[i] < ts1) pos1 = -1;

      ut1FlippedBuy = pos1 === 1 && prevPos1 !== 1;
      ut1FlippedSell = pos1 === -1 && prevPos1 !== -1;
    }

    // UT Bot 2 (Key=2, ATR=300)
    let ut2FlippedBuy = false, ut2FlippedSell = false;
    if (atr300[i] != null) {
      const nLoss2 = 2 * atr300[i];
      const prevTS2 = ts2;

      if (C[i] > prevTS2 && C[i - 1] > prevTS2) {
        ts2 = Math.max(prevTS2, C[i] - nLoss2);
      } else if (C[i] < prevTS2 && C[i - 1] < prevTS2) {
        ts2 = Math.min(prevTS2, C[i] + nLoss2);
      } else if (C[i] > prevTS2) {
        ts2 = C[i] - nLoss2;
      } else {
        ts2 = C[i] + nLoss2;
      }

      const prevPos2 = pos2;
      if (C[i - 1] < prevTS2 && C[i] > ts2) pos2 = 1;
      else if (C[i - 1] > prevTS2 && C[i] < ts2) pos2 = -1;

      ut2FlippedBuy = pos2 === 1 && prevPos2 !== 1;
      ut2FlippedSell = pos2 === -1 && prevPos2 !== -1;
    }

    const ut1Bullish = pos1 === 1;
    const ut2Bullish = pos2 === 1;

    let sig = "WAIT", reason = "No signal";

    // ── BUY Case 1: Supertrend bullish + UT Bot 1 flips bullish ──
    if (!inPosition && stBullish && ut1FlippedBuy) {
      inPosition = true;
      sig = "BUY";
      reason = stFlippedBuy
        ? "ST flip + UT Bot 1 flip together (K4/ATR10)"
        : "UT Bot 1 flip (K4/ATR10) inside ST bullish";
    }

    // ── SELL: UT Bot 2 flips bearish ──
    else if (inPosition && ut2FlippedSell) {
      inPosition = false;
      sig = "SELL";
      reason = "UT Bot 2 sell flip (K2/ATR300)";
    }

    // ── BUY Case 2: ST already bullish + UT Bot 1 already bullish + UT Bot 2 bullish ──
    else if (!inPosition && stBullish && ut1Bullish && ut2Bullish) {
      inPosition = true;
      sig = "BUY";
      reason = "ST bullish + UT Bot 1 bullish (K4/ATR10) + UT Bot 2 bullish (K2/ATR300)";
    }

    lastSignal = sig;
    lastReason = reason;
  }

  return {
    signal: lastSignal,
    reason: lastReason,
    utBot1Pos: pos1,
    utBot1Trail: ts1,
    utBot2Pos: pos2,
    utBot2Trail: ts2,
    stDirection: stDir[N - 1],
    supertrend: stLine[N - 1],
    close: C[N - 1]
  };
}

module.exports = { superDoubleUT };
