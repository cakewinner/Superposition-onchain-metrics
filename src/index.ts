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
 *   volume Nd  = Σ taker_amount (raw) for USDC↔USDT swaps in last N days
 *   fees Nd    = Σ (taker_amount − maker_amount) in raw token units
 *   fees APR   = (fees / N / TVL) × 365   (annualised from the window)
 *
 * LP discovery: Approval(owner, vault) events on USDC and USDT
 * Volume/fees:  Transfer events to the router + router.swap() calldata decode
 *
 * See .env.example for configuration options.
 */

import "dotenv/config";
import { ethers } from "ethers";

// ─── Config ───────────────────────────────────────────────────────────────────

const VAULT_ADDRESS = (
  process.env.VAULT_ADDRESS ?? "0x69355223a0ce30aee41d353387c3082e5aafc4da"
).toLowerCase();

const ROUTER = "0x0b7250866f0b014E6983cACc5b854EeA7a3d9188";

const START_BLOCK = parseInt(process.env.START_BLOCK ?? "24621188", 10);
const CHUNK_SIZE  = parseInt(process.env.CHUNK_SIZE  ?? "25000",    10);

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const DECIMALS       = 6;
const BLOCKS_PER_DAY = 7200;

const WINDOWS = [1, 5, 7] as const;

const SKIP_APPROVAL_LOG_SCAN = /^1|true|yes$/i.test(process.env.SKIP_APPROVAL_LOG_SCAN ?? "");

function parseSeedAddresses(): string[] {
  return (process.env.SEED_LP_ADDRESSES ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s));
}

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
  maker: string;
  tokenIn: string;
  tokenOut: string;
  volumeUsd: number;
  feesUsd: number;
  spreadPct: number;
}

export interface WindowStats {
  days: number;
  volumeUsd: number;
  feesUsd: number;
  feesTvlRatio: number;
  feesAPRPct: number;
  swapCount: number;
  avgSpreadPct: number;
}

export interface PoolStats {
  pair: string;
  tvlUsd: number;
  rewardsAPRPct: number;
  activePositions: number;
  windows: WindowStats[];
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
        const isNetworkErr =
          (err as { code?: string })?.code === "ECONNRESET" ||
          msg.includes("econnreset") || msg.includes("etimedout") ||
          msg.includes("socket hang up") || msg.includes("fetch failed");
        if (isNetworkErr) {
          attempts++;
          if (attempts > 8) throw err;
          await sleep(500 * Math.pow(2, attempts));
          continue;
        }
        throw err;
      }
    }
  }

  return out;
}

function computeWindow(
  swaps: SwapSummary[],
  days: number,
  tvlUsd: number,
  tipBlock: number
): WindowStats {
  const filtered = swaps.filter((s) => s.blockNumber >= tipBlock - days * BLOCKS_PER_DAY);

  const volumeUsd    = filtered.reduce((s, sw) => s + sw.volumeUsd, 0);
  const feesUsd      = filtered.reduce((s, sw) => s + sw.feesUsd, 0);
  const feesTvlRatio = tvlUsd > 0 ? feesUsd / tvlUsd : 0;
  const feesAPRPct   = tvlUsd > 0 ? (feesUsd / days / tvlUsd) * 365 * 100 : 0;
  const avgSpreadPct = volumeUsd > 0 ? (feesUsd / volumeUsd) * 100 : 0;

  return { days, volumeUsd, feesUsd, feesTvlRatio, feesAPRPct, swapCount: filtered.length, avgSpreadPct };
}

// ─── TVL ──────────────────────────────────────────────────────────────────────

// A wallet only counts if it has approved BOTH tokens — rules out wallets on other pairs.
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

// ─── Pool stats ───────────────────────────────────────────────────────────────

async function getPoolStats(): Promise<{
  stats: PoolStats;
  positions: Position[];
  swaps: SwapSummary[];
}> {
  console.log("Scanning from block", START_BLOCK);
  const provider = getProvider();
  const usdc = new ethers.Contract(USDC, ERC20_ABI, provider);
  const usdt = new ethers.Contract(USDT, ERC20_ABI, provider);
  const tip = await provider.getBlockNumber();

  const seed = parseSeedAddresses();
  let makers: string[];

  if (SKIP_APPROVAL_LOG_SCAN) {
    if (!seed.length) throw new Error(
      "SKIP_APPROVAL_LOG_SCAN=true but SEED_LP_ADDRESSES is empty. " +
      "Add comma-separated LP addresses or unset SKIP_APPROVAL_LOG_SCAN."
    );
    console.log(`  Using ${seed.length} address(es) from SEED_LP_ADDRESSES`);
    makers = seed;
  } else {
    console.log("  Scanning USDC approvals…");
    const usdcAp = await queryEvents(usdc, usdc.filters.Approval(null, VAULT_ADDRESS), START_BLOCK, tip);
    console.log(`  ✓ ${usdcAp.length} events`);

    console.log("  Scanning USDT approvals…");
    const usdtAp = await queryEvents(usdt, usdt.filters.Approval(null, VAULT_ADDRESS), START_BLOCK, tip);
    console.log(`  ✓ ${usdtAp.length} events`);

    makers = [...new Set(
      [...usdcAp, ...usdtAp].map((e) => (e.args.owner as string).toLowerCase()).concat(seed)
    )];
  }

  console.log("Fetching TVL from chain…");
  const positions = await getPositions(makers);
  const tvlUsd = positions.reduce((s, p) => s + p.tvlUsd, 0);

  const maxWindow = Math.max(...WINDOWS);
  const fromBlock = Math.max(tip - maxWindow * BLOCKS_PER_DAY, START_BLOCK);
  console.log(`  Scanning swap transfers (last ${maxWindow}d)…`);

  const [usdcIn, usdtIn] = await Promise.all([
    queryEvents(usdc, usdc.filters.Transfer(null, ROUTER), fromBlock, tip),
    queryEvents(usdt, usdt.filters.Transfer(null, ROUTER), fromBlock, tip),
  ]);

  const txHashes = new Set([...usdcIn, ...usdtIn].map((e) => e.transactionHash));
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
          (actualTaker * (payload.makerAmount as bigint)) / (payload.takerAmount as bigint);

        const volumeUsd = toUsd(actualTaker);
        const feesUsd   = toUsd(actualTaker) - toUsd(effectiveMaker);
        const receipt   = await provider.getTransactionReceipt(hash);

        swaps.push({
          txHash: hash,
          blockNumber: receipt?.blockNumber ?? 0,
          maker: (payload.maker as string).toLowerCase(),
          tokenIn:  takerToken === USDC ? "USDC" : "USDT",
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

  swaps.sort((a, b) => b.blockNumber - a.blockNumber);

  const windows = WINDOWS.map((d) => computeWindow(swaps, d, tvlUsd, tip));

  return {
    stats: {
      pair: "USDC/USDT",
      tvlUsd,
      rewardsAPRPct: 0,
      activePositions: positions.length,
      windows,
    },
    positions,
    swaps,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function fmt$(n: number, decimals = 2) {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function col(s: string, width: number) {
  return s.padStart(width);
}

async function main() {
  console.log("=== Barter Superposition — Revert Integration ===\n");

  const { stats, positions, swaps } = await getPoolStats();

  const W = 13;
  const header = ["", ...stats.windows.map((w) => `${w.days}d`)].map((s, i) =>
    i === 0 ? s.padEnd(18) : col(s, W)
  ).join("  ");

  const row = (label: string, vals: string[]) =>
    [label.padEnd(18), ...vals.map((v) => col(v, W))].join("  ");

  console.log("\n─── Pool: USDC/USDT ──────────────────────────────────────────");
  console.log(`TVL:          ${fmt$(stats.tvlUsd)}`);
  console.log(`Active LPs:   ${stats.activePositions}`);
  console.log(`Rewards APR:  ${stats.rewardsAPRPct.toFixed(2)}%`);

  console.log("\n" + header);
  console.log("─".repeat(18 + (W + 2) * stats.windows.length));
  console.log(row("Volume",     stats.windows.map((w) => fmt$(w.volumeUsd))));
  console.log(row("Fees",       stats.windows.map((w) => fmt$(w.feesUsd, 4))));
  console.log(row("Fees/TVL",   stats.windows.map((w) => w.feesTvlRatio.toFixed(6))));
  console.log(row("Fees APR",   stats.windows.map((w) => w.feesAPRPct.toFixed(2) + "%")));
  console.log(row("Avg spread", stats.windows.map((w) => w.avgSpreadPct.toFixed(4) + "%")));
  console.log(row("Swaps",      stats.windows.map((w) => String(w.swapCount))));

  if (positions.length > 0) {
    console.log("\n─── Active LP Positions ──────────────────────────────────────");
    for (const p of positions) {
      console.log(
        `  ${p.owner.slice(0, 10)}…  ` +
          `USDC ${fmt$(p.usdcEffectiveUsd)}  ` +
          `USDT ${fmt$(p.usdtEffectiveUsd)}  ` +
          `= ${fmt$(p.tvlUsd)}`
      );
    }
  }

  if (swaps.length > 0) {
    console.log("\n─── Recent USDC↔USDT Swaps ───────────────────────────────────");
    for (const s of swaps.slice(0, 10)) {
      console.log(
        `  block ${s.blockNumber}  ${s.tokenIn}→${s.tokenOut}  ` +
          `vol=${fmt$(s.volumeUsd)}  ` +
          `fee=${fmt$(s.feesUsd, 4)}  ` +
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
