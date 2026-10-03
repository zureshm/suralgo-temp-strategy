// =============================================================================
// UTGPTStrategy3 — Quint UT Bot Strategy with EMA-gated Re-entry (Heikin-Ashi)
// (Replica of SumeshStrategy)
//
// INDICATORS & CONFIGURATION:
//   - GREEN  (UT Bot 1): Key Value = 2, ATR Period = 10
//   - BLUE   (UT Bot 2): Key Value = 3, ATR Period = 10
//   - CYAN   (UT Bot 3): Key Value = 2, ATR Period = 300
//   - PURPLE (UT Bot 4): Key Value = 1, ATR Period = 10
//   - TEAL   (UT Bot 5): Key Value = 4, ATR Period = 10
//   - GOLD   (UT Bot 6): Key Value = 3, ATR Period = 300
//   - SILVER (UT Bot 7): Key Value = 1, ATR Period = 300
//   - 10EMA and 30EMA calculated on Heikin-Ashi close.
//
// Candles are converted to Heikin-Ashi before UT Bot and EMA calculation.
//
// BUY:      TEAL flips bullish,
//           OR BLUE flips bullish,
//           OR BLUE already bullish and GREEN flips bullish,
//           OR BLUE & GREEN already bullish and CYAN flips bullish.
// BOOMBUY:  BLUE and TEAL already bullish, and GOLD flips bullish,
//           within 4 candles of the latest BLUE or TEAL bullish flip
//           (proximity — avoids late GOLD flips at trend top).
//           OR (SILVER variant): GREEN, BLUE, CYAN and PURPLE all bullish,
//           SILVER flips bullish, 10EMA is above 30EMA, and the SILVER flip
//           candle's HA low is above 30EMA (not touching/crossing).
// SELL:     CYAN or GREEN or BLUE flips bearish → immediate SELL.
//           PURPLE flips bearish → conditional:
//             - If candle HA low ≤ 30EMA (touching/crossing) → immediate SELL.
//             - If NOT touching 30EMA → pending PURPLE sell stored in memory.
//               Subsequent candles are watched until any signal fires or PURPLE
//               flips bullish:
//               (a) candle HA low ≤ 30EMA → confirm SELL.
// REENTER:  Both GREEN and BLUE and CYAN are bullish, and PURPLE becomes bullish,
//           AND 10EMA is already above 30EMA (upward cross has occurred),
//           AND the PURPLE flip candle's HA low is not below 30EMA (strict).
//
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

// ── EMA (Exponential Moving Average) ─────────────────────────────────────────
function emaSeries(src, period) {
  const out = new Array(src.length).fill(null);
  if (src.length < period) return out;
  const k = 2 / (period + 1);
  let s = 0;
  for (let i = 0; i < period; i++) s += src[i];
  out[period - 1] = s / period;
  for (let i = period; i < src.length; i++) out[i] = src[i] * k + out[i - 1] * (1 - k);
  return out;
}

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

function utGptStrategy3(candles) {
  if (!candles || candles.length < 100) {
    return { signal: "WAIT", reason: "Not enough data (need 100+)" };
  }

  // ── Convert to Heikin-Ashi ──
  const ha = [];
  for (let i = 0; i < candles.length; i++) {
    const o = Number(candles[i].open);
    const h = Number(candles[i].high);
    const l = Number(candles[i].low);
    const c = Number(candles[i].close);
    const haClose = (o + h + l + c) / 4;
    const haOpen  = i === 0 ? (o + c) / 2 : (ha[i - 1].open + ha[i - 1].close) / 2;
    const haHigh  = Math.max(h, haOpen, haClose);
    const haLow   = Math.min(l, haOpen, haClose);
    ha.push({ open: haOpen, high: haHigh, low: haLow, close: haClose });
  }

  const H = ha.map(c => c.high);
  const L = ha.map(c => c.low);
  const C = ha.map(c => c.close);
  const N = C.length;

  const green  = utBotSeries(H, L, C, 2, 10); // GREEN  (Key=2, ATR=10)
  const blue   = utBotSeries(H, L, C, 3, 10); // BLUE   (Key=3, ATR=10)
  const cyan   = utBotSeries(H, L, C, 2, 300); // CYAN   (Key=2, ATR=300)
  const purple = utBotSeries(H, L, C, 1, 10); // PURPLE (Key=1, ATR=10)
  const teal   = utBotSeries(H, L, C, 4, 10); // TEAL   (Key=4, ATR=10)
  const gold   = utBotSeries(H, L, C, 3, 300); // GOLD   (Key=3, ATR=300)
  const silver = utBotSeries(H, L, C, 1, 300); // SILVER (Key=1, ATR=300)

  const ema10 = emaSeries(C, 10); // 10EMA on Heikin-Ashi close
  const ema30 = emaSeries(C, 30); // 30EMA on Heikin-Ashi close

  let lastSignal = "WAIT", lastReason = "No signal";
  let trending = false;

  // Pending PURPLE sell state
  let pendingPurpleSell = { active: false, high: 0, low: 0 };

  // BOOMBUY gate: only armed after a fresh BLUE bullish flip, disarmed after firing
  let boomBuyArmed = false;

  // Proximity tracking: candle index of latest BLUE/TEAL bullish flip
  let lastBlueFlipBuyIdx = -Infinity;
  let lastTealFlipBuyIdx = -Infinity;

  for (let i = 1; i < N; i++) {
    const blueBull  = blue.pos[i] === 1;
    const greenBull = green.pos[i] === 1;
    const cyanBull   = cyan.pos[i] === 1;
    const purpleBull = purple.pos[i] === 1;
    const tealBull   = teal.pos[i] === 1;
    const goldBull   = gold.pos[i] === 1;
    const silverBull = silver.pos[i] === 1;

    const blueFlipBuy   = blue.pos[i] === 1 && blue.pos[i - 1] !== 1;
    const greenFlipBuy  = green.pos[i] === 1 && green.pos[i - 1] !== 1;
    const cyanFlipBuy   = cyan.pos[i] === 1 && cyan.pos[i - 1] !== 1;
    const tealFlipBuy   = teal.pos[i] === 1 && teal.pos[i - 1] !== 1;
    const goldFlipBuy   = gold.pos[i] === 1 && gold.pos[i - 1] !== 1;
    const silverFlipBuy = silver.pos[i] === 1 && silver.pos[i - 1] !== 1;

    const blueFlipSell  = blue.pos[i] === -1 && blue.pos[i - 1] !== -1;
    const greenFlipSell = green.pos[i] === -1 && green.pos[i - 1] !== -1;
    const cyanFlipSell  = cyan.pos[i] === -1 && cyan.pos[i - 1] !== -1;

    const purpleFlipBuy = purple.pos[i] === 1 && purple.pos[i - 1] !== 1;
    const purpleFlipSell = purple.pos[i] === -1 && purple.pos[i - 1] !== -1;

    // EMA values for this candle
    const e10 = ema10[i];
    const e30 = ema30[i];
    const emaCrossedUp = e10 != null && e30 != null && e10 > e30;
    const haLowVsEma30 = e30 != null ? L[i] >= e30 : false; // strict: HA low must be at or above 30EMA
    const haLowAboveEma30 = e30 != null ? L[i] > e30 : false; // stricter: HA low above 30EMA (not touching)
    const touchesEma30  = e30 != null ? L[i] <= e30 : false; // candle touches or crosses below 30EMA

    // TRENDING: true when all 7 UT Bots are bullish on this candle
    trending = blueBull && greenBull && cyanBull && purpleBull && tealBull && goldBull && silverBull;

    // Arm BOOMBUY on fresh BLUE bullish flip, and record flip indices for proximity
    if (blueFlipBuy) { boomBuyArmed = true; lastBlueFlipBuyIdx = i; }
    if (tealFlipBuy) lastTealFlipBuyIdx = i;

    let sig = "WAIT", reason = "No signal";

    // ── SELL: CYAN or GREEN or BLUE flips bearish (immediate) ──
    if (cyanFlipSell || greenFlipSell || blueFlipSell) {
      sig = "SELL";
      const flips = [];
      if (cyanFlipSell) flips.push("CYAN");
      if (greenFlipSell) flips.push("GREEN");
      if (blueFlipSell) flips.push("BLUE");
      reason = flips.join(" & ") + " flip bearish";
      pendingPurpleSell = { active: false, high: 0, low: 0 }; // clear pending
    }
    // ── SELL: PURPLE flips bearish (conditional on 30EMA) ──
    // Note: PURPLE bullish flip cancels pending BEFORE this block (checked below)
    else if (purpleFlipSell && !purpleFlipBuy) {
      if (touchesEma30) {
        sig = "SELL";
        reason = "PURPLE flip bearish, candle touches 30EMA";
        pendingPurpleSell = { active: false, high: 0, low: 0 };
      } else {
        // Not touching 30EMA → store pending, wait for confirmation
        pendingPurpleSell = { active: true, high: H[i], low: L[i] };
      }
    }
    // ── Pending PURPLE SELL confirmation ──
    // Only checked if PURPLE did NOT flip bullish this candle
    else if (pendingPurpleSell.active && !purpleFlipBuy) {
      if (touchesEma30) {
        sig = "SELL";
        reason = "Pending PURPLE sell confirmed: candle touches 30EMA";
        pendingPurpleSell = { active: false, high: 0, low: 0 };
      }
    }

    // ── BOOMBUY: BLUE & TEAL already bullish, GOLD flips bullish ──
    //           + boomBuyArmed (requires a fresh BLUE bullish flip since last BOOMBUY)
    //           + within 4 candles of the latest BLUE or TEAL bullish flip (proximity)
    const goldInProximity = (i - lastBlueFlipBuyIdx <= 4) || (i - lastTealFlipBuyIdx <= 4);
    if (sig === "WAIT" && blueBull && tealBull && goldFlipBuy && boomBuyArmed && goldInProximity) {
      sig = "BOOMBUY";
      reason = "GOLD flip bullish (K3/ATR300) while BLUE & TEAL bullish";
      boomBuyArmed = false;
    }
    // ── BOOMBUY (SILVER): GREEN & BLUE & CYAN & PURPLE bullish, SILVER flips bullish ──
    //           + 10EMA above 30EMA
    //           + SILVER flip candle HA low above 30EMA (not touching/crossing)
    else if (sig === "WAIT" && greenBull && blueBull && cyanBull && purpleBull && silverFlipBuy && emaCrossedUp && haLowAboveEma30) {
      sig = "BOOMBUY";
      reason = "SILVER flip bullish (K1/ATR300) while GREEN & BLUE & CYAN & PURPLE bullish, 10EMA>30EMA, HA low above 30EMA";
    }
    // ── BUY: TEAL flips bullish ──
    else if (sig === "WAIT" && tealFlipBuy) {
      sig = "BUY";
      reason = "TEAL flip bullish (K4/ATR10)";
    }
    // ── BUY: BLUE flips bullish ──
    else if (sig === "WAIT" && blueFlipBuy) {
      sig = "BUY";
      reason = "BLUE flip bullish (K3/ATR10)";
    }
    // ── BUY: BLUE already bullish, GREEN flips bullish ──
    else if (sig === "WAIT" && blueBull && greenFlipBuy) {
      sig = "BUY";
      reason = "GREEN flip bullish (K2/ATR10) while BLUE bullish";
    }
    // ── BUY: BLUE & GREEN already bullish, CYAN flips bullish ──
    else if (sig === "WAIT" && blueBull && greenBull && cyanFlipBuy) {
      sig = "BUY";
      reason = "CYAN flip bullish (K2/ATR300) while BLUE & GREEN bullish";
    }
    // ── REENTER: BLUE & GREEN & CYAN bullish, PURPLE flips bullish ──
    //           + 10EMA above 30EMA (upward cross already occurred)
    //           + PURPLE flip candle HA low not below 30EMA (strict)
    else if (sig === "WAIT" && blueBull && greenBull && cyanBull && purpleFlipBuy && emaCrossedUp && haLowVsEma30) {
      sig = "REENTER";
      reason = "PURPLE re-entry flip bullish (K1/ATR10) while BLUE & GREEN & CYAN bullish, 10EMA>30EMA, HA low above 30EMA";
    }

    // Clear pending PURPLE sell if any BUY/BOOMBUY/REENTER signal fired, or PURPLE flipped bullish
    if (sig === "BUY" || sig === "BOOMBUY" || sig === "REENTER" || purpleFlipBuy) {
      pendingPurpleSell = { active: false, high: 0, low: 0 };
    }

    lastSignal = sig;
    lastReason = reason;
  }

  return {
    signal: lastSignal,
    reason: lastReason,
    trending,
    greenPos: green.pos[N - 1],
    bluePos: blue.pos[N - 1],
    cyanPos: cyan.pos[N - 1],
    purplePos: purple.pos[N - 1],
    tealPos: teal.pos[N - 1],
    goldPos: gold.pos[N - 1],
    silverPos: silver.pos[N - 1],
    greenTrail: green.trail[N - 1],
    blueTrail: blue.trail[N - 1],
    cyanTrail: cyan.trail[N - 1],
    purpleTrail: purple.trail[N - 1],
    tealTrail: teal.trail[N - 1],
    goldTrail: gold.trail[N - 1],
    silverTrail: silver.trail[N - 1],
    ema10: ema10[N - 1],
    ema30: ema30[N - 1],
    close: C[N - 1]
  };
}

module.exports = { utGptStrategy3 };
