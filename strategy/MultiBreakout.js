// =============================================================================
// MultiBreakout — Unified All-In-One Breakout Strategy (First Come, First Served)
//
// Combines all 5 breakout engines into a single single-position strategy:
//   1. ORB (Opening Range Breakout, 09:30–11:30)
//   2. Bull Flag (Fast momentum pole + tight consolidation)
//   3. Ascending Triangle (Flat resistance + higher lows)
//   4. Cup & Handle (Rounded accumulation + handle)
//   5. W / Double Bottom (Support reversal above neckline)
//
// Rules:
//   - First Come, First Served: whichever confirmed pattern breaks out first
//     takes the trade and locks inTrade = true.
//   - 1-Candle Confirmation + Momentum Push: price must push at least
//     Math.max(5, level * 0.03) (3% or 5 pts) above breakout level within 2 bars.
//   - 2-Tier Exit:
//     * Soft Stop: 2 consecutive closes below breakout level (protects retests).
//     * Hard Stop: close <= -5% from entry price (emergency cut).
//     * EOD: 15:20 square-off.
//   - Continuation:
//     * +5% ladder REENTERs gated by GREEN UT Bot (Key=2, ATR=10).
//     * Frozen REEXIT at peak - 5% locked at REENTER time.
//   - No daily trade cap (trades any valid confirmed pattern before 15:00).
//   - Session wrap (15:29 -> 09:15) or date change resets state cleanly.
// =============================================================================

const {
  findCupBreakout,
  timeToMinutes,
  utBotSeries,
  ORB_START_MIN,
  ORB_END_MIN,
  ORB_ENTRY_CUTOFF,
  ORB_MAX_RANGE_PCT
} = require("./PatternBreakout");

const { findTriangleBreakout } = require("./AscendingTriangle");
const { findFlagBreakout } = require("./BullFlag");
const { findDoubleBottomBreakout } = require("./DoubleBottom");

const NO_ENTRY_AFTER = 15 * 60;      // no new entries after 15:00
const EOD_EXIT_MIN = 15 * 60 + 20;   // square-off 15:20
const STEP_PCT = 0.05;

function multiBreakout(candles) {
  if (!candles || candles.length < 20) {
    return { signal: "WAIT", reason: "Not enough data (need 20+)" };
  }

  const N = candles.length;
  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));

  const green = utBotSeries(H, L, C, 2, 10);

  let day = null;
  let orbHigh = null, orbLow = null, orbSealed = false, orbTraded = false;
  let inTrade = false, stop = null, breakLevel = null, tradesToday = 0, entryPrice = null;
  let peakHigh = null;
  let nextRung = null;
  let reexitLevel = null;
  let lastPattern = null;
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
      orbHigh = orbLow = null; orbSealed = false; orbTraded = false;
      inTrade = false; stop = null; breakLevel = null; tradesToday = 0; entryPrice = null;
      peakHigh = null; nextRung = null; reexitLevel = null;
    }
    prevMins = mins;

    // ── Build Opening Range ──
    if (!orbSealed && mins != null) {
      if (mins >= ORB_START_MIN && mins < ORB_END_MIN) {
        orbHigh = orbHigh == null ? H[i] : Math.max(orbHigh, H[i]);
        orbLow  = orbLow  == null ? L[i] : Math.min(orbLow,  L[i]);
      } else if (mins >= ORB_END_MIN) {
        orbSealed = true;
        if (orbHigh == null || orbLow == null || orbHigh <= orbLow
            || (orbHigh - orbLow) / orbLow > ORB_MAX_RANGE_PCT) {
          orbHigh = orbLow = null;
        }
      }
    }

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
        let patternFound = null; // { name, level, stop, reason }

        // 1. ORB Check (Morning range break, 09:30–11:30)
        if (!patternFound && !orbTraded && orbHigh != null && mins != null
            && mins >= ORB_END_MIN && mins <= ORB_ENTRY_CUTOFF) {
          const orbPush = Math.max(5, orbHigh * 0.03);
          const orbReq = orbHigh + orbPush;
          const orb1 = i >= 2 && C[i - 1] > orbHigh && C[i - 2] <= orbHigh && C[i] > orbHigh && (C[i - 1] >= orbReq || C[i] >= orbReq);
          const orb2 = !orb1 && i >= 3 && C[i - 2] > orbHigh && C[i - 3] <= orbHigh && C[i - 1] > orbHigh && C[i] >= orbReq;
          if (orb1 || orb2) {
            patternFound = {
              name: "ORB",
              level: orbHigh,
              stop: orbLow,
              reason: `ORB breakout above 9:15-9:30 range high ${orbHigh.toFixed(2)} (confirmed push)`
            };
            orbTraded = true;
          }
        }

        // 2. Bull Flag (Fast momentum continuation)
        if (!patternFound) {
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
            patternFound = {
              name: "BULL_FLAG",
              level: flag.flagHigh,
              stop: flag.flagLow,
              reason: `Bull flag breakout above ${flag.flagHigh.toFixed(2)} (pole ${flag.poleLen} bars +${(flag.gainPct * 100).toFixed(0)}%, flag ${flag.flagLen}, confirmed push)`
            };
          }
        }

        // 3. Ascending Triangle (Flat resistance + rising lows)
        if (!patternFound) {
          const tri1 = i >= 2 ? findTriangleBreakout(H, L, C, i - 1) : null;
          const tri2 = !tri1 && i >= 3 ? findTriangleBreakout(H, L, C, i - 2) : null;
          let tri = null;
          if (tri1) {
            const req = tri1.resistance + Math.max(5, tri1.resistance * 0.03);
            if (C[i] > tri1.resistance && (C[i - 1] >= req || C[i] >= req)) tri = tri1;
          } else if (tri2) {
            const req = tri2.resistance + Math.max(5, tri2.resistance * 0.03);
            if (C[i - 1] > tri2.resistance && C[i] > tri2.resistance && C[i] >= req) tri = tri2;
          }
          if (tri) {
            patternFound = {
              name: "ASCENDING_TRIANGLE",
              level: tri.resistance,
              stop: tri.support,
              reason: `Ascending triangle breakout above ${tri.resistance.toFixed(2)} (${tri.len} bars, confirmed push)`
            };
          }
        }

        // 4. Cup & Handle (Rounded accumulation)
        if (!patternFound) {
          const cup1 = i >= 2 ? findCupBreakout(H, L, C, i - 1) : null;
          const cup2 = !cup1 && i >= 3 ? findCupBreakout(H, L, C, i - 2) : null;
          let cup = null;
          if (cup1) {
            const req = cup1.rimHigh + Math.max(5, cup1.rimHigh * 0.03);
            if (C[i] > cup1.rimHigh && (C[i - 1] >= req || C[i] >= req)) cup = cup1;
          } else if (cup2) {
            const req = cup2.rimHigh + Math.max(5, cup2.rimHigh * 0.03);
            if (C[i - 1] > cup2.rimHigh && C[i] > cup2.rimHigh && C[i] >= req) cup = cup2;
          }
          if (cup) {
            patternFound = {
              name: "CUP_HANDLE",
              level: cup.rimHigh,
              stop: cup.handleLow,
              reason: `Cup & handle breakout above rim ${cup.rimHigh.toFixed(2)} (cup ${cup.cupLen} bars, confirmed push)`
            };
          }
        }

        // 5. W / Double Bottom (Support reversal above neckline)
        if (!patternFound) {
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
            patternFound = {
              name: "DOUBLE_BOTTOM",
              level: db.neckline,
              stop: db.support,
              reason: `Double bottom (W) breakout above neckline ${db.neckline.toFixed(2)} (${db.len} bars, confirmed push)`
            };
          }
        }

        // Enter trade if any pattern qualified
        if (patternFound) {
          lastLevel = patternFound.level;
          lastPattern = patternFound.name;
          const sameLevel = breakLevel != null
            && Math.abs(patternFound.level - breakLevel) / breakLevel < 0.01;
          if (!sameLevel) {
            signal = "BUY";
            reason = patternFound.reason;
            inTrade = true;
            entryPrice = C[i];
            stop = patternFound.stop;
            breakLevel = patternFound.level;
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
    pattern: lastPattern,
    close: C[N - 1]
  };
}

module.exports = { multiBreakout };
