// =============================================================================
// BullFlag — steep impulse + tight flag consolidation, breakout above the flag
//
// Pure price-pattern strategy on NORMAL candles. No volume, VWAP, or MA
// dependencies — behaves identically on FAKE_CE/FAKE_PE and real symbols.
//
// Bull flag (any time of day):
//   Rolling detection on the candle array:
//   - pole:    5–15 candles ending just before the flag; total rise
//              (max high − min low of the pole) must be 8–60% of the base —
//              a real impulse, not drift.
//   - flag:    3–15 candles after the pole; highs stay ≤ 3% above the pole
//              top, lows retrace ≤ 50% of the pole gain, and the flag's own
//              range stays tight (≤ 60% of the pole gain).
//   - BUY on a fresh close above the flag high (previous close at/below).
//   Stop: close below the flag low.
//
// Shared (identical contract to PatternBreakout / AscendingTriangle):
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

// ── Bull flag detector ───────────────────────────────────────────────────────
// Checks whether bar i is a fresh flag breakout. Scans flag lengths 3–15 and
// pole lengths 5–15. Returns { flagHigh, flagLow, poleLen, flagLen, gainPct }.

const POLE_MIN_LEN = 5, POLE_MAX_LEN = 15;
const FLAG_MIN_LEN = 3, FLAG_MAX_LEN = 15;
const POLE_MIN_PCT = 0.08, POLE_MAX_PCT = 0.60;
const FLAG_MAX_RETRACE = 0.5;    // flag lows ≥ poleTop − 50% of the pole gain
const FLAG_ABOVE_TOP = 1.03;     // flag highs ≤ poleTop × 1.03
const FLAG_TIGHT = 0.6;          // flag range ≤ 60% of the pole gain

function findFlagBreakout(H, L, C, i) {
  for (let fl = FLAG_MIN_LEN; fl <= FLAG_MAX_LEN; fl++) {
    const poleEnd = i - fl;                  // flag [poleEnd .. i-1]
    if (poleEnd - POLE_MIN_LEN < 0) continue;

    // flag stats
    let flagLow = Infinity, flagHigh = -Infinity;
    for (let j = poleEnd; j < i; j++) {
      if (L[j] < flagLow) flagLow = L[j];
      if (H[j] > flagHigh) flagHigh = H[j];
    }
    if (!(flagHigh > 0)) continue;

    // grow the pole leftwards, tracking its extremes incrementally
    let poleTop = -Infinity, poleBase = Infinity;
    const sMin = Math.max(0, poleEnd - POLE_MAX_LEN);
    for (let s = poleEnd - 1; s >= sMin; s--) {
      if (H[s] > poleTop) poleTop = H[s];
      if (L[s] < poleBase) poleBase = L[s];
      const poleLen = poleEnd - s;
      if (poleLen < POLE_MIN_LEN) continue;

      const gain = poleTop - poleBase;
      const gainPct = gain / poleBase;
      if (gainPct < POLE_MIN_PCT || gainPct > POLE_MAX_PCT) continue;

      // flag must hold the pole: shallow retrace, no overshoot, tight range
      if (flagLow < poleTop - FLAG_MAX_RETRACE * gain) continue;
      if (flagHigh > poleTop * FLAG_ABOVE_TOP) continue;
      if (flagHigh - flagLow > FLAG_TIGHT * gain) continue;

      if (C[i] > flagHigh && C[i - 1] <= flagHigh) {  // fresh cross above flag
        return { flagHigh, flagLow, poleLen, flagLen: fl, gainPct };
      }
    }
  }
  return null;
}

// ── Main strategy ────────────────────────────────────────────────────────────

const NO_ENTRY_AFTER = 15 * 60;      // no new entries after 15:00
const EOD_EXIT_MIN = 15 * 60 + 20;   // square-off 15:20
const MAX_TRADES_PER_DAY = 3;
const STEP_PCT = 0.05;               // each 5% extension above the peak = a REENTER rung

function bullFlag(candles) {
  if (!candles || candles.length < 20) {
    return { signal: "WAIT", reason: "Not enough data (need 20+)" };
  }

  const N = candles.length;
  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));

  const green = utBotSeries(H, L, C, 2, 10);   // GREEN UT Bot (Key=2, ATR=10) — gates ladder REENTERs

  let day = null;
  let inTrade = false, stop = null, breakLevel = null, tradesToday = 0, entryPrice = null;
  let peakHigh = null;   // highest high since the last entry
  let nextRung = null;   // peakHigh × (1 + STEP_PCT) — next ladder trigger
  let reexitLevel = null; // frozen exit line for an open REENTER (peak at fire time − STEP_PCT)
  let lastLevel = null;
  let signal = "WAIT", reason = "No pattern";

  let prevMins = null;
  for (let i = 1; i < N; i++) {
    const t = candles[i].time;
    const ts = t != null ? String(t) : "";
    const hasDate = /\d{4}-\d{2}-\d{2}/.test(ts);
    const d = hasDate ? ts.slice(0, 10) : "session";
    const mins = timeToMinutes(t);

    // New session: date changed or time jumped back > 60 min (15:29 → 09:15)
    if (d !== day || (mins != null && prevMins != null && mins < prevMins - 60)) {
      day = d;
      inTrade = false; stop = null; breakLevel = null; tradesToday = 0; entryPrice = null;
      peakHigh = null; nextRung = null; reexitLevel = null;
    }
    prevMins = mins;

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
      const hardStop = entryPrice != null ? entryPrice * 0.95 : stop;
      const softStop = breakLevel != null && C[i] < breakLevel && C[i - 1] < breakLevel;

      if (mins != null && mins >= EOD_EXIT_MIN) {
        signal = "SELL";
        reason = "EOD square-off at 15:20";
        inTrade = false;
      } else if (hardStop != null && C[i] <= hardStop) {
        signal = "SELL";
        reason = `hard stop hit: close ${C[i].toFixed(2)} <= -5% floor (${hardStop.toFixed(2)})`;
        inTrade = false;
      } else if (softStop) {
        signal = "SELL";
        reason = `breakout failure: 2 closes below level ${breakLevel.toFixed(2)} (${C[i].toFixed(2)})`;
        inTrade = false;
      } else if (stop != null && C[i] <= stop) {
        signal = "SELL";
        reason = `close below flag low (${stop.toFixed(2)})`;
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
      // old level and a new flag top would eat the fresh pattern's cross.
      if (mins == null || mins < NO_ENTRY_AFTER) {
        const flag1 = i >= 2 ? findFlagBreakout(H, L, C, i - 1) : null;
        const flag2 = !flag1 && i >= 3 ? findFlagBreakout(H, L, C, i - 2) : null;
        let flag = null;
        if (flag1) {
          const req = flag1.flagHigh + Math.max(5, flag1.flagHigh * 0.03);
          if (C[i] > flag1.flagHigh && (C[i - 1] >= req || C[i] >= req)) flag = flag1;
        } else if (flag2) {
          const req = flag2.flagHigh + Math.max(5, flag2.flagHigh * 0.03);
          if (C[i - 1] > flag2.flagHigh && C[i] > flag2.flagHigh && C[i] >= req) flag = flag2;
        }

        if (flag) {
          lastLevel = flag.flagHigh;
          const sameLevel = breakLevel != null
            && Math.abs(flag.flagHigh - breakLevel) / breakLevel < 0.01;
          if (!sameLevel) {
            signal = "BUY";
            reason = `Bull flag breakout above ${flag.flagHigh.toFixed(2)} (pole ${flag.poleLen} bars +${(flag.gainPct * 100).toFixed(0)}%, flag ${flag.flagLen}, confirmed push)`;
            inTrade = true;
            entryPrice = C[i];
            stop = flag.flagLow;
            breakLevel = flag.flagHigh;
            peakHigh = Math.max(H[i], H[i - 1]);
            nextRung = peakHigh * (1 + STEP_PCT);
            tradesToday++;
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
    level: lastLevel,
    close: C[N - 1]
  };
}

module.exports = { bullFlag };
