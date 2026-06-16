// =============================================================================
// UTGPTStrategy4X — Same as UTGPTStrategy4 but SELL only on Blue flips bearish.
//                   Green/Cyan bearish flips are IGNORED for exit.
//
// UTBOT PARAMETERS (Color Legend):
//   - BLUE  = UT Bot 1: Key Value = 3, ATR Period = 20
//   - GREEN = UT Bot 2: Key Value = 2, ATR Period = 14
//   - CYAN  = UT Bot 3: Key Value = 3, ATR Period = 300
//
// Supertrend: ST(10,4) for UT Bot conditions, ST(10,3) for chatGpt condition
// chatGpt: EMA15/30
//
// BUY conditions (same as UTGPTStrategy4):
//   1) Blue flips bullish + ST(10,4) bullish.
//      BUT NOT if Green was already bullish before Blue (previous candles).
//      EXCEPTION 1: Green and Blue both flip bullish on same candle + ST(10,4) bullish → BUY.
//      EXCEPTION 2: Cyan bullish (after Green) when Blue flips + ST(10,4) bullish → BUY.
//   2) Green flips bullish + Blue already bullish + ST(10,4) bullish.
//      (Also covers: Blue & Green flip same candle + ST(10,4) bullish)
//   3) Cyan flips bullish + Blue already bullish + ST(10,4) or ST(10,3) bullish.
//   4) chatGpt triggers bullish + Blue & Green already bullish + ST(10,3) already bullish.
//
// SELL:
//   ONLY Blue UT Bot flips bearish → SELL. Green/Cyan bearish ignored.
// =============================================================================

// ── chatGpt helpers ──────────────────────────────────────────────────────────

function calculateEMA(period, prices) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateMACD(closes) {
  const emaFast = calculateEMA(6, closes);
  const emaSlow = calculateEMA(26, closes);
  const macdLine = emaFast - emaSlow;

  const recent = closes.slice(-9);
  const macdSeries = recent.map((_, i) => {
    const sub = closes.slice(0, closes.length - 9 + i + 1);
    return calculateEMA(6, sub) - calculateEMA(26, sub);
  });

  const signalLine = calculateEMA(9, macdSeries);
  return { macdLine, signalLine };
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = Number(candles[i].high);
    const low = Number(candles[i].low);
    const prevClose = Number(candles[i - 1].close);
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    sum += tr;
  }
  return sum / period;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

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

// ── Supertrend ─────────────────────────────────────────────────────────────────

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

// ── UT Bot 1 / Blue (Key=3, ATR=20) ─────────────────────────────────────────

function computeUTBot1(candles) {
  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));
  const N = C.length;
  const atr20 = atrSeries(H, L, C, 20);

  let ts = 0, pos = 0;
  let flippedBuy = false, flippedSell = false;

  for (let i = 1; i < N; i++) {
    if (atr20[i] == null) continue;
    const nLoss = 3 * atr20[i];
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

// ── UT Bot 2 / Green (Key=2, ATR=14) ────────────────────────────────────────

function computeUTBot2(candles) {
  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));
  const N = C.length;
  const atr14 = atrSeries(H, L, C, 14);

  let ts = 0, pos = 0;
  let flippedBuy = false, flippedSell = false;

  for (let i = 1; i < N; i++) {
    if (atr14[i] == null) continue;
    const nLoss = 2 * atr14[i];
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

// ── UT Bot 3 / Cyan (Key=3, ATR=300) ────────────────────────────────────────

function computeUTBot3(candles) {
  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));
  const N = C.length;
  const atr300 = atrSeries(H, L, C, 300);

  let ts = 0, pos = 0;
  let flippedBuy = false, flippedSell = false;

  for (let i = 1; i < N; i++) {
    if (atr300[i] == null) continue;
    const nLoss = 3 * atr300[i];
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

// ── Main strategy ────────────────────────────────────────────────────────────

function utGptStrategy4X(candles) {
  if (!candles || candles.length < 310) {
    return { signal: "WAIT", ema10: null, ema20: null };
  }

  const closes = candles.map(c => Number(c.close));
  const lastCandle = candles[candles.length - 1];

  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));

  // UT Bot 1 / Blue (Key=3, ATR=20)
  const ut1 = computeUTBot1(candles);
  const ut1Bullish = ut1.pos === 1;

  // UT Bot 2 / Green (Key=2, ATR=14)
  const ut2 = computeUTBot2(candles);
  const ut2Bullish = ut2.pos === 1;

  // UT Bot 3 / Cyan (Key=3, ATR=300)
  const ut3 = computeUTBot3(candles);
  const ut3Bullish = ut3.pos === 1;

  // Supertrend(10, 4) — used by UT Bot BUY conditions
  const { supertrend: st4Line, direction: st4Dir } = supertrendSeries(H, L, C, 10, 4);
  const st4Last = st4Dir[st4Dir.length - 1];
  const st4Bullish = st4Last === 1;

  // Supertrend(10, 3) — used by chatGpt BUY condition only
  const { supertrend: st3Line, direction: st3Dir } = supertrendSeries(H, L, C, 10, 3);
  const st3Last = st3Dir[st3Dir.length - 1];
  const st3Bullish = st3Last === 1;

  // EMA 15/30
  const prevCloses = closes.slice(0, closes.length - 1);
  const ema10_prev = calculateEMA(15, prevCloses);
  const ema20_prev = calculateEMA(30, prevCloses);
  const ema10_now = calculateEMA(15, closes);
  const ema20_now = calculateEMA(30, closes);

  // MACD
  const { macdLine, signalLine } = calculateMACD(closes);

  // ATR sideways filter
  const atr = calculateATR(candles);
  let sideways = false;
  if (atr !== null) {
    const recentHigh = Math.max(...candles.slice(-14).map(c => Number(c.high)));
    const recentLow = Math.min(...candles.slice(-14).map(c => Number(c.low)));
    const range = recentHigh - recentLow;
    sideways = range < atr * 2;
  }

  const isGreen = Number(lastCandle.close) > Number(lastCandle.open);

  // chatGpt derived states
  const chatGptBullishState = ema10_now > ema20_now;
  const chatGptJustTriggered = (
    ema10_prev <= ema20_prev &&
    ema10_now > ema20_now &&
    macdLine > signalLine &&
    !sideways &&
    isGreen
  );

  // Helper for return object
  const makeResult = (signal, reason) => ({
    signal,
    reason,
    ema10: ema10_now,
    ema20: ema20_now,
    utBot1Pos: ut1.pos, utBot1Trail: ut1.trail,
    utBot2Pos: ut2.pos, utBot2Trail: ut2.trail,
    utBot3Pos: ut3.pos, utBot3Trail: ut3.trail,
    st4Direction: st4Last,
    supertrend4: st4Line[st4Line.length - 1],
    st3Direction: st3Last,
    supertrend3: st3Line[st3Line.length - 1]
  });

  // ── SELL: ONLY Blue UT Bot flips bearish ──
  if (ut1.flippedSell) {
    return makeResult("SELL", "UT Bot sell flip: Blue (K3/ATR20)");
  }

  // ── BUY Path 1: Blue flips bullish + ST(10,4) bullish ──
  // NOT BUY if Green was already bullish before Blue (previous candles).
  // EXCEPTION 1: Green and Blue both flip same candle → BUY.
  // EXCEPTION 2: Cyan bullish (after Green) when Blue flips → BUY.
  if (st4Bullish && ut1.flippedBuy) {
    if (ut2Bullish && !ut2.flippedBuy && !ut3Bullish) {
      // Green was already bullish before Blue AND Cyan not bullish → NOT BUY (skip)
    } else {
      let reason;
      if (ut2.flippedBuy) reason = "Blue + Green flip together (same candle) + ST(10,4) bullish";
      else if (ut2Bullish && ut3Bullish) reason = "Blue flip + Cyan bullish (override Green pre-bullish) + ST(10,4) bullish";
      else reason = "Blue flip (K3/ATR20) + ST(10,4) bullish";
      return makeResult("BUY", reason);
    }
  }

  // ── BUY Path 2: Green flips bullish + Blue already bullish + ST(10,4) bullish ──
  // (Also covers: Blue & Green flip same candle, since ut1Bullish is true after flip)
  if (st4Bullish && ut1Bullish && ut2.flippedBuy) {
    return makeResult("BUY", "Green flip (K2/ATR14) + Blue bullish + ST(10,4) bullish");
  }

  // ── BUY Path 3: Cyan flips bullish + Blue already bullish + ST(10,4) or ST(10,3) bullish ──
  if ((st4Bullish || st3Bullish) && ut1Bullish && ut3.flippedBuy) {
    const stUsed = st4Bullish ? "ST(10,4)" : "ST(10,3)";
    return makeResult("BUY", `Cyan flip (K3/ATR300) + Blue bullish + ${stUsed} bullish`);
  }

  // ── BUY Path 4: chatGpt triggers + Blue & Green already bullish + ST(10,3) already bullish ──
  if (ut1Bullish && ut2Bullish && st3Bullish && chatGptJustTriggered) {
    return makeResult("BUY", "chatGpt trigger (EMA15>30) + Blue & Green bullish + ST(10,3) bullish");
  }

  return makeResult("WAIT", "No signal");
}

module.exports = { utGptStrategy4X };
