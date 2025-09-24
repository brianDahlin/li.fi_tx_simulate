import express from "express";
import { table } from "table";

const app = express();
app.use(express.json());

// --- Constants
const LIFI_BASE = "https://li.quest/v1";
const ETHEREUM_CHAIN_ID = "1"; // fromChain
const BITCOIN_CHAIN_KEY = "btc"; // toChain (chain key)
const WBTC_ETH = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"; // fromToken (ERC-20 WBTC on Ethereum)
const BTC_SYMBOL = "BTC"; // toToken
const DEFAULT_SLIPPAGE = 0.005; // 0.5%

function toTokenUnitsWBTC(amountWBTC) {
  const [whole, frac = ""] = String(amountWBTC).split(".");
  const fracPadded = (frac + "00000000").slice(0, 8);
  const big = BigInt(whole + fracPadded);
  return big.toString();
}

function fromUnits(amountStr, decimals = 8) {
  const s = amountStr.toString();
  const pad = s.padStart(decimals + 1, "0");
  const i = pad.slice(0, -decimals);
  const f = pad.slice(-decimals);
  return `${i}.${f}`.replace(/^0+(?=\.)/, "0");
}

/**
 * GET /quote
 */
app.get("/quote", async (req, res) => {
  try {
    const { amount, fromAddress, btcAddress, slippage } = req.query;

    if (!amount || !fromAddress || !btcAddress) {
      return res.status(400).json({
        error: "amount, fromAddress и btcAddress обязательны",
      });
    }

    const fromAmount = toTokenUnitsWBTC(amount);

    const url = new URL(`${LIFI_BASE}/quote`);
    url.searchParams.set("fromChain", ETHEREUM_CHAIN_ID);
    url.searchParams.set("toChain", BITCOIN_CHAIN_KEY);
    url.searchParams.set("fromToken", WBTC_ETH);
    url.searchParams.set("toToken", BTC_SYMBOL);
    url.searchParams.set("fromAddress", fromAddress);
    url.searchParams.set("toAddress", btcAddress);
    url.searchParams.set("fromAmount", fromAmount);
    url.searchParams.set("slippage", slippage ?? DEFAULT_SLIPPAGE);

    const resp = await fetch(url, { method: "GET" });
    if (!resp.ok) {
      const text = await resp.text();
      return res
        .status(resp.status)
        .json({ error: "LI.FI quote failed", details: text });
    }

    const step = await resp.json();

    const approvalAddress = step?.estimate?.approvalAddress || null;
    const approvalData = step?.estimate?.approvalData || null;
    const txRequest = step?.transactionRequest || null;

    return res.json({
      meta: {
        note: "Подпишите approve (если требуется), затем подпишите и отправьте transactionRequest в Ethereum.",
      },
      tokens: {
        fromToken: "WBTC (ERC-20, 8 decimals)",
        toToken: "BTC (native)",
      },
      step,
      approval: {
        required: Boolean(approvalAddress),
        spender: approvalAddress,
        approvalData,
      },
      transactionRequest: txRequest,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal error", details: String(e) });
  }
});

/**
 * GET /simulate
 * Только расчёт — сколько BTC получится, комиссии и газ
 */
app.get("/simulate", async (req, res) => {
  try {
    const { amount, fromAddress, btcAddress, slippage } = req.query;
    if (!amount || !fromAddress || !btcAddress) {
      return res
        .status(400)
        .json({ error: "amount, fromAddress, btcAddress обязательны" });
    }
    const fromAmount = toTokenUnitsWBTC(amount);

    const url = new URL(`${LIFI_BASE}/quote`);
    url.searchParams.set("fromChain", ETHEREUM_CHAIN_ID);
    url.searchParams.set("toChain", BITCOIN_CHAIN_KEY);
    url.searchParams.set("fromToken", WBTC_ETH);
    url.searchParams.set("toToken", BTC_SYMBOL);
    url.searchParams.set("fromAddress", fromAddress);
    url.searchParams.set("toAddress", btcAddress);
    url.searchParams.set("fromAmount", fromAmount);
    url.searchParams.set("slippage", slippage ?? DEFAULT_SLIPPAGE);

    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text();
      return res
        .status(resp.status)
        .json({ error: "LI.FI quote failed", details: text });
    }
    const step = await resp.json();
    const est = step.estimate || {};

    const fromWBTC = fromUnits(est.fromAmount ?? fromAmount, 8);
    const toBTC_expected = fromUnits(est.toAmount ?? "0", 8);
    const toBTC_min = fromUnits(est.toAmountMin ?? "0", 8);

    const fees = (est.feeCosts || []).map((f) => ({
      name: f.name,
      token: f.token?.symbol,
      amount: fromUnits(f.amount || "0", f.token?.decimals ?? 8),
      amountUSD: f.amountUSD,
    }));
    const gas = (est.gasCosts || []).map((g) => ({
      type: g.type,
      token: g.token?.symbol,
      amount: g.amount,
      amountUSD: g.amountUSD,
    }));

    // Подсчёт процентов потерь
    const lossPctExpected =
      (
        ((parseFloat(fromWBTC) - parseFloat(toBTC_expected)) /
          parseFloat(fromWBTC)) *
        100
      ).toFixed(2) + "%";
    const lossPctMin =
      (
        ((parseFloat(fromWBTC) - parseFloat(toBTC_min)) /
          parseFloat(fromWBTC)) *
        100
      ).toFixed(2) + "%";

    // Таблица-резюме
    const summaryTable = table([
      ["Metric", "Value"],
      ["Input", `${fromWBTC} WBTC (~${est.fromAmountUSD} USD)`],
      ["Expected", `${toBTC_expected} BTC (~${est.toAmountUSD} USD)`],
      ["Min (slippage)", `${toBTC_min} BTC`],
      ["Loss % (expected)", lossPctExpected],
      ["Loss % (min)", lossPctMin],
      ["Slippage param", String(est.slippage ?? slippage ?? DEFAULT_SLIPPAGE)],
      ["Provider", step.toolDetails?.name || step.tool],
    ]);

    // Таблица комиссий
    const feeRows = [["Fee", "Token", "Amount", "USD"]];
    for (const f of fees) {
      feeRows.push([
        f.name || "-",
        f.token || "-",
        f.amount || "-",
        f.amountUSD || "-",
      ]);
    }
    const feesTable = table(feeRows);

    // Таблица газа
    const gasRows = [["Type", "Token", "Amount (raw)", "USD"]];
    for (const g of gas) {
      gasRows.push([
        g.type || "-",
        g.token || "-",
        g.amount || "-",
        g.amountUSD || "-",
      ]);
    }
    const gasTable = table(gasRows);

    // Отдаём текст/таблицы (удобно смотреть через curl)
    return res
      .type("text/plain")
      .send(
        "=== Simulation Summary ===\n" +
          summaryTable +
          "\n=== Fees ===\n" +
          feesTable +
          "\n=== Gas ===\n" +
          gasTable +
          "\nNotes: ток считаем, без апрувов и прочих делишек\n"
      );
  } catch (e) {
    res.status(500).json({ error: "Internal error", details: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LI.FI WBTC->BTC demo running on http://localhost:${PORT}`);
});
