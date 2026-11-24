// =============================================================================
// DoubleBottom — W / Double Bottom reversal breakout above the neckline
//
// Pure price-pattern strategy on NORMAL candles. No volume, VWAP, or MA
// dependencies — behaves identically on FAKE_CE/FAKE_PE and real symbols.
//
// W / Double Bottom (any time of day):
//   Rolling detection on the candle array:
//   - window:    20–100 candles ending at bar i-1.
//   - Trough 1:  left bottom (min low in the first 40% of the window).
//   - Peak:      neckline (max high in the middle span between troughs).
//   - Trough 2:  right bottom (min low in the last 40% of the window).
//   - tolerance: Trough 1 and Trough 2 lows within 3% of each other.
//   - depth:     neckline to support depth between 3% and 25%.
//   - BUY on a fresh close above the neckline (previous close at/below).
//   Stop: close below Trough 2 low.
//
// Shared:
//   - No daily entry cap (fires on any valid fresh breakout before 15:00).
//   - No new entries after NO_ENTRY_AFTER (15:00).
//   - SELL on stop break, or EOD square-off at EOD_EXIT_MIN (15:20).
//   - REENTERs don't touch inTrade — signal for execution layer.
//   - LADDER (REENTER): each STEP_PCT (5%) extension above the move's
//     peak re-arms the next rung — close above rung AND GREEN UT Bot
//     (Key=2, ATR=10) bullish → REENTER.
//   - REEXIT: frozen exit line at peak − 5% captured at REENTER time.
//   - Session wrap (15:29 → 09:15) or date change resets inTrade and state.
// =============================================================================

const { utBotSeries } = require("./PatternBreakout");

function timeToMinutes(timeStr) {
  if (!timeStr) return null;
  const m = /(\d{1,2}):(\d{2})/.exec(String(timeStr));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// ── Double Bottom detector ───────────────────────────────────────────────────
const W_MIN_LEN = 20, W_MAX_LEN = 100;
const BOTTOM_TOL_PCT = 0.03;       // troughs within 3% of each other
const W_MIN_DEPTH = 0.03, W_MAX_DEPTH = 0.25;

function findDoubleBottomBreakout(H, L, C, i) {
  for (let len = W_MIN_LEN; len <= W_MAX_LEN; len++) {
    const s = i - len; // window [s .. i-1]
    if (s < 0) break;

    // Trough 1 in first 40%
    const endT1 = s + Math.floor(len * 0.40);
    let low1 = Infinity, idxT1 = -1;
    for (let j = s; j < endT1; j++) {
      if (L[j] < low1) { low1 = L[j]; idxT1 = j; }
    }

    // Trough 2 in last 40%
    const startT2 = s + Math.floor(len * 0.60);
    let low2 = Infinity, idxT2 = -1;
    for (let j = startT2; j < i; j++) {
      if (L[j] < low2) { low2 = L[j]; idxT2 = j; }
    }

    if (idxT1 === -1 || idxT2 === -1) continue;

    // Bottoms must be at roughly the same support level (within 3%)
    if (Math.abs(low1 - low2) / Math.max(low1, low2) > BOTTOM_TOL_PCT) continue;

    // Neckline = peak between idxT1 and idxT2
    if (idxT2 - idxT1 < 4) continue; // need at least a few bars between troughs
    let neckline = -Infinity;
    for (let j = idxT1 + 1; j < idxT2; j++) {
      if (H[j] > neckline) neckline = H[j];
    }
    if (!(neckline > Math.max(low1, low2))) continue;

    const baseLow = Math.min(low1, low2);
    const depthPct = (neckline - baseLow) / neckline;
    if (depthPct < W_MIN_DEPTH || depthPct > W_MAX_DEPTH) continue;

    // Fresh breakout above neckline
    if (C[i] > neckline && C[i - 1] <= neckline) {
      return { neckline, support: low2, len };
    }
  }
  return null;
}

// ── Main strategy ────────────────────────────────────────────────────────────
const NO_ENTRY_AFTER = 15 * 60;      // no new entries after 15:00
const EOD_EXIT_MIN = 15 * 60 + 20;   // square-off 15:20
const STEP_PCT = 0.05;

function doubleBottom(candles) {
  if (!candles || candles.length < 20) {
    return { signal: "WAIT", reason: "Not enough data (need 20+)" };
  }

  const N = candles.length;
  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));

  const green = utBotSeries(H, L, C, 2, 10);

  let day = null;
  let inTrade = false, stop = null, breakLevel = null, tradesToday = 0, entryPrice = null;
  let peakHigh = null;
  let nextRung = null;
  let reexitLevel = null;
  let lastLevel = null;
  let signal = "WAIT", reason = "No pattern";

  let prevMins = null;
  for (let i = 1; i < N; i++) {
    const t = candles[i].time;
    const ts = t != null ? String(t) : "";
    const hasDate = /\d{4}-\d{2}-\d{2}/.test(ts);
    const d = hasDate ? ts.slice(0, 10) : "session";
    const mins = timeToMinutes(t);

    if (d !== day || (mins != null && prevMins != null && mins < prevMins - 60)) {
      day = d;
      inTrade = false; stop = null; breakLevel = null; tradesToday = 0; entryPrice = null;
      peakHigh = null; nextRung = null; reexitLevel = null;
    }
    prevMins = mins;

    signal = "WAIT";
    reason = "No pattern";

    if (peakHigh != null && H[i] > peakHigh) peakHigh = H[i];

    const ladder = nextRung != null
      && (mins == null || mins < NO_ENTRY_AFTER)
      && C[i] > nextRung
      && green.pos[i] === 1;

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
      if (mins == null || mins < NO_ENTRY_AFTER) {
        const db1 = i >= 2 ? findDoubleBottomBreakout(H, L, C, i - 1) : null;
        const db2 = !db1 && i >= 3 ? findDoubleBottomBreakout(H, L, C, i - 2) : null;
        let db = null;
        if (db1) {
          const req = db1.neckline + Math.max(5, db1.neckline * 0.03);
          if (C[i] > db1.neckline && (C[i - 1] >= req || C[i] >= req)) db = db1;
        } else if (db2) {
          const req = db2.neckline + Math.max(5, db2.neckline * 0.03);
          if (C[i - 1] > db2.neckline && C[i] > db2.neckline && C[i] >= req) db = db2;
        }

        if (db) {
          lastLevel = db.neckline;
          const sameLevel = breakLevel != null
            && Math.abs(db.neckline - breakLevel) / breakLevel < 0.01;
          if (!sameLevel) {
            signal = "BUY";
            reason = `Double bottom (W) breakout above neckline ${db.neckline.toFixed(2)} (${db.len} bars, confirmed push)`;
            inTrade = true;
            entryPrice = C[i];
            stop = db.support;
            breakLevel = db.neckline;
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

    if (ladder) nextRung = peakHigh * (1 + STEP_PCT);
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

module.exports = {
  doubleBottom,
  findDoubleBottomBreakout
};
