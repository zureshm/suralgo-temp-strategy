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
//   - Day change resets inTrade, ORB state, and the counter.
// =============================================================================

function timeToMinutes(timeStr) {
  if (!timeStr) return null;
  const m = /(\d{1,2}):(\d{2})/.exec(String(timeStr));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
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

function patternBreakout(candles) {
  if (!candles || candles.length < 20) {
    return { signal: "WAIT", reason: "Not enough data (need 20+)" };
  }

  const N = candles.length;
  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));

  let day = null;
  let orbHigh = null, orbLow = null, orbSealed = false, orbTraded = false;
  let inTrade = false, stop = null, tradesToday = 0;
  let lastRim = null;
  let signal = "WAIT", reason = "No pattern";

  for (let i = 1; i < N; i++) {
    const t = candles[i].time;
    const d = t != null ? String(t).slice(0, 10) : null;
    const mins = timeToMinutes(t);

    if (d !== day) {
      day = d;
      orbHigh = orbLow = null; orbSealed = false; orbTraded = false;
      inTrade = false; stop = null; tradesToday = 0;
    }

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

    if (inTrade) {
      if (mins != null && mins >= EOD_EXIT_MIN) {
        signal = "SELL";
        reason = "EOD square-off at 15:20";
        inTrade = false;
      } else if (C[i] <= stop) {
        signal = "SELL";
        reason = `close below pattern stop (${stop.toFixed(2)})`;
        inTrade = false;
      }
    } else if (tradesToday < MAX_TRADES_PER_DAY
        && (mins == null || mins < NO_ENTRY_AFTER)) {
      if (!orbTraded && orbHigh != null && mins != null
          && mins >= ORB_END_MIN && mins <= ORB_ENTRY_CUTOFF
          && C[i] > orbHigh && C[i - 1] <= orbHigh) {
        signal = "BUY";
        reason = `ORB breakout: close above 9:15-9:30 range high ${orbHigh.toFixed(2)}`;
        inTrade = true;
        stop = orbLow;
        orbTraded = true;
        tradesToday++;
      } else {
        const cup = findCupBreakout(H, L, C, i);
        if (cup) {
          lastRim = cup.rimHigh;
          signal = "BUY";
          reason = `Cup & handle breakout above rim ${cup.rimHigh.toFixed(2)} (cup ${cup.cupLen} bars, handle ${cup.handleLen})`;
          inTrade = true;
          stop = cup.handleLow;
          tradesToday++;
        }
      }
    }
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

module.exports = { patternBreakout };
