import express from "express";
import { table } from "table";

const app = express();
app.use(express.json());

// --- Constants
const LIFI_BASE = "https://li.quest/v1";
const ETHEREUM_CHAIN_ID = "1"; // fromChain
const BITCOIN_CHAIN_KEY = "btc"; // toChain
const BTC_SYMBOL = "BTC"; // toToken
const DEFAULT_FROM_TOKEN_KEY = "wbtc";
const DEFAULT_SLIPPAGE = 0.003; // 0.3%

const TOKEN_REGISTRY = {
  wbtc: {
    address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    chainId: 1,
    symbol: "WBTC",
    name: "Wrapped BTC",
    decimals: 8,
  },
  cbbtc: {
    address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    chainId: 1,
    symbol: "cbBTC",
    name: "Coinbase Wrapped BTC",
    decimals: 8,
  },
};

function isHexAddress(s) {
  return typeof s === "string" && /^0x[a-fA-F0-9]{40}$/.test(s);
}

function toTokenUnits(amountHuman, decimals) {
  const [whole, frac = ""] = String(amountHuman).split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const big = BigInt((whole || "0") + fracPadded);
  return big.toString();
}

function fromUnits(amountStr, decimals) {
  const s = (amountStr ?? "0").toString();
  const pad = s.padStart(decimals + 1, "0");
  const i = pad.slice(0, -decimals);
  const f = pad.slice(-decimals);
  return `${i}.${f}`.replace(/^0+(?=\.)/, "0");
}

function resolveFromToken(query) {
  const rawInput = query.fromToken ?? DEFAULT_FROM_TOKEN_KEY;
  const raw = String(rawInput).trim().toLowerCase();

  if (!raw) {
    throw new Error("fromToken обязателен (ключ реестра или адрес 0x...)");
  }

  if (TOKEN_REGISTRY[raw]) {
    return TOKEN_REGISTRY[raw];
  }

  if (isHexAddress(raw)) {
    const decimalsParam =
      query.decimals != null ? Number(query.decimals) : undefined;
    const symbolParam = query.symbol != null ? String(query.symbol) : undefined;

    if (
      !Number.isInteger(decimalsParam) ||
      decimalsParam < 0 ||
      decimalsParam > 36
    ) {
      throw new Error(
        "Для произвольного токена по адресу нужно указать ?decimals=<число 0..36> (и желательно ?symbol=XYZ)"
      );
    }

    return {
      address: raw,
      chainId: 1,
      symbol: symbolParam || "TOKEN",
      name: symbolParam || "Custom Token",
      decimals: decimalsParam,
    };
  }

  throw new Error(
    "fromToken должен быть ключом реестра (wbtc, cbbtc) или адресом ERC-20 (0x...)"
  );
}

function buildQuoteURL({
  fromTokenAddr,
  fromAmountUnits,
  fromAddress,
  btcAddress,
  slippage,
}) {
  const url = new URL(`${LIFI_BASE}/quote`);
  url.searchParams.set("fromChain", ETHEREUM_CHAIN_ID);
  url.searchParams.set("toChain", BITCOIN_CHAIN_KEY);
  url.searchParams.set("fromToken", fromTokenAddr);
  url.searchParams.set("toToken", BTC_SYMBOL);
  url.searchParams.set("fromAddress", fromAddress);
  url.searchParams.set("toAddress", btcAddress);
  url.searchParams.set("fromAmount", fromAmountUnits);
  url.searchParams.set("slippage", slippage ?? DEFAULT_SLIPPAGE);
  return url;
}

app.get("/quote", async (req, res) => {
  try {
    const { amount, fromAddress, btcAddress, slippage } = req.query;

    if (!amount || !fromAddress || !btcAddress) {
      return res.status(400).json({
        error: "amount, fromAddress и btcAddress обязательны",
      });
    }

    // Resolve token (адрес, decimals)
    let tokenMeta;
    try {
      tokenMeta = resolveFromToken(req.query);
    } catch (err) {
      return res.status(400).json({ error: String(err.message || err) });
    }

    const fromAmountUnits = toTokenUnits(amount, tokenMeta.decimals);
    const url = buildQuoteURL({
      fromTokenAddr: tokenMeta.address,
      fromAmountUnits,
      fromAddress,
      btcAddress,
      slippage,
    });

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
        fromToken: `${tokenMeta.symbol} (ERC-20, ${tokenMeta.decimals} decimals)`,
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
 * Параметры такие же, как у /quote
 */
app.get("/simulate", async (req, res) => {
  try {
    const { amount, fromAddress, btcAddress, slippage } = req.query;
    if (!amount || !fromAddress || !btcAddress) {
      return res
        .status(400)
        .json({ error: "amount, fromAddress, btcAddress обязательны" });
    }

    let tokenMeta;
    try {
      tokenMeta = resolveFromToken(req.query);
    } catch (err) {
      return res.status(400).json({ error: String(err.message || err) });
    }

    const fromAmountUnits = toTokenUnits(amount, tokenMeta.decimals);
    const url = buildQuoteURL({
      fromTokenAddr: tokenMeta.address,
      fromAmountUnits,
      fromAddress,
      btcAddress,
      slippage,
    });

    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text();
      return res
        .status(resp.status)
        .json({ error: "LI.FI quote failed", details: text });
    }
    const step = await resp.json();
    const est = step.estimate || {};

    // Читаемые значения
    const inputHuman = fromUnits(
      est.fromAmount ?? fromAmountUnits,
      tokenMeta.decimals
    );
    const toBTC_expected = fromUnits(est.toAmount ?? "0", 8);
    const toBTC_min = fromUnits(est.toAmountMin ?? "0", 8);

    // Комиссии/газ
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

    // Проценты потерь
    const lossPctExpected =
      (
        ((parseFloat(inputHuman) - parseFloat(toBTC_expected)) /
          parseFloat(inputHuman)) *
        100
      ).toFixed(2) + "%";
    const lossPctMin =
      (
        ((parseFloat(inputHuman) - parseFloat(toBTC_min)) /
          parseFloat(inputHuman)) *
        100
      ).toFixed(2) + "%";

    // Таблица-резюме
    const summaryTable = table([
      ["Metric", "Value"],
      [
        "Input",
        `${inputHuman} ${tokenMeta.symbol} (~${est.fromAmountUSD} USD)`,
      ],
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

    return res
      .type("text/plain")
      .send(
        "=== Simulation Summary ===\n" +
          summaryTable +
          "\n=== Fees ===\n" +
          feesTable +
          "\n=== Gas ===\n" +
          gasTable +
          `\nNotes: расчёт без approve/exec | fromToken=${tokenMeta.symbol} (${tokenMeta.address})\n`
      );
  } catch (e) {
    res.status(500).json({ error: "Internal error", details: String(e) });
  }
});

/**
 * GET /status
 */
app.get("/status", async (req, res) => {
  try {
    const {
      txHash,
      fromChain = ETHEREUM_CHAIN_ID,
      toChain = BITCOIN_CHAIN_KEY,
    } = req.query;
    if (!txHash) return res.status(400).json({ error: "txHash обязателен" });

    const url = new URL(`${LIFI_BASE}/status`);
    url.searchParams.set("txHash", txHash);
    url.searchParams.set("fromChain", String(fromChain));
    url.searchParams.set("toChain", String(toChain));

    const resp = await fetch(url);
    const data = await resp.json();
    return res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Internal error", details: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LI.FI WBTC->BTC demo running on http://localhost:${PORT}`);
});
