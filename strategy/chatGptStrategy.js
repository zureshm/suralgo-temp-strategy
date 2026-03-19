function calculateEMA(period, prices) {
  const k = 2 / (period + 1)

  let ema = prices[0]

  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k)
  }

  return ema
}

function calculateMACD(closes) {
  const emaFast = calculateEMA(6, closes)
  const emaSlow = calculateEMA(26, closes)

  const macdLine = emaFast - emaSlow

  // simple signal approximation using last 9 closes
  const recent = closes.slice(-9)
  const macdSeries = recent.map((_, i) => {
    const sub = closes.slice(0, closes.length - 9 + i + 1)
    return calculateEMA(6, sub) - calculateEMA(26, sub)
  })

  const signalLine = calculateEMA(9, macdSeries)

  return { macdLine, signalLine }
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null

  let sum = 0

  for (let i = candles.length - period; i < candles.length; i++) {
    const high = Number(candles[i].high)
    const low = Number(candles[i].low)
    const prevClose = Number(candles[i - 1].close)

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    )

    sum += tr
  }

  return sum / period
}

function evaluateEMACross(candles) {
  if (!candles || candles.length < 30) {
    return {
      signal: "WAIT",
      ema10: null,
      ema20: null
    }
  }

  const closes = candles.map((c) => Number(c.close))
  const lastCandle = candles[candles.length - 1]

  // EMA
  const prevCloses = closes.slice(0, closes.length - 1)

  const ema10_prev = calculateEMA(10, prevCloses)
  const ema20_prev = calculateEMA(20, prevCloses)

  const ema10_now = calculateEMA(10, closes)
  const ema20_now = calculateEMA(20, closes)

  // MACD
  const { macdLine, signalLine } = calculateMACD(closes)

  // ATR sideways filter
  const atr = calculateATR(candles)
  let sideways = false

  if (atr !== null) {
    const recentHigh = Math.max(...candles.slice(-14).map(c => Number(c.high)))
    const recentLow = Math.min(...candles.slice(-14).map(c => Number(c.low)))
    const range = recentHigh - recentLow

    sideways = range < atr * 2
  }

  const isGreen = Number(lastCandle.close) > Number(lastCandle.open)
  const isRed = Number(lastCandle.close) < Number(lastCandle.open)

  // BUY
  if (
    ema10_prev <= ema20_prev &&
    ema10_now > ema20_now &&
    macdLine > signalLine &&
    !sideways &&
    isGreen
  ) {
    return {
      signal: "BUY",
      ema10: ema10_now,
      ema20: ema20_now
    }
  }

  // SELL
  if (
    ema10_prev >= ema20_prev &&
    ema10_now < ema20_now &&
    macdLine < signalLine &&
    !sideways &&
    isRed
  ) {
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