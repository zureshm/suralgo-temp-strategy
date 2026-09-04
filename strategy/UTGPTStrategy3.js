// =============================================================================
// UTGPTStrategy3 — Heikin-Ashi Candle Pattern Strategy (No UT Bots)
//
// Candles are converted to Heikin-Ashi before evaluation.
//
// BUY:      A series of consecutive green HA candles (no red HA candles
//           in between), where at least 3 of those green candles have:
//             - Height (HA high - HA low) >= 3% of the candle's HA close.
//             - No bottom wick (HA low === HA open).
//           Example: if price is 100, 3% = 3 points. If price is 200,
//           3% = 6 points. At least 3 qualifying candles → BUY.
//           Signal fires on the candle where the 3rd qualifying candle
//           completes, triggering a buy at the start of the next candle.
//
// SELL:     3 consecutive red HA candles, with at least 1 of those
//           candles having height >= 3% of its HA close price.
// =============================================================================

// ── Main strategy ────────────────────────────────────────────────────────────

function utGptStrategy3(candles) {
  if (!candles || candles.length < 30) {
    return { signal: "WAIT", reason: "Not enough data (need 30+)" };
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

  const N = ha.length;
  let lastSignal = "WAIT", lastReason = "No signal";

  // Track consecutive green/red candle streaks
  let greenStreak = 0;
  let greenQualifying = 0;  // count of green candles with >=3% height AND no bottom wick
  let redStreak = 0;
  let redHasBigCandle = false;  // at least 1 red candle with >=3% height in current streak

  for (let i = 0; i < N; i++) {
    const haOpen  = ha[i].open;
    const haHigh  = ha[i].high;
    const haLow   = ha[i].low;
    const haClose = ha[i].close;

    const isGreen = haClose > haOpen;
    const isRed   = haClose < haOpen;
    const height  = haHigh - haLow;
    const threshold = haClose * 0.03;  // 3% of candle's HA close
    const hasBottomWick = haLow < haOpen;  // green candle has bottom wick if low < open

    let sig = "WAIT", reason = "No signal";

    if (isGreen) {
      redStreak = 0;
      redHasBigCandle = false;
      greenStreak++;

      // Qualifying green candle: height >= 3% of close AND no bottom wick
      if (height >= threshold && !hasBottomWick) {
        greenQualifying++;
      }

      // BUY: at least 3 qualifying green candles in the current consecutive streak
      if (greenQualifying >= 3) {
        sig = "BUY";
        reason = greenQualifying + " qualifying green HA candles (>=3% height, no bottom wick) in streak of " + greenStreak;
      }
    } else if (isRed) {
      greenStreak = 0;
      greenQualifying = 0;
      redStreak++;

      // Check if this red candle has height >= 3% of close
      if (height >= threshold) {
        redHasBigCandle = true;
      }

      // SELL: 3 consecutive red HA candles, at least 1 with >=3% height
      if (redStreak >= 3 && redHasBigCandle) {
        sig = "SELL";
        reason = "3 consecutive red HA candles, at least 1 with >=3% height";
      }
    } else {
      // Doji (HA open === HA close) — reset both streaks
      greenStreak = 0;
      greenQualifying = 0;
      redStreak = 0;
      redHasBigCandle = false;
    }

    lastSignal = sig;
    lastReason = reason;
  }

  return {
    signal: lastSignal,
    reason: lastReason,
    close: ha[N - 1].close,
    haOpen: ha[N - 1].open,
    haHigh: ha[N - 1].high,
    haLow: ha[N - 1].low
  };
}

module.exports = { utGptStrategy3 };
