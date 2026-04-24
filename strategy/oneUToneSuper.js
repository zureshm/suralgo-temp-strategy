// =============================================================================
// oneUToneSuper — One UT Bot + One Supertrend
//
// Indicators:
//   1) UT Bot 1 (Classic, Key=2, ATR=1)
//   2) Supertrend (ATR=10, Factor=3)
//
// BUY:
//   Fire BUY the moment UT Bot 1 bullish AND Supertrend bullish align.
//   Either one can become bullish first; BUY triggers on the candle where the
//   second one turns bullish (i.e., the alignment just happened on this
//   candle). This guarantees no BUY spam while alignment persists.
//
// SELL:
//   Fire SELL when UT Bot 1 flips to SELL on the latest candle.
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

// ── UT Bot 1 (Classic, Key=2, ATR=1) ────────────────────────────────────────
// Returns last pos and flip flags on the last candle.
function computeUTBot1(candles) {
  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));
  const N = C.length;
  const atr1 = atrSeries(H, L, C, 1);

  let ts = 0, pos = 0;
  let flippedBuy = false, flippedSell = false;

  for (let i = 1; i < N; i++) {
    if (atr1[i] == null) continue;
    const nLoss = 2 * atr1[i];
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
    if (C[i - 1] < prevTS && C[i] > ts) pos = 1;
    else if (C[i - 1] > prevTS && C[i] < ts) pos = -1;

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

function oneUToneSuperStrategy(candles) {
  if (!candles || candles.length < 15) {
    return { signal: "WAIT", reason: "Not enough data" };
  }

  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));
  const N = C.length;

  // UT Bot 1
  const ut1 = computeUTBot1(candles);
  const ut1Bullish = ut1.pos === 1;

  // Supertrend(10, 3)
  const { supertrend: stLine, direction: stDir } = supertrendSeries(H, L, C, 10, 3);
  const stLast = stDir[N - 1];
  const stPrev = N >= 2 ? stDir[N - 2] : 0;
  const stBullish = stLast === 1;
  const stFlippedBuy = stLast === 1 && stPrev !== 1;

  const base = {
    utBot1Pos: ut1.pos,
    utBot1Trail: ut1.trail,
    stDirection: stLast,
    supertrend: stLine[N - 1],
    close: C[N - 1]
  };

  // ── SELL: UT Bot 1 flips to SELL on the latest candle ──
  if (ut1.flippedSell) {
    return {
      signal: "SELL",
      reason: "UT Bot 1 sell flip (Key=2, ATR=1)",
      ...base
    };
  }

  // ── BUY: UT1 bullish AND Supertrend bullish align on this candle ──
  // Fires on the candle where the alignment becomes true:
  //   - UT Bot 1 just flipped to bullish while Supertrend already bullish, OR
  //   - Supertrend just flipped to bullish while UT Bot 1 already bullish.
  if (ut1Bullish && stBullish && (ut1.flippedBuy || stFlippedBuy)) {
    return {
      signal: "BUY",
      reason: ut1.flippedBuy
        ? "UT Bot 1 buy flip + Supertrend bullish"
        : "Supertrend buy flip + UT Bot 1 bullish",
      ...base
    };
  }

  return { signal: "WAIT", reason: "No alignment", ...base };
}

module.exports = { oneUToneSuperStrategy };
