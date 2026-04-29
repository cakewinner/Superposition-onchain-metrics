/**
 * Barter Superposition — Revert Finance integration
 *
 * How Barter Superposition works:
 *   LPs don't deposit into a pool. They approve USDC and USDT to the
 *   SuperpositionVault and Barter fills swaps against their wallet balance.
 *   Profit comes from the spread: LP gives out makerAmount, receives takerAmount,
 *   keeps the difference (e.g. give 5000 USDT, receive 5010 USDC → $10 profit).
 *
 * What this script computes:
 *   TVL        = Σ min(allowance, balance) per token, per LP
 *                only wallets with BOTH USDC and USDT approved count
 *   volume 1d  = Σ taker_amount_usd for USDC↔USDT swaps in last 24h
 *   fees 1d    = Σ (taker_amount_usd − maker_amount_usd)
 *   fees APR   = (fees 1d / TVL) × 365
 *
 * Two modes (auto-selected via .env):
 *   API mode      — set API_BASE; volume/fees/LP list come from Barter API (~5s)
 *   On-chain mode — leave API_BASE unset; scans Approval + Transfer events (~60s)
 *
 * See .env.example for all options.
 */

import "dotenv/config";
import { ethers } from "ethers";
import axios from "axios";

// ─── Config ───────────────────────────────────────────────────────────────────

const VAULT_ADDRESS = (
  process.env.VAULT_ADDRESS ?? "0x69355223a0ce30aee41d353387c3082e5aafc4da"
).toLowerCase();

const ROUTER = "0x0b7250866f0b014E6983cACc5b854EeA7a3d9188";

const API_BASE    = process.env.API_BASE ?? null;
const START_BLOCK = parseInt(process.env.START_BLOCK ?? "23727155", 10);
const CHUNK_SIZE  = parseInt(process.env.CHUNK_SIZE  ?? "25000",    10);

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const DECIMALS       = 6;   // both tokens
const BLOCKS_PER_DAY = 7200;

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const ERC20_ABI = [
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
];

const ROUTER_ABI = [
  "function swap(address vault, tuple(tuple(uint8 signatureType, uint256 takerAmount, uint256 makerAmount, address takerToken, address makerToken, bool usePermit2, address taker, address maker, uint64 deadline, uint256 nonce) payload, bytes[3] signatures) order, uint256 takerAmount)",
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface ApiTransaction {
  created_at: number;
  block_number: number;
  tx_hash: string;
  maker: string;
  taker_asset: string;
  maker_asset: string;
  taker_amount_usd: number;
  maker_amount_usd: number;
  taker_amount: string;
  maker_amount: string;
}

export interface Position {
  owner: string;
  usdcAllowanceRaw: bigint;
  usdtAllowanceRaw: bigint;
  usdcBalanceRaw: bigint;
  usdtBalanceRaw: bigint;
  usdcEffectiveUsd: number;
  usdtEffectiveUsd: number;
  tvlUsd: number;
}

export interface SwapSummary {
  txHash: string;
  blockNumber: number;
  timestamp?: number;
  maker: string;
  tokenIn: string;
  tokenOut: string;
  volumeUsd: number;
  feesUsd: number;
  spreadPct: number;
}

export interface PoolStats {
  pair: string;
  mode: "api" | "on-chain";
  tvlUsd: number;
  volume1dUsd: number;
  fees1dUsd: number;
  feesTvl1d: number;
  feesAPRPct: number;
  rewardsAPRPct: number;
  activePositions: number;
  swaps1d: number;
  avgSpreadPct: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getProvider() {
  const url = process.env.ETH_RPC_URL;
  if (!url) throw new Error("ETH_RPC_URL is required in .env");
  return new ethers.JsonRpcProvider(url);
}

function toUsd(raw: bigint) {
  return Number(raw) / 10 ** DECIMALS;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Fetches events in chunks, auto-halving chunk size on range errors and
// backing off exponentially on 429s.
async function queryEvents(
  contract: ethers.Contract,
  filter: ethers.DeferredTopicFilter,
  fromBlock: number,
  toBlock: number
): Promise<ethers.EventLog[]> {
  const out: ethers.EventLog[] = [];
  let chunk = CHUNK_SIZE;
  let lo = fromBlock;

  while (lo <= toBlock) {
    const hi = Math.min(lo + chunk - 1, toBlock);
    let ok = false;
    let attempts = 0;

    while (!ok) {
      try {
        out.push(...(await contract.queryFilter(filter, lo, hi) as ethers.EventLog[]));
        lo = hi + 1;
        ok = true;
      } catch (err: unknown) {
        const msg =
          (err as { error?: { message?: string } })?.error?.message ??
          (err as { message?: string })?.message ?? "";

        if (msg.includes("block range") || msg.includes("range")) {
          chunk = Math.max(1, Math.floor(chunk / 2));
          continue;
        }
        if (msg.includes("429") || msg.includes("rate") || msg.includes("capacity")) {
          attempts++;
          if (attempts > 6) throw new Error(`Rate limited after 6 retries — try a different RPC.\n${msg}`);
          await sleep(1000 * Math.pow(2, attempts));
          continue;
        }
        throw err;
      }
    }
  }

  return out;
}

// ─── TVL (shared by both modes) ───────────────────────────────────────────────

// Reads allowance + balance for each LP wallet on-chain.
// A wallet only counts toward USDC/USDT TVL if it has approved BOTH tokens —
// this rules out wallets that are LPs on other pairs (e.g. USDC/WETH).
export async function getPositions(makers: string[]): Promise<Position[]> {
  const provider = getProvider();
  const usdc = new ethers.Contract(USDC, ERC20_ABI, provider);
  const usdt = new ethers.Contract(USDT, ERC20_ABI, provider);

  console.log(`  Checking ${makers.length} LP wallets on-chain…`);
  const positions: Position[] = [];

  await Promise.all(
    makers.map(async (owner) => {
      let ua: bigint, ta: bigint, ub: bigint, tb: bigint;
      try {
        [ua, ta, ub, tb] = await Promise.all([
          usdc.allowance(owner, VAULT_ADDRESS) as Promise<bigint>,
          usdt.allowance(owner, VAULT_ADDRESS) as Promise<bigint>,
          usdc.balanceOf(owner) as Promise<bigint>,
          usdt.balanceOf(owner) as Promise<bigint>,
        ]);
      } catch {
        return;
      }

      if (ua === 0n || ta === 0n) return;

      const usdcEff = ua < ub ? ua : ub;
      const usdtEff = ta < tb ? ta : tb;

      positions.push({
        owner,
        usdcAllowanceRaw: ua,
        usdtAllowanceRaw: ta,
        usdcBalanceRaw: ub,
        usdtBalanceRaw: tb,
        usdcEffectiveUsd: toUsd(usdcEff),
        usdtEffectiveUsd: toUsd(usdtEff),
        tvlUsd: toUsd(usdcEff) + toUsd(usdtEff),
      });
    })
  );

  return positions.sort((a, b) => b.tvlUsd - a.tvlUsd);
}

// ─── API mode ─────────────────────────────────────────────────────────────────

async function fetchAllTransactions(): Promise<ApiTransaction[]> {
  const res = await axios.get<{ transactions: ApiTransaction[] }>(
    `${API_BASE}/all`,
    { timeout: 30_000, validateStatus: (s) => s < 500 }
  );
  return res.data?.transactions ?? [];
}

async function getPoolStatsApi(): Promise<{
  stats: PoolStats;
  positions: Position[];
  swaps: SwapSummary[];
}> {
  console.log("Mode: API  →  fetching transactions…");
  const allTxs = await fetchAllTransactions();

  const stableTxs = allTxs.filter(
    (t) =>
      (t.taker_asset === USDC && t.maker_asset === USDT) ||
      (t.taker_asset === USDT && t.maker_asset === USDC)
  );

  const nowSec = Math.floor(Date.now() / 1000);
  const txs1d = stableTxs.filter((t) => t.created_at >= nowSec - 86400);

  const volume1dUsd = txs1d.reduce((s, t) => s + t.taker_amount_usd, 0);
  const fees1dUsd = txs1d.reduce(
    (s, t) => s + (t.taker_amount_usd - t.maker_amount_usd),
    0
  );
  const avgSpreadPct = volume1dUsd > 0 ? (fees1dUsd / volume1dUsd) * 100 : 0;

  const allMakers = [...new Set(allTxs.map((t) => t.maker.toLowerCase()))];

  console.log("Fetching TVL from chain…");
  const positions = await getPositions(allMakers);
  const tvlUsd = positions.reduce((s, p) => s + p.tvlUsd, 0);
  const feesTvl1d = tvlUsd > 0 ? fees1dUsd / tvlUsd : 0;

  const swaps: SwapSummary[] = stableTxs
    .filter((t) => t.created_at >= nowSec - 7 * 86400)
    .map((t) => ({
      txHash: t.tx_hash,
      blockNumber: t.block_number,
      timestamp: t.created_at,
      maker: t.maker,
      tokenIn: t.taker_asset === USDC ? "USDC" : "USDT",
      tokenOut: t.maker_asset === USDC ? "USDC" : "USDT",
      volumeUsd: t.taker_amount_usd,
      feesUsd: t.taker_amount_usd - t.maker_amount_usd,
      spreadPct:
        t.taker_amount_usd > 0
          ? ((t.taker_amount_usd - t.maker_amount_usd) / t.taker_amount_usd) * 100
          : 0,
    }))
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

  return {
    stats: {
      pair: "USDC/USDT",
      mode: "api",
      tvlUsd,
      volume1dUsd,
      fees1dUsd,
      feesTvl1d,
      feesAPRPct: feesTvl1d * 365 * 100,
      rewardsAPRPct: 0,
      activePositions: positions.length,
      swaps1d: txs1d.length,
      avgSpreadPct,
    },
    positions,
    swaps,
  };
}

// ─── On-chain mode ────────────────────────────────────────────────────────────

async function getPoolStatsOnChain(): Promise<{
  stats: PoolStats;
  positions: Position[];
  swaps: SwapSummary[];
}> {
  console.log("Mode: on-chain  →  scanning from block", START_BLOCK);
  const provider = getProvider();
  const usdc = new ethers.Contract(USDC, ERC20_ABI, provider);
  const usdt = new ethers.Contract(USDT, ERC20_ABI, provider);
  const tip = await provider.getBlockNumber();

  // Find all wallets that have ever approved USDC or USDT to the vault
  console.log("  Scanning USDC approvals…");
  const usdcAp = await queryEvents(
    usdc,
    usdc.filters.Approval(null, VAULT_ADDRESS),
    START_BLOCK,
    tip
  );
  console.log(`  ✓ ${usdcAp.length} events`);

  console.log("  Scanning USDT approvals…");
  const usdtAp = await queryEvents(
    usdt,
    usdt.filters.Approval(null, VAULT_ADDRESS),
    START_BLOCK,
    tip
  );
  console.log(`  ✓ ${usdtAp.length} events`);

  const makers = [
    ...new Set(
      [...usdcAp, ...usdtAp].map((e) => (e.args.owner as string).toLowerCase())
    ),
  ];

  console.log("Fetching TVL from chain…");
  const positions = await getPositions(makers);
  const tvlUsd = positions.reduce((s, p) => s + p.tvlUsd, 0);

  // Identify swap transactions by looking for inbound token transfers to the router
  const fromBlock1d = Math.max(tip - BLOCKS_PER_DAY, START_BLOCK);
  console.log("  Scanning swap transfers (last 24h)…");

  const [usdcIn, usdtIn] = await Promise.all([
    queryEvents(usdc, usdc.filters.Transfer(null, ROUTER), fromBlock1d, tip),
    queryEvents(usdt, usdt.filters.Transfer(null, ROUTER), fromBlock1d, tip),
  ]);

  const txHashes = new Set(
    [...usdcIn, ...usdtIn].map((e) => e.transactionHash)
  );
  const iface = new ethers.Interface(ROUTER_ABI);
  const swaps: SwapSummary[] = [];

  await Promise.all(
    [...txHashes].map(async (hash) => {
      try {
        const tx = await provider.getTransaction(hash);
        if (!tx || tx.to?.toLowerCase() !== ROUTER.toLowerCase()) return;

        const dec = iface.parseTransaction({ data: tx.data });
        if (!dec || dec.name !== "swap") return;

        const payload = dec.args[1].payload;
        const actualTaker: bigint = dec.args[2];
        const takerToken = (payload.takerToken as string).toLowerCase();
        const makerToken = (payload.makerToken as string).toLowerCase();

        const isStablePair =
          (takerToken === USDC && makerToken === USDT) ||
          (takerToken === USDT && makerToken === USDC);
        if (!isStablePair) return;

        // Scale maker amount for partial fills
        const effectiveMaker =
          (actualTaker * (payload.makerAmount as bigint)) /
          (payload.takerAmount as bigint);

        // Both tokens are 6-decimal and ~$1, so raw units ≈ USD cents
        const volumeUsd = toUsd(actualTaker);
        const feesUsd = toUsd(actualTaker) - toUsd(effectiveMaker);
        const receipt = await provider.getTransactionReceipt(hash);

        swaps.push({
          txHash: hash,
          blockNumber: receipt?.blockNumber ?? 0,
          maker: (payload.maker as string).toLowerCase(),
          tokenIn: takerToken === USDC ? "USDC" : "USDT",
          tokenOut: makerToken === USDC ? "USDC" : "USDT",
          volumeUsd,
          feesUsd,
          spreadPct: volumeUsd > 0 ? (feesUsd / volumeUsd) * 100 : 0,
        });
      } catch {
        // skip any tx that fails to decode
      }
    })
  );

  const volume1dUsd = swaps.reduce((s, sw) => s + sw.volumeUsd, 0);
  const fees1dUsd = swaps.reduce((s, sw) => s + sw.feesUsd, 0);
  const avgSpreadPct = volume1dUsd > 0 ? (fees1dUsd / volume1dUsd) * 100 : 0;
  const feesTvl1d = tvlUsd > 0 ? fees1dUsd / tvlUsd : 0;

  return {
    stats: {
      pair: "USDC/USDT",
      mode: "on-chain",
      tvlUsd,
      volume1dUsd,
      fees1dUsd,
      feesTvl1d,
      feesAPRPct: feesTvl1d * 365 * 100,
      rewardsAPRPct: 0,
      activePositions: positions.length,
      swaps1d: swaps.length,
      avgSpreadPct,
    },
    positions,
    swaps: swaps.sort((a, b) => b.blockNumber - a.blockNumber),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Barter Superposition — Revert Integration ===\n");

  const { stats, positions, swaps } = API_BASE
    ? await getPoolStatsApi()
    : await getPoolStatsOnChain();

  console.log("\n─── Pool Row (Revert format) ─────────────────────────");
  console.log(`Pool:          ${stats.pair}`);
  console.log(`TVL:           $${stats.tvlUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  console.log(`Volume 1d:     $${stats.volume1dUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  console.log(`Fees 1d:       $${stats.fees1dUsd.toFixed(4)}`);
  console.log(`Fees/TVL 1d:   ${stats.feesTvl1d.toFixed(6)}`);
  console.log(`Fees APR:      ${stats.feesAPRPct.toFixed(2)}%`);
  console.log(`Rewards APR:   ${stats.rewardsAPRPct.toFixed(2)}%`);
  console.log(`Active LPs:    ${stats.activePositions}`);
  console.log(`Swaps (24h):   ${stats.swaps1d}`);
  console.log(`Avg spread:    ${stats.avgSpreadPct.toFixed(4)}%`);
  console.log(`Data source:   ${stats.mode}`);

  if (positions.length > 0) {
    console.log("\n─── Active LP Positions ──────────────────────────────");
    for (const p of positions) {
      console.log(
        `  ${p.owner.slice(0, 10)}…  ` +
          `USDC $${p.usdcEffectiveUsd.toFixed(2)}  ` +
          `USDT $${p.usdtEffectiveUsd.toFixed(2)}  ` +
          `= $${p.tvlUsd.toFixed(2)}`
      );
    }
  }

  if (swaps.length > 0) {
    const swapWindow = stats.mode === "api" ? "7d" : "24h";
    console.log(`\n─── Recent USDC↔USDT Swaps (last ${swapWindow}) ─────────────`);
    for (const s of swaps.slice(0, 10)) {
      const date = s.timestamp
        ? new Date(s.timestamp * 1000).toISOString().slice(0, 16).replace("T", " ")
        : `block ${s.blockNumber}`;
      console.log(
        `  ${date}  ${s.tokenIn}→${s.tokenOut}  ` +
          `vol=$${s.volumeUsd.toFixed(2)}  ` +
          `fee=$${s.feesUsd.toFixed(4)}  ` +
          `spread=${s.spreadPct.toFixed(4)}%  ` +
          `${s.txHash.slice(0, 12)}…`
      );
    }
    if (swaps.length > 10) console.log(`  … +${swaps.length - 10} more`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
