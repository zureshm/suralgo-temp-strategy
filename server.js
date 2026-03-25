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

// hardcoded default symbol used before first candle comes in
const STRATEGY_SYMBOL = "NIFTY 10MAR26 24600 CE";

let candleHistory = [];

let latestEvaluation = {
  symbol: STRATEGY_SYMBOL,
  signal: "WAIT",
  ema10: null,
  ema20: null,
  candleCount: 0,
  lastCandleTime: null,
  engineStatus: "starting",
};

app.get("/", (req, res) => {
  res.send("Strategy engine running");
});

app.get("/evaluate", (req, res) => {
  const requestedSymbol = req.query.symbol;

  // if no symbol provided → return latest
  if (!requestedSymbol) {
    return res.json({
      ...latestEvaluation,
      candles: candleHistory.slice(-5),
    });
  }

  // if symbol matches → return data
  if (requestedSymbol === latestEvaluation.symbol) {
    return res.json({
      ...latestEvaluation,
      candles: candleHistory.slice(-5),
    });
  }

  // if symbol doesn't match → return empty state
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
});

app.post("/evaluate", (req, res) => {
  const candle = req.body.candle;
  const symbol = req.body.symbol;

  if (!symbol || !candle) {
    return res.status(400).json({
      message: "symbol and candle are required",
    });
  }

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

  const lastSavedTime = candleHistory[candleHistory.length - 1]?.time;

  if (lastSavedTime === candle.time) {
    return res.json({
      ...latestEvaluation,
      symbol,
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

  candleHistory.push(normalizedCandle);

  const result = evaluateEMACross(candleHistory);

  latestEvaluation = {
    symbol,
    ...result,
    candleCount: candleHistory.length,
    lastCandleTime: normalizedCandle.time,
    engineStatus: "running",
  };

  console.log("New candle received for:", symbol);
  console.log("New candle received:", normalizedCandle);
  console.log("Strategy result:", latestEvaluation);

  res.json(latestEvaluation);
});

app.get("/reset-engine", (req, res) => {
  candleHistory = [];

  latestEvaluation = {
    symbol: STRATEGY_SYMBOL,
    signal: "WAIT",
    ema10: null,
    ema20: null,
    candleCount: 0,
    lastCandleTime: null,
    engineStatus: "reset",
  };

  res.json({ message: "Strategy engine reset successful" });
});

app.listen(PORT, () => {
  console.log(`Strategy engine running on port ${PORT}`);
});