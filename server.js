const express = require("express")
const { evaluateEMACross } = require("./strategy/emaCrossStrategy")

const app = express()
app.use(express.json())

const PORT = 4000

app.get("/", (req, res) => {
  res.send("Strategy engine running")
})

app.get("/evaluate", (req, res) => {
  res.send("Evaluate route working")
})

app.post("/evaluate", (req, res) => {
  const candles = req.body.candles

  const result = evaluateEMACross(candles)

  res.json(result)
})

app.listen(PORT, () => {
  console.log(`Strategy engine running on port ${PORT}`)
})