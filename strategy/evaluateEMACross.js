function calculateEMA(period, prices) {
  const k = 2 / (period + 1)

  let ema = prices[0]

  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k)
  }

  return ema
}

function evaluateEMACross(candles) {
  if (!candles || candles.length < 21) {
    return {
      signal: "WAIT",
      ema10: null,
      ema20: null
    }
  }

  const closes = candles.map((c) => Number(c.close))

  const prevCloses = closes.slice(0, closes.length - 1)

  const ema10_prev = calculateEMA(8, prevCloses)
  const ema20_prev = calculateEMA(16, prevCloses)

  const ema10_now = calculateEMA(8, closes)
  const ema20_now = calculateEMA(16, closes)

  if (ema10_prev <= ema20_prev && ema10_now > ema20_now) {
    return {
      signal: "BUY",
      ema10: ema10_now,
      ema20: ema20_now
    }
  }

  if (ema10_prev >= ema20_prev && ema10_now < ema20_now) {
    return {
      signal: "SELL",
      ema10: ema10_now,
      ema20: ema20_now
    }
  }

  return {
    signal: "WAIT",
    ema10: ema10_now,
    ema20: ema20_now
  }
}

module.exports = {
  evaluateEMACross
}