// =============================================================================
// superDoubleUT — Quint UT Bot Strategy with EMA-gated Re-entry (Heikin-Ashi)
//
// INDICATORS & CONFIGURATION:
//   - GREEN  (UT Bot 1): Key Value = 2, ATR Period = 10
//   - BLUE   (UT Bot 2): Key Value = 3, ATR Period = 10
//   - CYAN   (UT Bot 3): Key Value = 2, ATR Period = 300
//   - PURPLE (UT Bot 4): Key Value = 1, ATR Period = 10
//   - TEAL   (UT Bot 5): Key Value = 4, ATR Period = 10
//   - INFRAGREEN (UT Bot 6): Key Value = 0.3, ATR Period = 10 (Auto-reentry trigger)
//   - 10EMA and 30EMA calculated on Heikin-Ashi close.
//   - MACD (12, 24, 9) on Heikin-Ashi close
//   - WMA30 / WMA60 on Heikin-Ashi close
//
// Candles are converted to Heikin-Ashi before UT Bot and EMA calculation.
//
// POSITIVE CONDITIONS — gate every BUY and REENTER (per TIME WINDOWS below):
//   MACD      = ON   // MACD line above Signal line (crossed upwards)
//                    // Enforced only between 10:00 and 14:00
//   MACD_NOTANGLING = ON  // rejected if a downward cross happened within last
//                    // 10 candles while MACD > 0 AND MACD line dipped below
//                    // MACD_TANGLE_FLOOR (8) at the cross
//                    // (tangling = choppy market, lookback counted from signal candle)
//                    // Required wherever MACD is required — EXCEPT TEAL flips:
//                    // TEAL ignores the tangle check (MACD = ON alone is enough).
//                    // Enforced only between 10:00 and 14:00
//   WMA_CROSS = ON   // WMA30 above WMA60 (crossed upwards)
//                    // Enforced only between 10:00 and 14:00
//   TIME WINDOWS:
//     Before 10:00 → either the MACD side or WMA_CROSS = ON (at least one).
//                    MACD side = MACD + MACD_NOTANGLING for all branches
//                    EXCEPT TEAL, where it is MACD alone.
//     10:00–14:00  → both enforced (same TEAL exception for NOTANGLING)
//     After 14:00  → both auto-pass
//
// BUY:      BLUE flips bullish,
//           OR BLUE already bullish and GREEN flips bullish,
//           OR BLUE & GREEN already bullish and CYAN flips bullish
//           (only before 9:40 AM, and 10EMA > 30EMA),
//           OR TEAL flips bullish (requires 10EMA > 30EMA strict AND
//           10EMA rising vs 5 candles ago).
//           BLUE, GREEN, CYAN and REENTER require MACD + MACD_NOTANGLING + WMA
//           per the TIME WINDOWS. TEAL requires MACD + WMA only —
//           MACD_NOTANGLING does NOT apply to TEAL.
// SELL:     CYAN or GREEN or BLUE flips bearish → immediate SELL.
//           PURPLE flips bearish → conditional:
//             - If candle HA low ≤ 30EMA (touching/crossing) → immediate SELL.
//             - If NOT touching 30EMA → pending PURPLE sell stored in memory.
//               Subsequent candles are watched until any signal fires or PURPLE
//               flips bullish:
//               (a) candle HA low ≤ 30EMA → confirm SELL.
//               (b) candle HA high < pending HIGH AND HA low < pending LOW
//                   (lower high + lower low) → confirm SELL.
// REENTER:  INFRAGREEN is the last to join — its most recent bullish flip
//           happened while GREEN and BLUE were already bullish (window = while
//           it stays bullish), AND close > highest HA close
//           of previous 30 candles + 5 pts (excl. current candle), AND
//           10EMA > 30EMA (strict), AND 10EMA rising vs 5 candles ago.
//           If a BUY trigger was blocked by the MACD/WMA gate within the last
//           FAILED_BUY_MEMORY (20) candles, this fires as BUY instead of REENTER.
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

// ── WMA (Weighted Moving Average) ────────────────────────────────────────────
function wmaSeries(src, period) {
  const out = new Array(src.length).fill(null);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < src.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += src[i - j] * (period - j);
    out[i] = sum / denom;
  }
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

function superDoubleUT(candles) {
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

  const green      = utBotSeries(H, L, C, 2, 10);   // GREEN      (Key=2, ATR=10)
  const blue       = utBotSeries(H, L, C, 3, 10);   // BLUE       (Key=3, ATR=10)
  const cyan       = utBotSeries(H, L, C, 2, 300);  // CYAN       (Key=2, ATR=300)
  const purple     = utBotSeries(H, L, C, 1, 10);   // PURPLE     (Key=1, ATR=10)
  const teal       = utBotSeries(H, L, C, 4, 10);   // TEAL       (Key=4, ATR=10)
  const infraGreen = utBotSeries(H, L, C, 0.3, 10); // INFRAGREEN (Key=0.3, ATR=10)

  const ema10 = emaSeries(C, 10); // 10EMA on Heikin-Ashi close
  const ema30 = emaSeries(C, 30); // 30EMA on Heikin-Ashi close

  // Positive Condition A: MACD(12,24,9) line above Signal line
  const ema12 = emaSeries(C, 12);
  const ema24 = emaSeries(C, 24);
  const macdLine = C.map((_, i) => (ema12[i] != null && ema24[i] != null) ? ema12[i] - ema24[i] : null);
  const macdSignal = emaSeries(macdLine.map(v => v == null ? 0 : v), 9);

  // Positive Condition B: WMA30 above WMA60
  const wma30 = wmaSeries(C, 30);
  const wma60 = wmaSeries(C, 60);

  // MACD tangle filter: a down-cross within this many candles (counted back from
  // the signal candle) marks the current MACD>Signal state as a re-cross → reject.
  const MACD_TANGLE_LOOKBACK = 10;
  const MACD_TANGLE_FLOOR = 8; // tangle only counts if MACD dipped below this value

  // Candle time in minutes (HH:MM) — used by CYAN cutoff, day-boundary and TEAL-after-10AM checks
  const candleMinutes = candles.map(cd => {
    const m = /(\d{1,2}):(\d{2})/.exec(String(cd && cd.time));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  });

  // CYAN BUY cutoff: only allowed before 9:40 AM (candle time)
  const cyanBuyTimeOK = candleMinutes.map(mins => (mins == null ? true : mins < 9 * 60 + 40));

  // Auto re-entry gate config
  const REENTER_PEAK_CANDLES = 30; // highest HA close over previous N candles (excl. current)
  const REENTER_POINTS = 5;        // close must clear the peak by this many points
  const REENTER_EMA_LOOKBACK = 5;  // EMA10 must exceed its value N candles ago

  // Failed-BUY memory: a BUY trigger blocked by the macdWmaOK gate is remembered
  // for this many candles; a REENTER firing inside the window becomes a BUY.
  const FAILED_BUY_MEMORY = 20;

  let lastSignal = "WAIT", lastReason = "No signal";
  let trending = false;
  let condA = false, condB = false, macdTangled = false;

  // Pending PURPLE sell state
  let pendingPurpleSell = { active: false, high: 0, low: 0 };

  // Candle index + branch name of last BUY trigger blocked by the macdWmaOK gate
  let pendingFailedBuyIdx = -Infinity;
  let pendingFailedBuyBranch = "";

  // Candle index of latest INFRAGREEN bullish flip (for the REENTER trigger)
  let lastInfraGreenFlipBuyIdx = -Infinity;

  for (let i = 1; i < N; i++) {
    const blueBull       = blue.pos[i] === 1;
    const greenBull      = green.pos[i] === 1;
    const cyanBull        = cyan.pos[i] === 1;
    const purpleBull      = purple.pos[i] === 1;
    const tealBull        = teal.pos[i] === 1;
    const infraGreenBull  = infraGreen.pos[i] === 1;

    const blueFlipBuy        = blue.pos[i] === 1 && blue.pos[i - 1] !== 1;
    const greenFlipBuy       = green.pos[i] === 1 && green.pos[i - 1] !== 1;
    const cyanFlipBuy        = cyan.pos[i] === 1 && cyan.pos[i - 1] !== 1;
    const tealFlipBuy        = teal.pos[i] === 1 && teal.pos[i - 1] !== 1;
    const infraGreenFlipBuy  = infraGreen.pos[i] === 1 && infraGreen.pos[i - 1] !== 1;

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
    const touchesEma30  = e30 != null ? L[i] <= e30 : false; // candle touches or crosses below 30EMA

    // Auto re-entry gates: peak break (excl. current candle) + EMA10 rising
    const reEntryPeak = i > REENTER_PEAK_CANDLES ? Math.max(...C.slice(i - REENTER_PEAK_CANDLES, i)) : null;
    const priceBreaksPeak = reEntryPeak != null && C[i] > reEntryPeak + REENTER_POINTS;
    const ema10Rising = e10 != null && ema10[i - REENTER_EMA_LOOKBACK] != null && e10 > ema10[i - REENTER_EMA_LOOKBACK];

    // BUY/REENTER gate conditions:
    //   MACD           = ON  → MACD line above Signal line (crossed upwards)
    //   MACD_NOTANGLING = ON → no downward cross within last MACD_TANGLE_LOOKBACK
    //                          candles while MACD > 0 AND MACD dipped below
    //                          MACD_TANGLE_FLOOR at that cross
    //   WMA_CROSS      = ON  → WMA30 above WMA60
    const macdAbove = macdLine[i] != null && macdSignal[i] != null && macdLine[i] > macdSignal[i];
    macdTangled = false;
    if (macdAbove && macdLine[i] > 0) {
      for (let j = Math.max(1, i - MACD_TANGLE_LOOKBACK); j <= i; j++) {
        if (macdLine[j] != null && macdSignal[j] != null && macdLine[j - 1] != null && macdSignal[j - 1] != null
          && macdLine[j] < macdSignal[j] && macdLine[j - 1] >= macdSignal[j - 1]
          && macdLine[j] < MACD_TANGLE_FLOOR) {
          macdTangled = true;
          break;
        }
      }
    }
    // Time-window gating for MACD and WMA:
    //   Before 10:00 → either raw MACD or raw WMA must be ON (at least one)
    //   10:00–14:00  → both enforced
    //   After 14:00  → both auto-pass
    //   Unparseable  → both enforced (conservative)
    const mins = candleMinutes[i];
    const macdEnforced = mins == null || (mins >= 10 * 60 && mins < 14 * 60);
    const wmaEnforced  = macdEnforced; // WMA shares the same 10:00–14:00 window
    const earlyWindow  = mins != null && mins < 10 * 60;

    const rawMacd     = macdAbove;        // MACD = ON
    const rawNoTangle = !macdTangled;     // MACD_NOTANGLING = ON
    const rawWma      = wma30[i] != null && wma60[i] != null && wma30[i] > wma60[i];

    const macdGate = rawMacd && rawNoTangle; // both MACD conditions must hold

    condA = !macdEnforced || macdGate;
    condB = !wmaEnforced  || rawWma;

    const macdWmaOK = earlyWindow
      ? (macdGate || rawWma)    // before 10:00: either one suffices
      : (condA && condB);       // after 10:00: each enforced in its window

    // TEAL gate: same window rules but MACD_NOTANGLING is NOT required —
    // MACD = ON alone is enough for TEAL flips.
    const condA_teal = !macdEnforced || rawMacd;
    const tealMacdOK = earlyWindow
      ? (rawMacd || rawWma)
      : (condA_teal && condB);

    // TRENDING: true when all 5 UT Bots are bullish on this candle
    trending = blueBull && greenBull && cyanBull && purpleBull && tealBull;

    if (infraGreenFlipBuy) lastInfraGreenFlipBuyIdx = i;

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
      } else if (H[i] < pendingPurpleSell.high && L[i] < pendingPurpleSell.low) {
        sig = "SELL";
        reason = "Pending PURPLE sell confirmed: lower high & lower low than PURPLE sell candle";
        pendingPurpleSell = { active: false, high: 0, low: 0 };
      }
    }

    // BUY trigger conditions WITHOUT the macdWmaOK positive-conditions gate,
    // so a gate-blocked BUY can be remembered (failed-BUY memory below).
    const blueBuyTrig  = blueFlipBuy;
    const greenBuyTrig = blueBull && greenFlipBuy;
    const cyanBuyTrig  = blueBull && greenBull && cyanFlipBuy && cyanBuyTimeOK[i] && emaCrossedUp;
    const tealBuyTrig  = tealFlipBuy;

    // INFRAGREEN triggers REENTER only when it was the LAST to join: its most
    // recent bullish flip happened while GREEN and BLUE were already bullish,
    // and it is still bullish now.
    const idxIG = lastInfraGreenFlipBuyIdx;
    const infraGreenTrig = infraGreenBull && idxIG >= 0
      && green.pos[idxIG] === 1 && blue.pos[idxIG] === 1;

    // ── BUY: BLUE flips bullish ──
    if (sig === "WAIT" && blueBuyTrig && macdWmaOK) {
      sig = "BUY";
      reason = "BLUE flip bullish (K3/ATR10) [MACD+WMA ok]";
    }
    // ── BUY: BLUE already bullish, GREEN flips bullish ──
    else if (sig === "WAIT" && greenBuyTrig && macdWmaOK) {
      sig = "BUY";
      reason = "GREEN flip bullish (K2/ATR10) while BLUE bullish [MACD+WMA ok]";
    }
    // ── BUY: BLUE & GREEN already bullish, CYAN flips bullish (only before 9:40 AM, 10EMA>30EMA) ──
    else if (sig === "WAIT" && cyanBuyTrig && macdWmaOK) {
      sig = "BUY";
      reason = "CYAN flip bullish (K2/ATR300) while BLUE & GREEN bullish, 10EMA>30EMA [MACD+WMA ok]";
    }
    // ── BUY: TEAL flips bullish ──
    else if (sig === "WAIT" && tealBuyTrig && tealMacdOK && emaCrossedUp && ema10Rising) {
      sig = "BUY";
      reason = "TEAL flip bullish (K4/ATR10) [MACD+WMA ok, tangle ignored, EMA10>30 & rising]";
    }
    // ── REENTER: INFRAGREEN bullish + peak break + EMA10>30 & rising ──
    // If a BUY trigger within the last FAILED_BUY_MEMORY candles was blocked by
    // the macdWmaOK gate, this fires as BUY instead of REENTER.
    else if (sig === "WAIT" && greenBull && blueBull && purpleBull && infraGreenTrig
      && priceBreaksPeak && emaCrossedUp && ema10Rising && macdWmaOK) {
      if (i - pendingFailedBuyIdx <= FAILED_BUY_MEMORY) {
        sig = "BUY";
        reason = `BUY (re-entry): REENTER conditions met within ${FAILED_BUY_MEMORY} candles of MACD/WMA-blocked ${pendingFailedBuyBranch} | close ${C[i].toFixed(2)} > ${REENTER_PEAK_CANDLES}-candle peak ${reEntryPeak.toFixed(2)} +${REENTER_POINTS}`;
      } else {
        sig = "REENTER";
        reason = `Auto re-entry: close ${C[i].toFixed(2)} > ${REENTER_PEAK_CANDLES}-candle peak ${reEntryPeak.toFixed(2)} +${REENTER_POINTS}, EMA10>30 & rising, INFRAGREEN bullish`;
      }
    }

    // ── Failed-BUY memory: record a BUY trigger blocked by the macdWmaOK gate ──
    if (sig === "WAIT" && !macdWmaOK) {
      if (blueBuyTrig)       { pendingFailedBuyIdx = i; pendingFailedBuyBranch = "BLUE flip"; }
      else if (greenBuyTrig) { pendingFailedBuyIdx = i; pendingFailedBuyBranch = "GREEN flip"; }
      else if (cyanBuyTrig)  { pendingFailedBuyIdx = i; pendingFailedBuyBranch = "CYAN flip"; }
      else if (tealBuyTrig)  { pendingFailedBuyIdx = i; pendingFailedBuyBranch = "TEAL flip"; }
    }

    // Clear pending PURPLE sell if any BUY/REENTER signal fired, or PURPLE flipped bullish
    if (sig === "BUY" || sig === "REENTER" || purpleFlipBuy) {
      pendingPurpleSell = { active: false, high: 0, low: 0 };
    }

    // Clear failed-BUY memory on any SELL, or once a BUY/REENTER played out
    if (sig === "SELL" || sig === "BUY" || sig === "REENTER") {
      pendingFailedBuyIdx = -Infinity;
      pendingFailedBuyBranch = "";
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
    infraGreenPos: infraGreen.pos[N - 1],
    greenTrail: green.trail[N - 1],
    blueTrail: blue.trail[N - 1],
    cyanTrail: cyan.trail[N - 1],
    purpleTrail: purple.trail[N - 1],
    tealTrail: teal.trail[N - 1],
    infraGreenTrail: infraGreen.trail[N - 1],
    ema10: ema10[N - 1],
    ema30: ema30[N - 1],
    macdLine: macdLine[N - 1],
    macdSignal: macdSignal[N - 1],
    wma30: wma30[N - 1],
    wma60: wma60[N - 1],
    condA,
    macdTangled,
    condB,
    close: C[N - 1]
  };
}

module.exports = { superDoubleUT };
