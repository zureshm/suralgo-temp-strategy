// =============================================================================
// UTGPTStrategy — chatGptStrategy gated by UT Bot 1 + Supertrend(10, 3)
//
// Pre-conditions for BUY (both required):
//   1) UT Bot 1 (Classic, Key=2, ATR=1) in bullish state (pos1 === 1).
//   2) Supertrend (ATR=10, Factor=3) bullish (direction === 1).
//   Only when both are bullish will the chatGpt BUY condition be evaluated.
//
// Additional BUY path (combo):
//   If UT Bot 1 is bullish AND Supertrend is bullish, and either flipped to
//   bullish on the latest candle, fire BUY immediately (independent of the
//   chatGpt EMA/MACD conditions).
//
// SELL:
//   If UT Bot 1 flips to SELL on the latest candle, SELL immediately (takes
//   priority over the default chatGpt SELL). Otherwise fall back to the
//   chatGpt SELL condition.
// =============================================================================

// ── chatGpt helpers (unchanged) ──────────────────────────────────────────────

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

// ── UT Bot 1 helpers (Classic, Key=2, ATR=1) ────────────────────────────────

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

// Returns { pos: final pos1, flippedBuy: bool, flippedSell: bool }
// flippedBuy/Sell indicate whether UT Bot 1 flipped on the LAST candle.
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

function utGptStrategy(candles) {
  if (!candles || candles.length < 30) {
    return { signal: "WAIT", ema10: null, ema20: null };
  }

  const closes = candles.map(c => Number(c.close));
  const lastCandle = candles[candles.length - 1];

  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));

  // UT Bot 1 pre-condition
  const ut1 = computeUTBot1(candles);
  const ut1Bullish = ut1.pos === 1;

  // Supertrend(10, 3) pre-condition
  const { supertrend: stLine, direction: stDir } = supertrendSeries(H, L, C, 10, 3);
  const stLast = stDir[stDir.length - 1];
  const stPrev = stDir.length >= 2 ? stDir[stDir.length - 2] : 0;
  const stBullish = stLast === 1;
  const stFlippedBuy = stLast === 1 && stPrev !== 1;

  // EMA
  const prevCloses = closes.slice(0, closes.length - 1);
  const ema10_prev = calculateEMA(10, prevCloses);
  const ema20_prev = calculateEMA(20, prevCloses);
  const ema10_now = calculateEMA(10, closes);
  const ema20_now = calculateEMA(20, closes);

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
  const isRed = Number(lastCandle.close) < Number(lastCandle.open);

  // ── Combo BUY: UT Bot 1 + Supertrend both bullish, with a fresh flip ──
  if (
    ut1Bullish &&
    stBullish &&
    (ut1.flippedBuy || stFlippedBuy)
  ) {
    return {
      signal: "BUY",
      reason: ut1.flippedBuy
        ? "UT Bot 1 buy flip + Supertrend bullish"
        : "Supertrend buy flip + UT Bot 1 bullish",
      ema10: ema10_now,
      ema20: ema20_now,
      utBot1Pos: ut1.pos,
      utBot1Trail: ut1.trail,
      stDirection: stLast,
      supertrend: stLine[stLine.length - 1]
    };
  }

  // ── SELL priority: UT Bot 1 SELL flip on the latest candle ──
  if (ut1.flippedSell) {
    return {
      signal: "SELL",
      reason: "UT Bot 1 sell flip (Key=2, ATR=1)",
      ema10: ema10_now,
      ema20: ema20_now,
      utBot1Pos: ut1.pos,
      utBot1Trail: ut1.trail,
      stDirection: stDir[stDir.length - 1],
      supertrend: stLine[stLine.length - 1]
    };
  }

  // ── BUY: requires UT Bot 1 bullish + Supertrend bullish + chatGpt BUY ──
  if (
    ut1Bullish &&
    stBullish &&
    ema10_prev <= ema20_prev &&
    ema10_now > ema20_now &&
    macdLine > signalLine &&
    !sideways &&
    isGreen
  ) {
    return {
      signal: "BUY",
      reason: "chatGpt BUY + UT Bot 1 bullish + Supertrend bullish",
      ema10: ema10_now,
      ema20: ema20_now,
      utBot1Pos: ut1.pos,
      utBot1Trail: ut1.trail,
      stDirection: stDir[stDir.length - 1],
      supertrend: stLine[stLine.length - 1]
    };
  }

  // ── Default SELL: chatGpt SELL conditions ──
  if (
    ema10_prev >= ema20_prev &&
    ema10_now < ema20_now &&
    macdLine < signalLine &&
    !sideways &&
    isRed
  ) {
    return {
      signal: "SELL",
      reason: "chatGpt SELL",
      ema10: ema10_now,
      ema20: ema20_now,
      utBot1Pos: ut1.pos,
      utBot1Trail: ut1.trail,
      stDirection: stDir[stDir.length - 1],
      supertrend: stLine[stLine.length - 1]
    };
  }

  return {
    signal: "WAIT",
    ema10: ema10_now,
    ema20: ema20_now,
    utBot1Pos: ut1.pos,
    utBot1Trail: ut1.trail,
    stDirection: stDir[stDir.length - 1],
    supertrend: stLine[stLine.length - 1]
  };
}

module.exports = { utGptStrategy };
