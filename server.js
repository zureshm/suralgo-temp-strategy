require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { evaluateEMACross } = require("./strategy/evaluateEMACross");
const { surStrategy } = require("./strategy/surStrategy");
const { chatGptStrategy } = require("./strategy/chatGptStrategy");
const { claudSurStrategy } = require("./strategy/claudSurStrategy");
const { superUTBotStrategy } = require("./strategy/superUTBotStrategy");
const { doubleUTBotStrategy } = require("./strategy/doubleUTBotStrategy");
const { trippleUTBotStrategy } = require("./strategy/trippleUTBotStrategy");
const { quadUTBotStrategy } = require("./strategy/quadUTBotStrategy");

const app = express();
 
app.use(express.json());
app.use(cors());

const PORT = 4000;

// Store candles separately for each symbol
const candleHistoryBySymbol = {};
// keeps track of whether history was already loaded for a symbol
// useful later so live candles do not accidentally re-initialize everything
let historyLoadedBySymbol = {};

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
  // mode = "history" => preload old candles
  // mode = "live" => one newly completed candle
  const { symbol, candle, candles, mode = "live" } = req.body;

  if (!symbol) {
    return res.status(400).json({
      message: "symbol is required",
    });
  }

  if (!candleHistoryBySymbol[symbol]) {
    candleHistoryBySymbol[symbol] = [];
  }

  const symbolCandles = candleHistoryBySymbol[symbol];

  // HISTORY PRELOAD MODE
  if (mode === "history") {
    if (!Array.isArray(candles) || candles.length === 0) {
      return res.status(400).json({
        message: "candles array is required for history mode",
      });
    }

    const normalizedHistory = candles.map((item) => {
      return {
        time: item.time,
        open: Number(item.open),
        high: Number(item.high),
        low: Number(item.low),
        close: Number(item.close),
      };
    });

    candleHistoryBySymbol[symbol] = normalizedHistory;
    historyLoadedBySymbol[symbol] = true;

    const result = quadUTBotStrategy(candleHistoryBySymbol[symbol]);
    const lastCandle =
      candleHistoryBySymbol[symbol][candleHistoryBySymbol[symbol].length - 1];

    latestEvaluationBySymbol[symbol] = {
      symbol,
      ...result,
      close: lastCandle ? lastCandle.close : null,
      candleCount: candleHistoryBySymbol[symbol].length,
      lastCandleTime: lastCandle ? lastCandle.time : null,
      engineStatus: "history-loaded",
    };

    console.log("History loaded for:", symbol);
    console.log("History candle count:", candleHistoryBySymbol[symbol].length);
    console.log("Strategy result:", latestEvaluationBySymbol[symbol]);

    return res.json(latestEvaluationBySymbol[symbol]);
  }

  // LIVE CANDLE MODE
  if (!candle) {
    return res.status(400).json({
      message: "candle is required for live mode",
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

  const lastSavedTime = symbolCandles[symbolCandles.length - 1]?.time;

  if (lastSavedTime === candle.time) {
    return res.json({
      ...(latestEvaluationBySymbol[symbol] || {
        symbol,
        signal: "WAIT",
        ema10: null,
        ema20: null,
        candleCount: symbolCandles.length,
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

  symbolCandles.push(normalizedCandle);

  const result = quadUTBotStrategy(symbolCandles);

  const currentEval = {
    symbol,
    ...result,
    close: normalizedCandle.close,
    candleCount: symbolCandles.length,
    lastCandleTime: normalizedCandle.time,
    engineStatus: historyLoadedBySymbol[symbol] ? "running" : "running-no-history",
  };

  // Sticky signal: don't let WAIT overwrite a previous BUY/SELL immediately,
  // so the server-side trade engine has time to poll it via GET.
  // But expire the sticky signal after 3 candles to prevent stale activation.
  const prev = latestEvaluationBySymbol[symbol];
  if (result.signal !== "WAIT") {
    latestEvaluationBySymbol[symbol] = currentEval;
  } else if (!prev || prev.signal === "WAIT") {
    latestEvaluationBySymbol[symbol] = currentEval;
  } else if (symbolCandles.length > prev.candleCount + 3) {
    // Sticky signal expired (more than 3 candles old) — let WAIT through
    latestEvaluationBySymbol[symbol] = currentEval;
  }
  // else: previous was BUY/SELL within 3 candles → keep it

  console.log("New candle received for:", symbol);
  console.log("New candle received:", normalizedCandle);
  console.log("Stored signal:", latestEvaluationBySymbol[symbol].signal,
    "| Current eval:", result.signal);
  console.log("Strategy result:", latestEvaluationBySymbol[symbol]);

  // POST response always returns the actual per-candle evaluation (for fake-candles console)
  res.json(currentEval);
});

app.post("/reset-engine", (req, res) => {
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