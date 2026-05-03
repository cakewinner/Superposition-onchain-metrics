/**
 * DefiLlama yield adapter — Barter Superposition (USDC/USDT)
 *
 * Barter Superposition is a non-custodial DEX: LPs keep their tokens in their
 * own wallets and approve them to the SuperpositionVault. The router fills
 * taker orders against LP allowances; LP profit is the spread per swap
 * (takerAmount − makerAmount in raw token units).
 *
 * TVL  = Σ min(allowance, balance) for USDC + USDT per active LP
 * APY  = (fees / window_days / TVL) × 365, from spread on raw token amounts
 *
 * File location in yield-server: src/adaptors/barterswap/index.js
 */

const sdk   = require('@defillama/sdk');
const axios = require('axios');

// ── Addresses ─────────────────────────────────────────────────────────────────

const VAULT = '0x69355223a0ce30aee41d353387c3082e5aafc4da';
const USDC  = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDT  = '0xdac17f958d2ee523a2206206994597c13d831ec7';

const API_URL = 'https://superposition.barterswap.xyz/1/transactions/87378747-4d18-47e4-8835-f21fa069a533/all';

const DECIMALS = 1e6;  // both tokens are 6-decimal

// ── TVL ───────────────────────────────────────────────────────────────────────

async function getTvl(makers) {
  if (!makers.length) return 0;

  const [usdcAllowances, usdtAllowances, usdcBalances, usdtBalances] = await Promise.all([
    sdk.api.abi.multiCall({ abi: 'function allowance(address,address) view returns (uint256)', calls: makers.map((m) => ({ target: USDC, params: [m, VAULT] })), chain: 'ethereum' }),
    sdk.api.abi.multiCall({ abi: 'function allowance(address,address) view returns (uint256)', calls: makers.map((m) => ({ target: USDT, params: [m, VAULT] })), chain: 'ethereum' }),
    sdk.api.abi.multiCall({ abi: 'function balanceOf(address) view returns (uint256)',         calls: makers.map((m) => ({ target: USDC, params: [m]       })), chain: 'ethereum' }),
    sdk.api.abi.multiCall({ abi: 'function balanceOf(address) view returns (uint256)',         calls: makers.map((m) => ({ target: USDT, params: [m]       })), chain: 'ethereum' }),
  ]);

  let tvl = 0;
  for (let i = 0; i < makers.length; i++) {
    const ua = BigInt(usdcAllowances.output[i].output ?? 0);
    const ta = BigInt(usdtAllowances.output[i].output ?? 0);
    const ub = BigInt(usdcBalances.output[i].output   ?? 0);
    const tb = BigInt(usdtBalances.output[i].output   ?? 0);

    // Both tokens must be approved — otherwise this wallet is on a different pair
    if (ua === 0n || ta === 0n) continue;

    tvl += Number(ua < ub ? ua : ub) / DECIMALS;  // min(allowance, balance) USDC
    tvl += Number(ta < tb ? ta : tb) / DECIMALS;  // min(allowance, balance) USDT
  }

  return tvl;
}

// ── Volume / fee aggregation ──────────────────────────────────────────────────

function aggregateWindow(txs, sinceSec) {
  let vol = 0;
  let fees = 0;
  for (const t of txs) {
    if (t.created_at < sinceSec) continue;
    const takerRaw = BigInt(t.taker_amount);
    const makerRaw = BigInt(t.maker_amount);
    vol  += Number(takerRaw) / DECIMALS;
    fees += Number(takerRaw - makerRaw) / DECIMALS;
  }
  return { vol, fees };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function apy() {
  const { data } = await axios.get(API_URL, {
    timeout: 30_000,
    validateStatus: (s) => s < 500,
  });
  const allTxs = data?.transactions ?? [];

  // Keep only USDC↔USDT swaps
  const stableTxs = allTxs.filter(
    (t) =>
      (t.taker_asset.toLowerCase() === USDC && t.maker_asset.toLowerCase() === USDT) ||
      (t.taker_asset.toLowerCase() === USDT && t.maker_asset.toLowerCase() === USDC)
  );

  const nowSec = Math.floor(Date.now() / 1000);
  const w1d = aggregateWindow(stableTxs, nowSec - 1 * 86400);
  const w7d = aggregateWindow(stableTxs, nowSec - 7 * 86400);

  // TVL: only wallets that appeared as maker in a USDC/USDT swap
  const makers = [...new Set(stableTxs.map((t) => t.maker.toLowerCase()))];
  const tvlUsd = await getTvl(makers);

  const apyBase   = tvlUsd > 0 ? (w1d.fees / 1 / tvlUsd) * 365 * 100 : 0;
  const apyBase7d = tvlUsd > 0 ? (w7d.fees / 7 / tvlUsd) * 365 * 100 : 0;

  return [
    {
      pool: `${VAULT}-ethereum`,
      chain: 'Ethereum',
      project: 'barterswap',
      symbol: 'USDC-USDT',
      tvlUsd,
      apyBase,
      apyBase7d,
      underlyingTokens: [USDC, USDT],
      poolMeta: 'Superposition',
      url: 'https://superposition.barterswap.xyz',
      volumeUsd1d: w1d.vol,
      volumeUsd7d: w7d.vol,
    },
  ];
}

module.exports = {
  timetravel: false,
  apy,
  url: 'https://superposition.barterswap.xyz',
};
