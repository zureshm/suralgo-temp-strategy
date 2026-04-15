// =============================================================================
// TrippleUTBotStrategy — 2x classic UT Bot + 1x UT Bot Alerts + Supertrend
// UT Bot 1: Classic — Key=2, ATR=1  (fast entry)
// UT Bot 2: Classic — Key=2, ATR=300 (slow exit)
// UT Bot 3: UT Bot Alerts — Key=3, ATR=10 (strict catchup entry)
// BUY:  ST bullish + (UT1 direct, OR UT2 direct, OR UT3 catchup if UT1+UT2 bullish)
// SELL: UT Bot 1 OR UT Bot 2 SELL signal (whichever first)
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

function trippleUTBotStrategy(candles) {
  if (!candles || candles.length < 35) {
    return { signal: "WAIT", trade: null, reason: "Not enough data" };
  }

  const O = candles.map(c => Number(c.open));
  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));
  const N = C.length;

  // ATR series for all UT Bots
  const atr1   = atrSeries(H, L, C, 1);   // UT Bot 1: fast
  const atr300 = atrSeries(H, L, C, 300); // UT Bot 2: slow
  const atr10  = atrSeries(H, L, C, 10);  // UT Bot 3: UT Bot Alerts

  // Supertrend (ATR Length 10, Factor 3)
  const { supertrend: stLine, direction: stDir } = supertrendSeries(H, L, C, 10, 3);

  // ── UT Bot state ──
  let ts1 = 0, pos1 = 0;  // UT Bot 1 (Key=2, ATR=1)
  let ts2 = 0, pos2 = 0;  // UT Bot 2 (Key=2, ATR=300)
  let ts3 = 0, pos3 = 0;  // UT Bot 3 — UT Bot Alerts (Key=3, ATR=10)
  let inPosition = false;

  let lastSignal = "WAIT", lastTrade = null, lastReason = "No signal";

  for (let i = 1; i < N; i++) {
    let sig = "WAIT", trade = null, reason = "No signal";

    // ── UT Bot 1 (Key=2, ATR=1) — faithful Pine UT Bot 2 logic ──
    let buy1 = false, sell1 = false;
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

      buy1  = pos1 === 1  && prevPos1 !== 1;
      sell1 = pos1 === -1 && prevPos1 !== -1;
    }

    // ── UT Bot 2 (Key=2, ATR=300) — faithful Pine UT Bot 2 logic ──
    let buy2 = false, sell2 = false;
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

      buy2  = pos2 === 1  && prevPos2 !== 1;
      sell2 = pos2 === -1 && prevPos2 !== -1;
    }

    // ── UT Bot 3 — UT Bot Alerts (Key=3, ATR=10) ──
    let buy3 = false, sell3 = false;
    if (atr10[i] != null) {
      const nLoss3 = 3 * atr10[i];
      const prevTS3 = ts3;

      if (C[i] > prevTS3 && C[i - 1] > prevTS3) {
        ts3 = Math.max(prevTS3, C[i] - nLoss3);
      } else if (C[i] < prevTS3 && C[i - 1] < prevTS3) {
        ts3 = Math.min(prevTS3, C[i] + nLoss3);
      } else if (C[i] > prevTS3) {
        ts3 = C[i] - nLoss3;
      } else {
        ts3 = C[i] + nLoss3;
      }

      const prevPos3 = pos3;
      if (C[i - 1] < prevTS3 && C[i] > ts3) pos3 = 1;
      else if (C[i - 1] > prevTS3 && C[i] < ts3) pos3 = -1;

      buy3  = pos3 === 1  && prevPos3 !== 1;
      sell3 = pos3 === -1 && prevPos3 !== -1;
    }

    // ── Supertrend direction ──
    const stBullish = stDir[i] === 1;

    // ── BUY: ST bullish + one of three entry paths ──
    // 1) UT Bot 1 direct buy
    // 2) UT Bot 2 direct buy
    // 3) UT Bot 3 catchup buy (when UT1 already bullish)
    if (!inPosition && stBullish && (buy1 || buy2 || (buy3 && pos1 === 1))) {
      inPosition = true;
      sig = "BUY"; trade = "ENTRY";
      reason = buy1 ? "UT Bot 1 buy + ST bullish"
             : buy2 ? "UT Bot 2 buy + ST bullish"
             : "UT Bot 3 catchup (UT1 bullish) + ST bullish";
    }

    // ── SELL: UT Bot 1 OR UT Bot 2 SELL signal (whichever first) ──
    if (inPosition && (sell1 || sell2)) {
      inPosition = false;
      sig = "SELL"; trade = "EXIT";
      reason = sell1 ? "UT Bot 1 sell" : "UT Bot 2 sell";
    }

    lastSignal = sig; lastTrade = trade; lastReason = reason;
  }

  return {
    signal: lastSignal,
    trade: lastTrade,
    reason: lastReason,
    supertrend: stLine[N - 1],
    stDirection: stDir[N - 1],
    utBot1Trail: ts1,
    utBot2Trail: ts2,
    utBot3Trail: ts3,
    close: C[N - 1]
  };
}

module.exports = { trippleUTBotStrategy };
