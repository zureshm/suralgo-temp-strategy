// =============================================================================
// AscendingTriangle — flat resistance + rising lows, breakout above the ceiling
//
// Pure price-pattern strategy on NORMAL candles. No volume, VWAP, or MA
// dependencies — behaves identically on FAKE_CE/FAKE_PE and real symbols.
//
// Ascending triangle (any time of day):
//   Rolling detection on the candle array:
//   - window:  TRI_MIN_LEN–TRI_MAX_LEN candles ending just before the bar.
//   - ceiling: the max high R of the window must be touched ≥ MIN_TOUCHES
//              times — highs within TOP_TOL_PCT of R (flat resistance).
//   - ramp:    min low of the window's second half must be ABOVE the min low
//              of its first half (higher lows pushing into the ceiling).
//   - depth:   R − first-half low between 3–25% of R (real coil, not noise).
//   - BUY on a fresh close above R (previous close at/below).
//   Stop: close below the recent higher low (min low of the window's last
//   third — the ascending trendline's anchor).
//
// Shared (identical contract to PatternBreakout):
//   - MAX_TRADES_PER_DAY = 3 entries.
//   - No new entries after NO_ENTRY_AFTER (15:00).
//   - SELL on stop break, or EOD square-off at EOD_EXIT_MIN (15:20).
//   - REENTERs don't consume the daily cap and never touch inTrade.
//   - LADDER (REENTER): each STEP_PCT (5%) extension above the move's
//     peak re-arms the next rung — close above rung AND GREEN UT Bot
//     (Key=2, ATR=10) bullish → REENTER.
//   - Day change resets inTrade, level, and the counter.
// =============================================================================

const { utBotSeries } = require("./PatternBreakout");

function timeToMinutes(timeStr) {
  if (!timeStr) return null;
  const m = /(\d{1,2}):(\d{2})/.exec(String(timeStr));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// ── Ascending triangle detector ──────────────────────────────────────────────
// Checks whether bar i is a fresh triangle breakout. Scans window lengths
// TRI_MIN_LEN–TRI_MAX_LEN ending at i-1. Returns { resistance, support, len }.

const TRI_MIN_LEN = 20, TRI_MAX_LEN = 100;
const TOP_TOL_PCT = 0.02;          // highs within 2% of the ceiling = a touch
const MIN_TOUCHES = 2;             // ceiling tested at least twice
const TRI_MIN_DEPTH = 0.03, TRI_MAX_DEPTH = 0.25;

function findTriangleBreakout(H, L, C, i) {
  for (let len = TRI_MIN_LEN; len <= TRI_MAX_LEN; len++) {
    const s = i - len;                       // window [s .. i-1]
    if (s < 0) break;

    // ceiling = max high of the window; count touches within TOP_TOL_PCT
    let R = -Infinity;
    for (let j = s; j < i; j++) if (H[j] > R) R = H[j];
    if (!(R > 0)) continue;

    let touches = 0;
    for (let j = s; j < i; j++) if (H[j] >= R * (1 - TOP_TOL_PCT)) touches++;
    if (touches < MIN_TOUCHES) continue;     // resistance not really tested

    // rising lows: second-half floor above first-half floor
    const mid = s + Math.floor(len / 2);
    let low1 = Infinity, low2 = Infinity;
    for (let j = s; j < mid; j++) if (L[j] < low1) low1 = L[j];
    for (let j = mid; j < i; j++) if (L[j] < low2) low2 = L[j];
    if (!(low2 > low1)) continue;            // lows not ascending
    if (low2 >= R) continue;                 // floor ate the ceiling — no coil

    const depthPct = (R - low1) / R;
    if (depthPct < TRI_MIN_DEPTH || depthPct > TRI_MAX_DEPTH) continue;

    // support = min low of the window's last third (recent higher low)
    const third = i - Math.floor(len / 3);
    let support = Infinity;
    for (let j = third; j < i; j++) if (L[j] < support) support = L[j];

    if (C[i] > R && C[i - 1] <= R) {         // fresh cross through the ceiling
      return { resistance: R, support, len };
    }
  }
  return null;
}

// ── Main strategy ────────────────────────────────────────────────────────────

const NO_ENTRY_AFTER = 15 * 60;      // no new entries after 15:00
const EOD_EXIT_MIN = 15 * 60 + 20;   // square-off 15:20
const MAX_TRADES_PER_DAY = 3;
const STEP_PCT = 0.05;               // each 5% extension above the peak = a REENTER rung

function ascendingTriangle(candles) {
  if (!candles || candles.length < 20) {
    return { signal: "WAIT", reason: "Not enough data (need 20+)" };
  }

  const N = candles.length;
  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));

  const green = utBotSeries(H, L, C, 2, 10);   // GREEN UT Bot (Key=2, ATR=10) — gates ladder REENTERs

  let day = null;
  let inTrade = false, stop = null, breakLevel = null, tradesToday = 0;
  let peakHigh = null;   // highest high since the last entry
  let nextRung = null;   // peakHigh × (1 + STEP_PCT) — next ladder trigger
  let lastLevel = null;
  let signal = "WAIT", reason = "No pattern";

  for (let i = 1; i < N; i++) {
    const t = candles[i].time;
    const d = t != null ? String(t).slice(0, 10) : null;
    const mins = timeToMinutes(t);

    if (d !== day) {
      day = d;
      inTrade = false; stop = null; breakLevel = null; tradesToday = 0;
      peakHigh = null; nextRung = null;
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

    if (inTrade) {
      if (mins != null && mins >= EOD_EXIT_MIN) {
        signal = "SELL";
        reason = "EOD square-off at 15:20";
        inTrade = false;
      } else if (C[i] <= stop) {
        signal = "SELL";
        reason = `close below pattern stop (${stop.toFixed(2)})`;
        inTrade = false;
      } else if (ladder) {
        signal = "REENTER";
        reason = `Ladder: close ${C[i].toFixed(2)} above +${STEP_PCT * 100}% rung ${nextRung.toFixed(2)} (peak ${peakHigh.toFixed(2)})`;
      }
    } else {
      // Fresh patterns FIRST — a new breakout outranks resurrection.
      // If reenter were checked first, one big candle crossing both the
      // old level and a new ceiling would eat the fresh pattern's cross.
      if (tradesToday < MAX_TRADES_PER_DAY
          && (mins == null || mins < NO_ENTRY_AFTER)) {
        const tri = findTriangleBreakout(H, L, C, i);
        if (tri) {
          lastLevel = tri.resistance;
          const sameLevel = breakLevel != null
            && Math.abs(tri.resistance - breakLevel) / breakLevel < 0.01;
          if (sameLevel) {
            // Same structure re-detected at the old level — not a new
            // trade, and resurrection is disabled, so emit nothing.
          } else {
            signal = "BUY";
            reason = `Ascending triangle breakout above ${tri.resistance.toFixed(2)} (${tri.len} bars, stop ${tri.support.toFixed(2)})`;
            inTrade = true;
            stop = tri.support;
            breakLevel = tri.resistance;
            peakHigh = H[i];
            nextRung = H[i] * (1 + STEP_PCT);
            tradesToday++;
          }
        }
      }
      if (signal === "WAIT" && ladder) {
        signal = "REENTER";
        reason = `Ladder: close ${C[i].toFixed(2)} above +${STEP_PCT * 100}% rung ${nextRung.toFixed(2)} (peak ${peakHigh.toFixed(2)})`;
      }
    }

    // Rung fired → hang the next one off the new peak
    if (ladder) nextRung = peakHigh * (1 + STEP_PCT);
  }

  return {
    signal,
    reason,
    inTrade,
    stop,
    tradesToday,
    level: lastLevel,
    close: C[N - 1]
  };
}

module.exports = { ascendingTriangle };
