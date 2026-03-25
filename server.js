

require('dotenv').config();

const express = require("express");

const http = require("http");

const { evaluateEMACross } = require("./strategy/evaluateEMACross");

const {surStrategy} = require("./strategy/surStrategy");

const { chatGptStrategy } = require("./strategy/chatGptStrategy");



const app = express();

app.use(express.json());

const cors = require("cors");

app.use(cors());



const PORT = 4000;

const MARKET_URL = `${process.env.BASE_URL}/current-candle`;



// hardcoded symbol used by frontend for matching

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

        symbol: STRATEGY_SYMBOL,

        engineStatus: "no-candle",

      };

      return;

    }



    const lastSavedTime = candleHistory[candleHistory.length - 1]?.time;



    if (lastSavedTime === candle.time) {

      latestEvaluation = {

        ...latestEvaluation,

        symbol: STRATEGY_SYMBOL,

        engineStatus: "waiting-next-candle",

      };

      return;

    }



    candleHistory.push(candle);



    const result = chatGptStrategy(candleHistory);

    // const result = surStrategy(candleHistory);

    // const result = evaluateEMACross(candleHistory);



    latestEvaluation = {

      symbol: STRATEGY_SYMBOL,

      ...result,

      candleCount: candleHistory.length,

      lastCandleTime: candle.time,

      engineStatus: "running",

    };



    console.log("Strategy result:", latestEvaluation);

  } catch (error) {

    latestEvaluation = {

      ...latestEvaluation,

      symbol: STRATEGY_SYMBOL,

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

    symbol: STRATEGY_SYMBOL,

    candles: candleHistory.slice(-5),

  });

});



app.post("/evaluate", (req, res) => {
  const candle = req.body.candle;
  const symbol = req.body.symbol;

  if (!candle || !symbol) {
    return res.status(400).json({
      message: "symbol and candle are required",
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

  candleHistory.push(candle);

  const result = evaluateEMACross(candleHistory);

  latestEvaluation = {
    symbol,
    ...result,
    candleCount: candleHistory.length,
    lastCandleTime: candle.time,
    engineStatus: "running",
  };

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



// setInterval(pollMarketAndEvaluate, 1000);



app.listen(PORT, () => {

  console.log(`Strategy engine running on port ${PORT}`);

});