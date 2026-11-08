// =============================================================================
// surStrategy — SumeshStrategy copy + Sentiment Range MA (SRMA) filter
//
// Same signal engine as SumeshStrategy (normal candles):
//   - GREEN (UT Bot):  Key Value = 2, ATR Period = 10 (main signal)
//   - BLUE (UT Bot):   Key Value = 3, ATR Period = 10 (deferred BUY trigger)
//   - PURPLE (UT Bot): Key Value = 1, ATR Period = 10 (once-per-green BUY)
//   - INFRAGREEN (UT Bot 2): Key Value = 0.8, ATR Period = 10 (re-entry trigger)
//   - 10EMA / 30EMA on close
//   - WMA30 / WMA60 on close
//   - SRMA (Sentiment Range MA [ChartPrime]) — faithful port of the frontend
//     implementation in suralgo-frontend/lib/strategy-chart.ts
//     (calculateSentimentRangeMA). Defaults: Length=20 (+1), Double Filter=ON,
//     Trigger Smoothing=4 (+1), ATR Length=200, Multiplier=6, Range=Body,
//     Color Style=MA Direction.
//
// SIGNALS (bar-by-bar replay, closed candles):
//
// SELL:    GREEN flips bearish (unchanged). A SELL during SRMA grey also
//          arms the caution window below.
// REENTER: GREEN already bullish AND INFRAGREEN flips bullish,
//          AND 10EMA already above 30EMA (upward cross has occurred),
//          AND 10EMA rising vs 5 candles ago,
//          AND WMA30 above WMA60 (already crossed upwards).
// BUY:     GREEN flips bullish — subject to the SRMA gate below:
//          suppressed when SRMA is red, inside the 20-candle caution
//          window after red→grey or a SELL-in-grey, and during post-
//          caution grey unless the close is above the SRMA line.
//          Outside 09:45–15:00 all SRMA checks are skipped → always BUY.
// BUY (BLUE): BLUE flips bullish while GREEN already bullish → holds a BUY
//          trigger for the next 15 candles; fires on a green candle
//          (close>open) closing above the highest close of the previous
//          20 candles AND either: (a) SRMA is green, OR (b) the entire
//          candle — wick included (low > SRMA) — sits above the SRMA
//          line, which needs no green tone. See BLUE section below.
//
// SRMA sideways-caution rules (gate BOTH BUY and REENTER):
//   - SRMA is considered ONLY between 09:45 and 15:00 (candle time).
//     Outside that window all SRMA checks are skipped — BUY/REENTER are
//     never suppressed, BLUE's fire needs no green tone — EXCEPT PURPLE,
//     which always requires SRMA green (ignores the window).
//   - HARD RULE: no BUY-side signal when candle close is at/below the
//     SRMA line — applies even when SRMA is green.
//   - SRMA red          → suppressed.
//   - SRMA red → grey   → 20-candle caution window opens. While grey inside
//                         the window, BUY/REENTER suppressed. Green SRMA
//                         ends the caution early (allowed again). Red resets.
//   - GREEN SELL during grey → same 20-candle caution window opens.
//   - Window expired still grey → buy-side signals allowed only if the
//                         candle close is above the SRMA line.
//
// BLUE held trigger (deferred BUY):
//   - BLUE flips bullish while GREEN is ALREADY bullish (i.e. GREEN bullish
//     but its BUY did not / could not fire) → a BUY trigger is held armed
//     for the next 15 candles.
//   - While armed, the held trigger fires → BUY on a green candle
//     (close>open) closing above the highest close of the previous 20
//     candles, when SRMA is green — OR, without needing the green tone,
//     when the whole candle (wick included, low > SRMA) is above the
//     SRMA line. Expires unfired after 15 candles;
//     cancelled on a GREEN or BLUE bearish flip.
//   - GREY FRAGMENT extra: during SRMA grey the fire additionally needs
//     no BLUE bearish flip within the previous 10 candles.
// BUY (PURPLE): PURPLE flips bullish → BUY only when ALL hold:
//          (1) SRMA is green — NOT time-windowed (may fire pre-9:45),
//          (2) close is higher than the previous 3 candles' closes,
//          (3) the whole candle — wick included (low > SRMA) — is above
//              the SRMA line, no touching,
//          (4) no GREEN or BLUE BUY has fired during this green SRMA
//              fragment,
//          (5) PURPLE has not already fired during this green fragment,
//          (6) GREEN is already bullish.
//          Fires at most once per continuous green-SRMA fragment.
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

// ── Sentiment Range MA [ChartPrime] ──────────────────────────────────────────
// Port of suralgo-frontend/lib/strategy-chart.ts calculateSentimentRangeMA.
// Stateful MA that re-anchors to source whenever the smoothed candle
// top/bottom escapes the ATR×multiplier bands, then smooths the anchor
// step-series with WMA (or WMA∘SMA "double filter").

function smaAt(arr, i, len) {
  // SMA ending at index i over arr[i-len+1..i]; NaN if any value missing/non-finite
  if (i < len - 1) return NaN;
  let sum = 0;
  for (let j = i - len + 1; j <= i; j++) {
    const v = arr[j];
    if (!Number.isFinite(v)) return NaN;
    sum += v;
  }
  return sum / len;
}

function wmaAt(arr, i, len) {
  // WMA ending at index i; most recent weight = len, oldest = 1
  if (i < len - 1) return NaN;
  const denom = (len * (len + 1)) / 2;
  let sum = 0;
  for (let j = 0; j < len; j++) {
    const v = arr[i - j];
    if (!Number.isFinite(v)) return NaN;
    sum += v * (len - j);
  }
  return sum / denom;
}

function smoothSeries(src, len, doubleFilter) {
  const out = new Array(src.length).fill(NaN);
  if (doubleFilter) {
    // ta.wma(ta.sma(src, len), len) — SMA first (tail-aligned), then WMA over it
    const sma = new Array(src.length).fill(NaN);
    for (let i = 0; i < src.length; i++) sma[i] = smaAt(src, i, len);
    for (let i = 0; i < src.length; i++) out[i] = wmaAt(sma, i, len);
  } else {
    for (let i = 0; i < src.length; i++) out[i] = wmaAt(src, i, len);
  }
  return out;
}

// Returns { ma, top, bottom, tone } parallel arrays (null where not finite).
// tone: "bull" | "bear" | "neutral" | null (MA Direction color style).
function sentimentRangeMA(O, H, L, C, opts = {}) {
  const outLen = Math.max(1, (opts.length ?? 20) + 1);
  const doubleFilter = opts.doubleFilter ?? true;
  const trigLen = Math.max(1, (opts.triggerSmoothing ?? 4) + 1);
  const atrLen = Math.max(1, Math.floor(opts.atrLength ?? 200));
  const mult = opts.multiplier ?? 6;
  const wick = opts.rangeStyle === "wick";

  const n = C.length;
  const ma = new Array(n).fill(null);
  const top = new Array(n).fill(null);
  const bottom = new Array(n).fill(null);
  const tone = new Array(n).fill(null);
  if (n === 0 || !Number.isFinite(mult)) return { ma, top, bottom, tone };

  const candleTop = new Array(n);
  const candleBottom = new Array(n);
  const smoothTop = new Array(n).fill(NaN);
  const smoothBottom = new Array(n).fill(NaN);
  const atr = new Array(n).fill(NaN);
  const tr = new Array(n);

  for (let i = 0; i < n; i++) {
    const t = wick ? H[i] : Math.max(O[i], C[i]);
    const b = wick ? L[i] : Math.min(O[i], C[i]);
    candleTop[i] = t;
    candleBottom[i] = b;
    tr[i] = t - b;
  }
  for (let i = trigLen - 1; i < n; i++) {
    smoothTop[i] = smaAt(candleTop, i, trigLen);
    smoothBottom[i] = smaAt(candleBottom, i, trigLen);
  }
  for (let i = atrLen - 1; i < n; i++) atr[i] = smaAt(tr, i, atrLen);

  // Stateful anchor pass — mirrors the Pine var-block:
  // flag uses PREVIOUS bar's top/bottom/current_range; on flag, re-anchor.
  const rawMa = new Array(n).fill(NaN);
  const rawTop = new Array(n).fill(NaN);
  const rawBottom = new Array(n).fill(NaN);
  let curRange = NaN;
  let topRange = NaN;
  let bottomRange = NaN;

  for (let i = 0; i < n; i++) {
    const st = smoothTop[i];
    const sb = smoothBottom[i];
    const flag =
      !Number.isFinite(curRange) ||
      (Number.isFinite(st) && st > topRange) ||
      (Number.isFinite(sb) && sb < bottomRange);
    if (flag) {
      const src = C[i];
      rawMa[i] = src;
      const a = atr[i];
      curRange = Number.isFinite(a) ? a * mult : NaN;
      topRange = Number.isFinite(curRange) ? src + curRange : NaN;
      bottomRange = Number.isFinite(curRange) ? src - curRange : NaN;
    } else {
      rawMa[i] = i > 0 ? rawMa[i - 1] : NaN;
    }
    rawTop[i] = topRange;
    rawBottom[i] = bottomRange;
  }

  const smMa = smoothSeries(rawMa, outLen, doubleFilter);
  const smTop = smoothSeries(rawTop, outLen, doubleFilter);
  const smBottom = smoothSeries(rawBottom, outLen, doubleFilter);

  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(smMa[i]) || !Number.isFinite(smTop[i]) || !Number.isFinite(smBottom[i])) continue;
    ma[i] = smMa[i];
    top[i] = smTop[i];
    bottom[i] = smBottom[i];
    // MA Direction color style: compare against previous smoothed value
    const prev = i > 0 ? smMa[i - 1] : NaN;
    const prevV = Number.isFinite(prev) ? prev : 0;
    const d = smMa[i] - prevV;
    tone[i] = d > 0 ? "bull" : d < 0 ? "bear" : "neutral";
  }

  return { ma, top, bottom, tone };
}

// ── Main strategy ────────────────────────────────────────────────────────────

// 10EMA rising lookback for REENTER (candles ago), same as DINKAN/TOMMAN
const REENTER_EMA_LOOKBACK = 5;

// SRMA rules apply only within 09:45–15:00 candle time
function srmaWindowActive(candleTime) {
  if (candleTime == null) return true; // no time info → apply SRMA
  const m = String(candleTime).match(/(\d{2}):(\d{2})/);
  if (!m) return true;
  const mins = (+m[1]) * 60 + (+m[2]);
  return mins >= 9 * 60 + 45 && mins < 15 * 60;
}

function surStrategy(candles) {
  if (!candles || candles.length < 20) {
    return { signal: "WAIT", reason: "Not enough data" };
  }

  const O = candles.map(c => Number(c.open));
  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));
  const N = C.length;

  const green = utBotSeries(H, L, C, 2, 10);        // GREEN (Key=2, ATR=10) — main signal
  const blue  = utBotSeries(H, L, C, 3, 10);        // BLUE  (Key=3, ATR=10) — deferred trigger
  const purple = utBotSeries(H, L, C, 1, 10);       // PURPLE (Key=1, ATR=10) — once-per-green BUY
  const infraGreen = utBotSeries(H, L, C, 0.8, 10); // INFRAGREEN (Key=0.8, ATR=10)

  const ema10 = emaSeries(C, 10); // 10EMA on close
  const ema30 = emaSeries(C, 30); // 30EMA on close

  const wma30 = wmaSeries(C, 30); // WMA30 on close
  const wma60 = wmaSeries(C, 60); // WMA60 on close

  const srma = sentimentRangeMA(O, H, L, C); // SRMA, frontend defaults

  // ── Bar-by-bar replay (SRMA caution state needs transition history) ──
  const CAUTION_WINDOW = 20; // candles after red→grey / SELL-in-grey
  let cautionLeft = 0;       // candles remaining inside the caution window
  let postCautionGrey = false; // window expired while still grey → need close>SRMA
  const BLUE_WINDOW = 15;    // candles BLUE's BUY trigger stays armed
  const BLUE_ENABLED = true; // BLUE deferred BUY trigger
  let blueTrigger = 0;       // candles remaining on BLUE's held BUY trigger
  let lastBlueBear = -Infinity; // bar index of last BLUE bearish flip (grey-fragment embargo)
  let inGreenFragment = false; // currently inside a continuous SRMA-green stretch
  let purpleUsed = false;      // PURPLE already fired this green fragment
  let greenBlueBuyUsed = false; // GREEN/BLUE BUY already fired this green fragment
  let signal = "WAIT";
  let reason = "No flip";

  for (let i = 1; i < N; i++) {
    signal = "WAIT";
    reason = "No flip";

    const tone = srma.tone[i];
    const prevTone = srma.tone[i - 1];

    // ── PURPLE once-per-green-fragment bookkeeping ──
    if (tone === "bull") {
      if (!inGreenFragment) { inGreenFragment = true; purpleUsed = false; greenBlueBuyUsed = false; }
    } else {
      inGreenFragment = false;
    }

    // ── SRMA sideways-caution state ──
    if (prevTone === "bear" && tone === "neutral") { cautionLeft = CAUTION_WINDOW; postCautionGrey = false; }
    if (tone === "bull" || tone === "bear") { cautionLeft = 0; postCautionGrey = false; }

    // buy-side gate from SRMA (only inside the 09:45–15:00 window)
    const srmaActive = srmaWindowActive(candles[i].time);
    let srmaBlockReason = null;
    if (srmaActive) {
      if (srma.ma[i] != null && C[i] <= srma.ma[i]) {
        srmaBlockReason = "candle close at/below SRMA";
      } else if (tone === "bear") {
        srmaBlockReason = "SRMA is red";
      } else if (tone === "neutral") {
        if (cautionLeft > 0) srmaBlockReason = "SRMA grey, inside 20-candle caution";
        else if (postCautionGrey && !(srma.ma[i] != null && C[i] > srma.ma[i]))
          srmaBlockReason = "SRMA grey past caution, close not above SRMA";
      }
    }

    const bullFlip = green.pos[i] === 1 && green.pos[i - 1] !== 1;
    const bearFlip = green.pos[i] === -1 && green.pos[i - 1] !== -1;
    const blueBullFlip = blue.pos[i] === 1 && blue.pos[i - 1] !== 1;
    const blueBearFlip = blue.pos[i] === -1 && blue.pos[i - 1] !== -1;

    // ── BLUE trigger arming: bullish flip while GREEN ALREADY bullish ──
    if (BLUE_ENABLED && blueBullFlip && green.pos[i] === 1 && green.pos[i - 1] === 1) blueTrigger = BLUE_WINDOW;
    if (blueBearFlip) { blueTrigger = 0; lastBlueBear = i; } // BLUE going bearish kills its held trigger + stamps embargo

    if (bearFlip) {
      signal = "SELL";
      reason = "GREEN flipped bearish";
      blueTrigger = 0;
      // SELL during grey arms the same 20-candle caution
      if (tone === "neutral") { cautionLeft = CAUTION_WINDOW; postCautionGrey = false; }
    } else if (bullFlip) {
      if (srmaBlockReason) {
        reason = `GREEN flipped bullish but ${srmaBlockReason} — BUY suppressed`;
      } else {
        signal = "BUY";
        reason = "GREEN flipped bullish";
      }
    } else {
      // ── REENTER gates ──
      const infraGreenFlipBuy = infraGreen.pos[i] === 1 && infraGreen.pos[i - 1] !== 1;
      const emaCrossedUp = ema10[i] != null && ema30[i] != null && ema10[i] > ema30[i];
      const ema10Rising = i >= REENTER_EMA_LOOKBACK
        && ema10[i] != null && ema10[i - REENTER_EMA_LOOKBACK] != null
        && ema10[i] > ema10[i - REENTER_EMA_LOOKBACK];
      const wmaCrossedUp = wma30[i] != null && wma60[i] != null && wma30[i] > wma60[i];

      if (green.pos[i] === 1 && infraGreenFlipBuy && emaCrossedUp && ema10Rising && wmaCrossedUp) {
        if (srmaBlockReason) {
          reason = `INFRAGREEN flip bullish but ${srmaBlockReason} — REENTER suppressed`;
        } else {
          signal = "REENTER";
          reason = "INFRAGREEN flip bullish (K0.8/ATR10) while GREEN bullish, 10EMA>30EMA rising, WMA30>WMA60";
        }
      }
    }

    // ── BLUE held trigger: SRMA green/body-above + green candle + 20-candle close breakout ──
    if (signal === "WAIT" && blueTrigger > 0) {
      let highestClose20 = -Infinity;
      for (let j = Math.max(0, i - 20); j < i; j++) if (C[j] > highestClose20) highestClose20 = C[j];
      const candleAboveSrma = srma.ma[i] != null && L[i] > srma.ma[i]; // whole candle incl. wick above SRMA
      const srmaOkForFire = !srmaActive || tone === "bull" || candleAboveSrma;
      const closeAboveSrma = !srmaActive || srma.ma[i] == null || C[i] > srma.ma[i];
      const blueBearClear = tone !== "neutral" || i - lastBlueBear > 10; // grey-fragment embargo
      if (srmaOkForFire && closeAboveSrma && blueBearClear && C[i] > O[i] && C[i] > highestClose20) {
        signal = "BUY";
        reason = tone === "bull"
          ? "BLUE trigger fired: bullish flip while GREEN bullish → SRMA green + green candle closing above 20-candle closes → BUY"
          : "BLUE trigger fired: bullish flip while GREEN bullish → candle fully above SRMA + closing above 20-candle closes → BUY";
        blueTrigger = 0;
      } else {
        blueTrigger -= 1;
      }
    }

    // a GREEN/BLUE BUY fired during a green fragment consumes PURPLE's slot
    if (signal === "BUY" && tone === "bull") greenBlueBuyUsed = true;

    // ── PURPLE: once-per-green-fragment BUY ──
    if (signal === "WAIT" && tone === "bull" && green.pos[i] === 1 && !purpleUsed && !greenBlueBuyUsed) {
      const purpleBullFlip = purple.pos[i] === 1 && purple.pos[i - 1] !== 1;
      let highestClose3 = -Infinity;
      for (let j = Math.max(0, i - 3); j < i; j++) if (C[j] > highestClose3) highestClose3 = C[j];
      if (purpleBullFlip && C[i] > highestClose3 && srma.ma[i] != null && L[i] > srma.ma[i]) {
        signal = "BUY";
        reason = "PURPLE flipped bullish, SRMA green, close above prev 3 candles, candle fully above SRMA → BUY";
        purpleUsed = true;
      }
    }

    // end of bar: tick the caution window down
    if (cautionLeft > 0) {
      cautionLeft -= 1;
      if (cautionLeft === 0 && tone === "neutral") postCautionGrey = true;
    }
  }

  const i = N - 1;

  return {
    signal,
    reason,
    srmaCaution: cautionLeft,
    srmaPostCautionGrey: postCautionGrey,
    greenPos: green.pos[i],
    greenTrail: green.trail[i],
    bluePos: blue.pos[i],
    blueTrail: blue.trail[i],
    blueTrigger,
    purplePos: purple.pos[i],
    purpleTrail: purple.trail[i],
    infraGreenPos: infraGreen.pos[i],
    ema10: ema10[i],
    ema30: ema30[i],
    wma30: wma30[i],
    wma60: wma60[i],
    srma: srma.ma[i],
    srmaTop: srma.top[i],
    srmaBottom: srma.bottom[i],
    srmaTone: srma.tone[i],
    close: C[i]
  };
}

module.exports = { surStrategy };
