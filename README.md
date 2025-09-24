# WBTC → BTC Simulation Service

Сервис на **Express.js**, который оборачивает [LI.FI API](https://docs.li.fi/api-reference)  
и позволяет моделировать кроссчейн-транзакции **WBTC (Ethereum) → BTC (mainnet)**.

## Endpoints

- `GET /simulate` — расчёт (сколько BTC получится, комиссии, slippage, газ).  
   Пример:
  ```bash
  curl "http://localhost:3000/simulate?amount=0.1&fromAddress=0x...&btcAddress=bc1...&format=table"
  ```
  123
