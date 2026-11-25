// =============================================================================
// MultiBreakout — all breakout patterns in one standalone engine
//
// Pure price-pattern strategy on NORMAL candles. No external imports.
//
// Patterns (all use fresh-close cross + 1–2 candle confirmed push):
//   1. ORB  — 09:15–09:29 range, BUY close above range high (09:30–11:30).
//             Stop: range low. Max 1 ORB entry per day (orbTraded flag).
//   2. Cup & Handle — 30–120 bar cup, 3–15 bar handle, BUY above rim.
//             Stop: handle low.
//   3. Bull Flag — 5–15 bar pole (8–60% rise) + 3–15 bar tight flag,
//             BUY above flag high. Stop: flag low.
//
// Entry rule (shared):
//   - Detectors run EVERY candle while flat — inTrade never blocks scanning.
//   - First pattern to confirm wins (ORB checked first, then Cup, Flag).
//   - Confirmed push: within 2 candles of the cross, close must reach
//     level + max(5, level*0.03) while staying above the level.
//   - No new entries after NO_ENTRY_AFTER (15:00).
//
// Exit rule (shared):
//   - SELL on EOD 15:20, hard stop (−5% from entry), 2 closes below
//     breakLevel (soft stop), or close below pattern stop.
//   - LADDER REENTER: each +5% extension above peak re-arms a rung;
//     close above rung AND GREEN UT Bot (Key=2, ATR=10) → REENTER.
//   - REEXIT: frozen line at peak−5% captured at REENTER time.
//   - Day change / session wrap resets all state.
// =============================================================================

function timeToMinutes(timeStr) {
  if (!timeStr) return null;
  const m = /(\d{1,2}):(\d{2})/.exec(String(timeStr));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// ── UT Bot (Key Value × ATR trailing stop) ───────────────────────────────────

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

// ── Confirmed-push helper ────────────────────────────────────────────────────
// Given a detector hit found at bar j (cross happened at j), decide whether
// bar i confirms it: price must hold above `level` and reach
// level + max(5, level*0.03) on bar j or bar i.
// hitAt = i-1 → candle i is the 2nd candle; hitAt = i-2 → candle i-1 was 2nd.

function pushReq(level) { return level + Math.max(5, level * 0.03); }

function confirmPush(Hit, levelFn, H, L, C, i, hitAt) {
  if (!Hit) return null;
  const level = levelFn(Hit);
  const req = pushReq(level);
  if (hitAt === i - 1) {
    // cross candle is i-1; current candle i must stay above and push must be met
    if (C[i] > level && (C[i - 1] >= req || C[i] >= req)) return Hit;
  } else if (hitAt === i - 2) {
    // cross candle i-2, middle candle i-1, current i
    if (C[i - 1] > level && C[i] > level && C[i] >= req) return Hit;
  }
  return null;
}

// ── Detector 1: Cup & Handle ─────────────────────────────────────────────────

const CUP_MIN_LEN = 30, CUP_MAX_LEN = 120, RIM_BARS = 5;
const HANDLE_MIN_LEN = 3, HANDLE_MAX_LEN = 15;
const CUP_MIN_DEPTH = 0.03, CUP_MAX_DEPTH = 0.25;
const RIM_TOL_PCT = 0.07;
const HANDLE_ABOVE_RIM = 1.02;
const HANDLE_MAX_RETRACE = 0.5;

function findCupBreakout(H, L, C, i) {
  for (let hl = HANDLE_MIN_LEN; hl <= HANDLE_MAX_LEN; hl++) {
    const cupEnd = i - hl;
    if (cupEnd - CUP_MIN_LEN < 0) continue;

    let handleLow = Infinity, handleHigh = -Infinity;
    for (let j = cupEnd; j < i; j++) {
      if (L[j] < handleLow) handleLow = L[j];
      if (H[j] > handleHigh) handleHigh = H[j];
    }

    let rightRim = -Infinity;
    for (let j = cupEnd - RIM_BARS; j < cupEnd; j++) {
      if (H[j] > rightRim) rightRim = H[j];
    }

    const s0 = cupEnd - CUP_MIN_LEN;
    let bottom = Infinity, bottomIdx = -1;
    for (let j = s0 + RIM_BARS; j <= cupEnd - RIM_BARS - 1; j++) {
      if (L[j] < bottom) { bottom = L[j]; bottomIdx = j; }
    }

    const sMin = Math.max(0, cupEnd - CUP_MAX_LEN);
    for (let s = s0; s >= sMin; s--) {
      const ni = s + RIM_BARS;
      if (L[ni] < bottom) { bottom = L[ni]; bottomIdx = ni; }

      let leftRim = -Infinity;
      for (let j = s; j < s + RIM_BARS; j++) if (H[j] > leftRim) leftRim = H[j];

      const rimHigh = Math.max(leftRim, rightRim);
      const rimLow  = Math.min(leftRim, rightRim);
      if (!(rimLow > 0)) continue;
      if ((rimHigh - rimLow) / rimLow > RIM_TOL_PCT) continue;

      const depth = rimLow - bottom;
      const depthPct = depth / rimLow;
      if (depthPct < CUP_MIN_DEPTH || depthPct > CUP_MAX_DEPTH) continue;

      const span = cupEnd - s;
      const pos = (bottomIdx - s) / span;
      if (pos < 0.30 || pos > 0.70) continue;

      if (handleLow < rimLow - HANDLE_MAX_RETRACE * depth) continue;
      if (handleHigh > rimHigh * HANDLE_ABOVE_RIM) continue;

      if (C[i] > rimHigh && C[i - 1] <= rimHigh) {
        return { rimHigh, handleLow, cupLen: span, handleLen: hl };
      }
    }
  }
  return null;
}

// ── Detector 2: Bull Flag ────────────────────────────────────────────────────

const POLE_MIN_LEN = 5, POLE_MAX_LEN = 15;
const FLAG_MIN_LEN = 3, FLAG_MAX_LEN = 15;
const POLE_MIN_PCT = 0.08, POLE_MAX_PCT = 0.60;
const FLAG_MAX_RETRACE = 0.5;
const FLAG_ABOVE_TOP = 1.03;
const FLAG_TIGHT = 0.6;

function findFlagBreakout(H, L, C, i) {
  for (let fl = FLAG_MIN_LEN; fl <= FLAG_MAX_LEN; fl++) {
    const poleEnd = i - fl;
    if (poleEnd - POLE_MIN_LEN < 0) continue;

    let flagLow = Infinity, flagHigh = -Infinity;
    for (let j = poleEnd; j < i; j++) {
      if (L[j] < flagLow) flagLow = L[j];
      if (H[j] > flagHigh) flagHigh = H[j];
    }
    if (!(flagHigh > 0)) continue;

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

      if (flagLow < poleTop - FLAG_MAX_RETRACE * gain) continue;
      if (flagHigh > poleTop * FLAG_ABOVE_TOP) continue;
      if (flagHigh - flagLow > FLAG_TIGHT * gain) continue;

      if (C[i] > flagHigh && C[i - 1] <= flagHigh) {
        return { flagHigh, flagLow, poleLen, flagLen: fl, gainPct };
      }
    }
  }
  return null;
}

// ── Main strategy ────────────────────────────────────────────────────────────

const ORB_START_MIN = 9 * 60 + 15;      // 09:15
const ORB_END_MIN = 9 * 60 + 30;        // 09:30 (range covers t < 09:30)
const ORB_ENTRY_CUTOFF = 11 * 60 + 30;  // no ORB entries after 11:30
const ORB_MAX_RANGE_PCT = 0.08;
const NO_ENTRY_AFTER = 15 * 60;         // no new entries after 15:00
const EOD_EXIT_MIN = 15 * 60 + 20;      // square-off 15:20
const STEP_PCT = 0.05;                  // each 5% extension above peak = REENTER rung

function multiBreakout(candles) {
  if (!candles || candles.length < 20) {
    return { signal: "WAIT", reason: "Not enough data (need 20+)" };
  }

  const N = candles.length;
  const H = candles.map(c => Number(c.high));
  const L = candles.map(c => Number(c.low));
  const C = candles.map(c => Number(c.close));

  const green = utBotSeries(H, L, C, 2, 10);   // GREEN UT Bot — gates ladder REENTERs

  let day = null;
  let orbHigh = null, orbLow = null, orbSealed = false, orbTraded = false;
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

    // New session: date changed or time jumped back > 60 min (15:29 → 09:15)
    if (d !== day || (mins != null && prevMins != null && mins < prevMins - 60)) {
      day = d;
      orbHigh = orbLow = null; orbSealed = false; orbTraded = false;
      inTrade = false; stop = null; breakLevel = null; tradesToday = 0; entryPrice = null;
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
          orbHigh = orbLow = null;
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
      // All detectors evaluated every flat candle — first confirmed wins.
      if (mins == null || mins < NO_ENTRY_AFTER) {
        let entry = null; // { stop, level, reason }

        // ── 1. ORB ──
        if (!entry && !orbTraded && orbHigh != null && mins != null
            && mins >= ORB_END_MIN && mins <= ORB_ENTRY_CUTOFF) {
          const orb1 = i >= 2 && C[i - 1] > orbHigh && C[i - 2] <= orbHigh && C[i] > orbHigh
            && (C[i - 1] >= pushReq(orbHigh) || C[i] >= pushReq(orbHigh));
          const orb2 = !orb1 && i >= 3 && C[i - 2] > orbHigh && C[i - 3] <= orbHigh
            && C[i - 1] > orbHigh && C[i] >= pushReq(orbHigh);
          if (orb1 || orb2) {
            entry = {
              stop: orbLow, level: orbHigh, isOrb: true,
              reason: `ORB breakout: close above 9:15-9:30 range high ${orbHigh.toFixed(2)} (confirmed push)`
            };
          }
        }

        // ── 2. Cup & Handle ──
        if (!entry) {
          const cup1 = i >= 2 ? findCupBreakout(H, L, C, i - 1) : null;
          const cup2 = !cup1 && i >= 3 ? findCupBreakout(H, L, C, i - 2) : null;
          const cup = confirmPush(cup1, h => h.rimHigh, H, L, C, i, i - 1)
            || confirmPush(cup2, h => h.rimHigh, H, L, C, i, i - 2);
          if (cup) {
            entry = {
              stop: cup.handleLow, level: cup.rimHigh,
              reason: `Cup & handle breakout above rim ${cup.rimHigh.toFixed(2)} (cup ${cup.cupLen} bars, confirmed push)`
            };
          }
        }

        // ── 3. Bull Flag ──
        if (!entry) {
          const fl1 = i >= 2 ? findFlagBreakout(H, L, C, i - 1) : null;
          const fl2 = !fl1 && i >= 3 ? findFlagBreakout(H, L, C, i - 2) : null;
          const fl = confirmPush(fl1, h => h.flagHigh, H, L, C, i, i - 1)
            || confirmPush(fl2, h => h.flagHigh, H, L, C, i, i - 2);
          if (fl) {
            entry = {
              stop: fl.flagLow, level: fl.flagHigh,
              reason: `Bull flag breakout above ${fl.flagHigh.toFixed(2)} (pole ${fl.poleLen} bars +${(fl.gainPct * 100).toFixed(0)}%, flag ${fl.flagLen}, confirmed push)`
            };
          }
        }

        if (entry) {
          lastLevel = entry.level;
          const sameLevel = breakLevel != null
            && Math.abs(entry.level - breakLevel) / breakLevel < 0.01;
          if (!sameLevel) {
            signal = "BUY";
            reason = entry.reason;
            inTrade = true;
            entryPrice = C[i];
            stop = entry.stop;
            breakLevel = entry.level;
            if (entry.isOrb) orbTraded = true;
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
    orbHigh,
    orbLow,
    level: lastLevel,
    close: C[N - 1]
  };
}

module.exports = {
  multiBreakout,
  patternBreakout: multiBreakout
};
