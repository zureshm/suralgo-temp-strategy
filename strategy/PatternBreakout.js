// =============================================================================
// PatternBreakout — rare pattern-based breakout entries (1–3 trades/day)
//
// Pure price-pattern strategy on NORMAL candles. No volume, VWAP, or MA
// dependencies — behaves identically on FAKE_CE/FAKE_PE and real symbols.
//
// ORB (Opening Range Breakout):
//   Range = high/low of candles stamped 09:15–09:29 (first 15 minutes).
//   Between 09:30 and ORB_ENTRY_CUTOFF, BUY the first close that crosses
//   above the range high (fresh cross — previous close must be at/below).
//   Skipped if the range is degenerate or wider than ORB_MAX_RANGE_PCT.
//   Max 1 ORB trade per day. Stop: close below the range low.
//
// Cup & Handle (any time of day):
//   Rolling detection on the candle array:
//   - cup:    30–120 candles; both rims (5-bar edges) within 7% of each other;
//             bottom 3–25% below the weaker rim; bottom positioned in the
//             middle 30–70% of the cup span (rounded, not a V).
//   - handle: 3–15 candles after the cup; highs stay under the rim (≤2% over),
//             lows retrace ≤50% of cup depth.
//   - BUY on a fresh close above the higher rim (previous close at/below).
//   Stop: close below the handle low.
//
// Shared:
//   - MAX_TRADES_PER_DAY = 3 entries total (ORB ≤ 1, cup ≤ 2).
//   - No new entries after NO_ENTRY_AFTER (15:00).
//   - SELL on stop break, or EOD square-off at EOD_EXIT_MIN (15:20).
//   - REENTERs don't consume the daily cap and never touch inTrade.
//   - LADDER (REENTER): each STEP_PCT (5%) extension above the move's
//     peak re-arms the next rung — close above rung → REENTER. Laddered
//     continuation signals while the breakout keeps running.
//   - Day change resets inTrade, ORB state, level, and the counter.
// =============================================================================

function timeToMinutes(timeStr) {
  if (!timeStr) return null;
  const m = /(\d{1,2}):(\d{2})/.exec(String(timeStr));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// ── UT Bot (Key Value × ATR trailing stop) ───────────────────────────────────
// Same implementation as claudSurStrategy — used to gate ladder REENTERs on
// GREEN (Key=2, ATR=10, normal candles) being in bullish state.

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

// ── Cup & handle detector ────────────────────────────────────────────────────
// Checks whether bar i is a fresh cup breakout. Scans handle lengths 3–15 and
// cup lengths 30–120, growing the cup leftwards while maintaining the interior
// minimum incrementally. Returns { rimHigh, handleLow, cupLen, handleLen }.

const CUP_MIN_LEN = 30, CUP_MAX_LEN = 120, RIM_BARS = 5;
const HANDLE_MIN_LEN = 3, HANDLE_MAX_LEN = 15;
const CUP_MIN_DEPTH = 0.03, CUP_MAX_DEPTH = 0.25;
const RIM_TOL_PCT = 0.07;          // rims within 7% of each other
const HANDLE_ABOVE_RIM = 1.02;     // handle highs ≤ rim × 1.02
const HANDLE_MAX_RETRACE = 0.5;    // handle lows ≥ rim − 50% of depth

function findCupBreakout(H, L, C, i) {
  for (let hl = HANDLE_MIN_LEN; hl <= HANDLE_MAX_LEN; hl++) {
    const cupEnd = i - hl;                    // cup region [s .. cupEnd-1]
    if (cupEnd - CUP_MIN_LEN < 0) continue;

    // handle stats over [cupEnd .. i-1]
    let handleLow = Infinity, handleHigh = -Infinity;
    for (let j = cupEnd; j < i; j++) {
      if (L[j] < handleLow) handleLow = L[j];
      if (H[j] > handleHigh) handleHigh = H[j];
    }

    // right rim = max high of last RIM_BARS of the cup
    let rightRim = -Infinity;
    for (let j = cupEnd - RIM_BARS; j < cupEnd; j++) {
      if (H[j] > rightRim) rightRim = H[j];
    }

    // interior bottom: seeded over the smallest cup's interior, then extended
    // one element left per cupLen step
    const s0 = cupEnd - CUP_MIN_LEN;
    let bottom = Infinity, bottomIdx = -1;
    for (let j = s0 + RIM_BARS; j <= cupEnd - RIM_BARS - 1; j++) {
      if (L[j] < bottom) { bottom = L[j]; bottomIdx = j; }
    }

    const sMin = Math.max(0, cupEnd - CUP_MAX_LEN);
    for (let s = s0; s >= sMin; s--) {
      const ni = s + RIM_BARS; // new interior element as window grows left
      if (L[ni] < bottom) { bottom = L[ni]; bottomIdx = ni; }

      let leftRim = -Infinity;
      for (let j = s; j < s + RIM_BARS; j++) if (H[j] > leftRim) leftRim = H[j];

      const rimHigh = Math.max(leftRim, rightRim);
      const rimLow  = Math.min(leftRim, rightRim);
      if (!(rimLow > 0)) continue;
      if ((rimHigh - rimLow) / rimLow > RIM_TOL_PCT) continue;   // rims unequal

      const depth = rimLow - bottom;
      const depthPct = depth / rimLow;
      if (depthPct < CUP_MIN_DEPTH || depthPct > CUP_MAX_DEPTH) continue;

      const span = cupEnd - s;
      const pos = (bottomIdx - s) / span;
      if (pos < 0.30 || pos > 0.70) continue;                    // not rounded

      if (handleLow < rimLow - HANDLE_MAX_RETRACE * depth) continue;
      if (handleHigh > rimHigh * HANDLE_ABOVE_RIM) continue;

      if (C[i] > rimHigh && C[i - 1] <= rimHigh) {               // fresh cross
        return { rimHigh, handleLow, cupLen: span, handleLen: hl };
      }
    }
  }
  return null;
}

// ── Main strategy ────────────────────────────────────────────────────────────

const ORB_START_MIN = 9 * 60 + 15;   // 09:15
const ORB_END_MIN = 9 * 60 + 30;     // 09:30 (range covers t < 09:30)
const ORB_ENTRY_CUTOFF = 11 * 60 + 30; // no ORB entries after 11:30
const ORB_MAX_RANGE_PCT = 0.08;      // skip degenerate/explosive open ranges
const NO_ENTRY_AFTER = 15 * 60;      // no new entries after 15:00
const EOD_EXIT_MIN = 15 * 60 + 20;   // square-off 15:20
const MAX_TRADES_PER_DAY = 3;
const STEP_PCT = 0.05;               // each 5% extension above the peak = a REENTER rung

function patternBreakout(candles) {
  if (!candles || candles.length < 20) {
    return { signal: "WAIT", reason: "Not enough data (need 20+)" };
  }

  const N = candles.length;
  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));

  const green = utBotSeries(H, L, C, 2, 10);   // GREEN UT Bot (Key=2, ATR=10) — gates ladder REENTERs

  let day = null;
  let orbHigh = null, orbLow = null, orbSealed = false, orbTraded = false;
  let inTrade = false, stop = null, breakLevel = null, tradesToday = 0;
  let peakHigh = null;   // highest high since the last entry
  let nextRung = null;   // peakHigh × (1 + STEP_PCT) — next ladder trigger
  let reexitLevel = null; // frozen exit line for an open REENTER (peak at fire time − STEP_PCT)
  let lastRim = null;
  let signal = "WAIT", reason = "No pattern";

  let prevMins = null;
  for (let i = 1; i < N; i++) {
    const t = candles[i].time;
    const ts = t != null ? String(t) : "";
    const hasDate = /\d{4}-\d{2}-\d{2}/.test(ts);
    const d = hasDate ? ts.slice(0, 10) : "session";
    const mins = timeToMinutes(t);

    // New day: the date changed. Time-only feeds (backtest CSVs) wrap instead
    // (15:29 → 09:15) — datetime feeds never use the wrap check.
    if (d !== day || (!hasDate && mins != null && prevMins != null && mins < prevMins)) {
      day = d;
      orbHigh = orbLow = null; orbSealed = false; orbTraded = false;
      inTrade = false; stop = null; breakLevel = null; tradesToday = 0;
      peakHigh = null; nextRung = null; reexitLevel = null;
    }
    prevMins = mins;

    // ── Build the opening range ──
    if (!orbSealed && mins != null) {
      if (mins >= ORB_START_MIN && mins < ORB_END_MIN) {
        orbHigh = orbHigh == null ? H[i] : Math.max(orbHigh, H[i]);
        orbLow  = orbLow  == null ? L[i] : Math.min(orbLow,  L[i]);
      } else if (mins >= ORB_END_MIN) {
        orbSealed = true;
        if (orbHigh == null || orbLow == null || orbHigh <= orbLow
            || (orbHigh - orbLow) / orbLow > ORB_MAX_RANGE_PCT) {
          orbHigh = orbLow = null; // invalid range → no ORB today
        }
      }
    }

    signal = "WAIT";
    reason = "No pattern";

    // Track the move's peak — the ladder hangs off it
    if (peakHigh != null && H[i] > peakHigh) peakHigh = H[i];

    // Ladder: close above the next rung (peak + 5%) AND GREEN bullish = REENTER
    const ladder = nextRung != null
      && (mins == null || mins < NO_ENTRY_AFTER)
      && C[i] > nextRung
      && green.pos[i] === 1;

    // REEXIT: an open ladder REENTER exits on a close below its frozen line
    const reexit = reexitLevel != null && C[i] < reexitLevel;

    if (inTrade) {
      if (mins != null && mins >= EOD_EXIT_MIN) {
        signal = "SELL";
        reason = "EOD square-off at 15:20";
        inTrade = false;
      } else if (C[i] <= stop) {
        signal = "SELL";
        reason = `close below pattern stop (${stop.toFixed(2)})`;
        inTrade = false;
      } else if (reexit) {
        signal = "REEXIT";
        reason = `close ${C[i].toFixed(2)} below frozen exit ${reexitLevel.toFixed(2)} (peak at REENTER −5%)`;
      } else if (ladder) {
        signal = "REENTER";
        reason = `Ladder: close ${C[i].toFixed(2)} above +${STEP_PCT * 100}% rung ${nextRung.toFixed(2)} (peak ${peakHigh.toFixed(2)})`;
      }
    } else {
      // Fresh patterns FIRST — a new breakout outranks resurrection.
      // If reenter were checked first, one big candle crossing both the
      // old level and a new rim would eat the fresh pattern's cross.
      if (mins == null || mins < NO_ENTRY_AFTER) {
        if (!orbTraded && orbHigh != null && mins != null
            && mins >= ORB_END_MIN && mins <= ORB_ENTRY_CUTOFF
            && C[i] > orbHigh && C[i - 1] <= orbHigh) {
          signal = "BUY";
          reason = `ORB breakout: close above 9:15-9:30 range high ${orbHigh.toFixed(2)}`;
          inTrade = true;
          stop = orbLow;
          breakLevel = orbHigh;
          orbTraded = true;
          peakHigh = H[i];
          nextRung = H[i] * (1 + STEP_PCT);
          tradesToday++;
        } else {
          const cup = findCupBreakout(H, L, C, i);
          if (cup) {
            lastRim = cup.rimHigh;
            const sameLevel = breakLevel != null
              && Math.abs(cup.rimHigh - breakLevel) / breakLevel < 0.01;
            if (sameLevel) {
              // Same cup re-detected at the old level — not a new trade,
              // and resurrection is disabled, so emit nothing.
            } else {
              signal = "BUY";
              reason = `Cup & handle breakout above rim ${cup.rimHigh.toFixed(2)} (cup ${cup.cupLen} bars, handle ${cup.handleLen})`;
              inTrade = true;
              stop = cup.handleLow;
              breakLevel = cup.rimHigh;
              peakHigh = H[i];
              nextRung = H[i] * (1 + STEP_PCT);
              tradesToday++;
            }
          }
        }
      }
      if (signal === "WAIT" && reexit) {
        signal = "REEXIT";
        reason = `close ${C[i].toFixed(2)} below frozen exit ${reexitLevel.toFixed(2)} (peak at REENTER −5%)`;
      } else if (signal === "WAIT" && ladder) {
        signal = "REENTER";
        reason = `Ladder: close ${C[i].toFixed(2)} above +${STEP_PCT * 100}% rung ${nextRung.toFixed(2)} (peak ${peakHigh.toFixed(2)})`;
      }
    }

    // Rung fired → hang the next one off the new peak
    if (ladder) nextRung = peakHigh * (1 + STEP_PCT);
    // REENTER opens → freeze its exit line at peak − 5%; REEXIT/SELL closes it
    if (signal === "REENTER") reexitLevel = peakHigh * (1 - STEP_PCT);
    if (signal === "REEXIT" || signal === "SELL") reexitLevel = null;
  }

  return {
    signal,
    reason,
    inTrade,
    stop,
    tradesToday,
    orbHigh,
    orbLow,
    rim: lastRim,
    close: C[N - 1]
  };
}

module.exports = {
  patternBreakout,
  findCupBreakout,
  timeToMinutes,
  utBotSeries,
  ORB_START_MIN,
  ORB_END_MIN,
  ORB_ENTRY_CUTOFF,
  ORB_MAX_RANGE_PCT
};
