require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { evaluateEMACross } = require("./strategy/evaluateEMACross");
const { surStrategy } = require("./strategy/surStrategy");
const { chatGptStrategy } = require("./strategy/chatGptStrategy");
const { claudSurStrategy : Kumbhakarna_V1} = require("./strategy/claudSurStrategy");
const { superUTBotStrategy } = require("./strategy/superUTBotStrategy");
const { superDoubleUT } = require("./strategy/superDoubleUT");
const { utGptStrategy } = require("./strategy/UTGPTStrategy");
const { utGptStrategy1 } = require("./strategy/UTGPTStrategy1");
const { utGptStrategy2 } = require("./strategy/UTGPTStrategy2");
const { utGptStrategy3 } = require("./strategy/UTGPTStrategy3");
const { VWAPUTBotStrategy: DynamicShakunam} = require("./strategy/VWAPUTBotStrategy");
const { sumeshStrategy } = require("./strategy/SumeshStrategy");
const { utGptStrategy4 } = require("./strategy/UTGPTStrategy4");
const { utGptStrategy4X } = require("./strategy/UTGPTStrategy4X");

const app = express();

// ---- Log capture system ----
const MAX_LOG_LINES = 500;
const strategyLogs = [];

function pushLog(buffer, line) {
  buffer.push(line);
  if (buffer.length > MAX_LOG_LINES) buffer.shift();
}

const _origLog = console.log;
const _origError = console.error;

console.log = (...args) => {
  _origLog(...args);
  const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  pushLog(strategyLogs, `[LOG] ${new Date().toLocaleTimeString()} ${line}`);
};

console.error = (...args) => {
  _origError(...args);
  const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  pushLog(strategyLogs, `[ERR] ${new Date().toLocaleTimeString()} ${line}`);
};

app.use(express.json({ limit: '10mb' }));

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:4200",
  "http://209.38.126.3:3000",
  "http://209.38.126.3:4200",
  "http://144.126.255.14:3000",
  "http://144.126.255.14:4200",
  "https://suralgo.duckdns.org",
  "https://sumalgo.duckdns.org"
];

app.use(cors({
  origin: function (origin, callback) {
    // allow requests with no origin (like Postman, curl)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true
}));

const PORT = 4000;

// Strategy map
const strategies = {
  evaluateEMACross,
  surStrategy,
  chatGptStrategy,
  Kumbhakarna_V1,
  superUTBotStrategy,
  superDoubleUT,
  utGptStrategy,
  utGptStrategy1,
  utGptStrategy2,
  utGptStrategy3,
  DynamicShakunam,
  sumeshStrategy,
  utGptStrategy4,
  utGptStrategy4X
};

// Active strategy (default)
let activeStrategy = "DynamicShakunam";

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
      activeStrategy
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
      activeStrategy
    });
  }

  return res.json({
    ...latestEvaluation,
    candles: candles.slice(-5),
    activeStrategy
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
  const strategyFn = strategies[activeStrategy];

  if (!strategyFn) {
    return res.status(400).json({
      message: `Invalid strategy: ${activeStrategy}`,
    });
  }

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
        volume: Number(item.volume) || 0,
      };
    });

    candleHistoryBySymbol[symbol] = normalizedHistory;
    historyLoadedBySymbol[symbol] = true;

    const result = strategyFn(candleHistoryBySymbol[symbol]);
    const lastCandle =
      candleHistoryBySymbol[symbol][candleHistoryBySymbol[symbol].length - 1];

    latestEvaluationBySymbol[symbol] = {
      symbol,
      ...result,
      close: lastCandle ? lastCandle.close : null,
      candleCount: candleHistoryBySymbol[symbol].length,
      lastCandleTime: lastCandle ? lastCandle.time : null,
      engineStatus: "history-loaded",
      activeStrategy
    };

    console.log("History loaded for:", symbol);
    console.log("History candle count:", candleHistoryBySymbol[symbol].length);
    console.log("Strategy result:", latestEvaluationBySymbol[symbol]);
    console.log("Active strategy:", activeStrategy);

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
      activeStrategy
    });
  }

  const normalizedCandle = {
    time: candle.time,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.volume) || 0,
  };

  symbolCandles.push(normalizedCandle);

  const result = strategyFn(symbolCandles);

  const currentEval = {
    symbol,
    ...result,
    close: normalizedCandle.close,
    candleCount: symbolCandles.length,
    lastCandleTime: normalizedCandle.time,
    engineStatus: historyLoadedBySymbol[symbol] ? "running" : "running-no-history",
    activeStrategy
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
  console.log("Active strategy:", activeStrategy);

  // POST response always returns the actual per-candle evaluation (for fake-candles console)
  res.json(currentEval);
});

app.get("/logs/strategy", (req, res) => {
  res.json({ logs: strategyLogs });
});

// Chart history endpoint - returns last 700 OHLC candles per symbol for charting
app.get("/chart-history", (req, res) => {
  const result = {};
  for (const sym of Object.keys(candleHistoryBySymbol)) {
    result[sym] = candleHistoryBySymbol[sym].slice(-700).map(c => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
  }
  return res.json(result);
});

app.post("/strategy", (req, res) => {
  const { strategy } = req.body;

  if (!strategy) {
    return res.status(400).json({
      message: "strategy name is required",
      availableStrategies: Object.keys(strategies)
    });
  }

  if (!strategies[strategy]) {
    return res.status(400).json({
      message: `Invalid strategy: ${strategy}`,
      availableStrategies: Object.keys(strategies)
    });
  }

  activeStrategy = strategy;
  console.log("Strategy switched to:", activeStrategy);

  return res.json({
    message: "Strategy switched successfully",
    activeStrategy,
    availableStrategies: Object.keys(strategies)
  });
});

app.get("/strategy", (req, res) => {
  return res.json({
    activeStrategy,
    availableStrategies: Object.keys(strategies)
  });
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
  console.log(`Active strategy: ${activeStrategy}`);
});