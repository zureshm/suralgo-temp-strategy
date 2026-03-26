require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { evaluateEMACross } = require("./strategy/evaluateEMACross");
const { surStrategy } = require("./strategy/surStrategy");
const { chatGptStrategy } = require("./strategy/chatGptStrategy");

const app = express();

app.use(express.json());
app.use(cors());

const PORT = 4000;

// Store candles separately for each symbol
const candleHistoryBySymbol = {};

// Store latest evaluation separately for each symbol
const latestEvaluationBySymbol = {};

app.get("/", (req, res) => {
  res.send("Strategy engine running");
});

app.get("/evaluate", (req, res) => {
  const requestedSymbol = req.query.symbol;

  // If no symbol provided, return a simple engine status
  if (!requestedSymbol) {
    return res.json({
      message: "Strategy engine running",
      engineStatus: "running",
    });
  }

  const candles = candleHistoryBySymbol[requestedSymbol] || [];
  const latestEvaluation = latestEvaluationBySymbol[requestedSymbol];

  // If symbol has no data yet, return empty state
  if (!latestEvaluation) {
    return res.json({
      symbol: requestedSymbol,
      signal: "WAIT",
      ema10: null,
      ema20: null,
      candleCount: 0,
      lastCandleTime: null,
      engineStatus: "no-data",
      candles: [],
    });
  }

  return res.json({
    ...latestEvaluation,
    candles: candles.slice(-5),
  });
});

app.post("/evaluate", (req, res) => {
  const candle = req.body.candle;
  const symbol = req.body.symbol;

  // Symbol and candle must both be present
  if (!symbol || !candle) {
    return res.status(400).json({
      message: "symbol and candle are required",
    });
  }

  // Candle must contain all required fields
  if (
    candle.time === undefined ||
    candle.open === undefined ||
    candle.high === undefined ||
    candle.low === undefined ||
    candle.close === undefined
  ) {
    return res.status(400).json({
      message: "candle must contain time, open, high, low, close",
    });
  }

  // Create symbol bucket first time this symbol comes in
  if (!candleHistoryBySymbol[symbol]) {
    candleHistoryBySymbol[symbol] = [];
  }

  const candles = candleHistoryBySymbol[symbol];

  // Prevent duplicate candle time for same symbol
  const lastSavedTime = candles[candles.length - 1]?.time;

  if (lastSavedTime === candle.time) {
    return res.json({
      ...(latestEvaluationBySymbol[symbol] || {
        symbol,
        signal: "WAIT",
        ema10: null,
        ema20: null,
        candleCount: candles.length,
        lastCandleTime: candle.time,
      }),
      engineStatus: "duplicate-candle",
    });
  }

  const normalizedCandle = {
    time: candle.time,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
  };

  candles.push(normalizedCandle);

  const result = evaluateEMACross(candles);

  latestEvaluationBySymbol[symbol] = {
    symbol,
    ...result,
    candleCount: candles.length,
    lastCandleTime: normalizedCandle.time,
    engineStatus: "running",
  };

  console.log("New candle received for:", symbol);
  console.log("New candle received:", normalizedCandle);
  console.log("Strategy result:", latestEvaluationBySymbol[symbol]);

  res.json(latestEvaluationBySymbol[symbol]);
});

app.get("/reset-engine", (req, res) => {
  // Clear all symbols from candle history
  for (const symbol in candleHistoryBySymbol) {
    delete candleHistoryBySymbol[symbol];
  }

  // Clear all symbols from latest evaluations
  for (const symbol in latestEvaluationBySymbol) {
    delete latestEvaluationBySymbol[symbol];
  }

  res.json({ message: "Strategy engine reset successful" });
});

app.listen(PORT, () => {
  console.log(`Strategy engine running on port ${PORT}`);
});