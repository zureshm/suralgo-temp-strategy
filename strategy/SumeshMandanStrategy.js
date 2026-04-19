// =============================================================================
// SumeshMandanStrategy — 2x UT Bot + Supertrend + VWAP
// UT Bot 1: Key=2, ATR=1  (fast)
// UT Bot 2: Key=3, ATR=300 (slow)
// BUY:  ST bullish + Both UT Bots bullish (pos1 === 1 AND pos2 === 1) + close > VWAP
// SELL: Either UT Bot flips bearish (sell1 OR sell2, or pos drops from 1)
// VWAP: Calculated from volume data; if volume unavailable, VWAP = 0 (gate bypassed)
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

// ── Main strategy engine ────────────────────────────────────────────────────

function sumeshMandanStrategy(candles) {
  if (!candles || candles.length < 35) {
    return { signal: "WAIT", trade: null, reason: "Not enough data" };
  }

  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));
  const V = candles.map(c => Number(c.volume) || 0);
  const N = C.length;

  // ── VWAP: cumulative(typicalPrice * volume) / cumulative(volume) ──
  const vwap = new Array(N).fill(0);
  let cumTPV = 0, cumVol = 0;
  for (let i = 0; i < N; i++) {
    const tp = (H[i] + L[i] + C[i]) / 3;
    cumTPV += tp * V[i];
    cumVol += V[i];
    vwap[i] = cumVol > 0 ? cumTPV / cumVol : 0;
  }

  // ATR series for both UT Bots
  const atr1   = atrSeries(H, L, C, 1);   // UT Bot 1 (Key=2, ATR=1)
  const atr300 = atrSeries(H, L, C, 300); // UT Bot 2 (Key=3, ATR=300)

  // Supertrend (ATR Length 10, Factor 3)
  const { supertrend: stLine, direction: stDir } = supertrendSeries(H, L, C, 10, 3);

  // ── UT Bot state ──
  let ts1 = 0, pos1 = 0;  // UT Bot 1 (Key=2, ATR=1)
  let ts2 = 0, pos2 = 0;  // UT Bot 2 (Key=3, ATR=300)
  let inPosition = false;

  let lastSignal = "WAIT", lastTrade = null, lastReason = "No signal";

  for (let i = 1; i < N; i++) {
    let sig = "WAIT", trade = null, reason = "No signal";

    // ── UT Bot 1 (Key=2, ATR=1) ──
    if (atr1[i] != null) {
      const nLoss1 = 2 * atr1[i];
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
    }

    // ── UT Bot 2 (Key=3, ATR=300) ──
    if (atr300[i] != null) {
      const nLoss2 = 3 * atr300[i];
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
    }

    // ── Supertrend direction ──
    const stBullish = stDir[i] === 1;

    // ── VWAP gate: close must be above VWAP (if VWAP is 0, gate is bypassed) ──
    const aboveVwap = vwap[i] === 0 || C[i] > vwap[i];

    // ── BUY: ST bullish + Both UT Bots bullish + close > VWAP ──
    if (!inPosition && stBullish && pos1 === 1 && pos2 === 1 && aboveVwap) {
      inPosition = true;
      sig = "BUY"; trade = "ENTRY";
      reason = "Both UT Bots bullish (UT1 + UT2) + ST bullish + above VWAP";
    }

    // ── SELL: Either UT Bot flips bearish ──
    if (inPosition && (pos1 !== 1 || pos2 !== 1)) {
      inPosition = false;
      sig = "SELL"; trade = "EXIT";
      reason = pos1 !== 1 ? "UT Bot 1 no longer bullish" : "UT Bot 2 no longer bullish";
    }

    lastSignal = sig; lastTrade = trade; lastReason = reason;
  }

  return {
    signal: lastSignal,
    trade: lastTrade,
    reason: lastReason,
    utBot1Trail: ts1,
    utBot2Trail: ts2,
    supertrend: stLine[N - 1],
    stDirection: stDir[N - 1],
    utBot1Pos: pos1,
    utBot2Pos: pos2,
    vwap: vwap[N - 1],
    close: C[N - 1]
  };
}

module.exports = { sumeshMandanStrategy };
