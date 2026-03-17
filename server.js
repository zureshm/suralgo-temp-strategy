const express = require("express");
const http = require("http");
const { evaluateEMACross } = require("./strategy/emaCrossStrategy");

const app = express();
const cors = require("cors");
app.use(cors());
app.use(express.json());

const PORT = 4000;
const MARKET_URL = "http://localhost:2000/current-candle";

let candleHistory = [];

let latestEvaluation = {
  signal: "WAIT",
  ema10: null,
  ema20: null,
  candleCount: 0,
  lastCandleTime: null,
  engineStatus: "starting",
};

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", (error) => {
        reject(error);
      });
  });
}

async function pollMarketAndEvaluate() {
  try {
    const candle = await getJson(MARKET_URL);

    if (!candle || candle.message) {
      latestEvaluation = {
        ...latestEvaluation,
        engineStatus: "no-candle",
      };
      return;
    }

    const lastSavedTime = candleHistory[candleHistory.length - 1]?.time;

    if (lastSavedTime === candle.time) {
      latestEvaluation = {
        ...latestEvaluation,
        engineStatus: "waiting-next-candle",
      };
      return;
    }

    candleHistory.push(candle);

    const result = evaluateEMACross(candleHistory);

    latestEvaluation = {
      ...result,
      candleCount: candleHistory.length,
      lastCandleTime: candle.time,
      engineStatus: "running",
    };

    console.log("Strategy result:", latestEvaluation);
  } catch (error) {
    latestEvaluation = {
      ...latestEvaluation,
      engineStatus: "error",
      error: error.message,
    };

    console.log("Strategy polling error:", error.message);
  }
}

app.get("/", (req, res) => {
  res.send("Strategy engine running");
});

app.get("/evaluate", (req, res) => {
  res.json({
    ...latestEvaluation,
    candles: candleHistory.slice(-5),
  });
});

app.post("/evaluate", (req, res) => {
  const candles = req.body.candles || [];
  const result = evaluateEMACross(candles);
  res.json(result);
});

app.get("/reset-engine", (req, res) => {
  candleHistory = [];

  latestEvaluation = {
    signal: "WAIT",
    ema10: null,
    ema20: null,
    candleCount: 0,
    lastCandleTime: null,
    engineStatus: "reset",
  };

  res.json({ message: "Strategy engine reset successful" });
});

setInterval(pollMarketAndEvaluate, 1000);

app.listen(PORT, () => {
  console.log(`Strategy engine running on port ${PORT}`);
});