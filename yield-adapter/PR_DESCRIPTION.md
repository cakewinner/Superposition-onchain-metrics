# Description

This PR adds a yield adapter for **Barter Superposition** (USDC/USDT pair) on Ethereum.

# Changes

Added `src/adaptors/barterswap/index.js` — tracks TVL, APY, and volume for the Barter Superposition USDC/USDT pool.

# Data Source

**How Barter Superposition works:**  
LPs do not deposit into a shared pool. Instead, they approve USDC and USDT to the SuperpositionVault, and the Barter router fills taker orders against LP wallet balances. LP profit is the spread per swap: `takerAmount − makerAmount` in raw token units.

| Contract | Address |
|---|---|
| SuperpositionVault (LPs approve here) | `0x69355223a0ce30aee41d353387c3082e5aafc4da` |
| SuperpositionRouter | `0x0b7250866f0b014E6983cACc5b854EeA7a3d9188` |
| USDC | `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` |
| USDT | `0xdac17f958d2ee523a2206206994597c13d831ec7` |

**TVL:** `Σ min(allowance, balance)` for USDC + USDT per LP wallet, via `@defillama/sdk` multicall. Only wallets with both USDC and USDT approved are counted (rules out wallets on other pairs).

**APY:** fees / TVL annualised, where fees = `Σ (takerAmount − makerAmount)` in raw token units (avoids oracle noise from USD-converted fields). `apyBase` is annualised from 1d; `apyBase7d` is annualised from 7d.

**Swap history:** fetched from the Barter Superposition API, which provides full transaction history including raw token amounts.

# Technical Details

- Category: DEX
- Chain: Ethereum
- Protocol: https://superposition.barterswap.xyz
- Start Date: 2025-11-04
- Pool ID: `0x69355223a0ce30aee41d353387c3082e5aafc4da-ethereum`

# Test Results

Run locally with `node src/adaptors/barterswap/index.js` (2026-04-29):

```json
[
  {
    "pool": "0x69355223a0ce30aee41d353387c3082e5aafc4da-ethereum",
    "chain": "Ethereum",
    "project": "barterswap",
    "symbol": "USDC-USDT",
    "tvlUsd": 70711.73,
    "apyBase": 0.72,
    "apyBase7d": 9.65,
    "underlyingTokens": [
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "0xdac17f958d2ee523a2206206994597c13d831ec7"
    ],
    "poolMeta": "Superposition",
    "url": "https://superposition.barterswap.xyz",
    "volumeUsd1d": 10645.45,
    "volumeUsd7d": 157921.84
  }
]
```

TVL and APY are live (fetched at test time). The 1d APY is lower than the 7d because today had below-average volume; the 7d window (~9.65%) is the more representative figure.

# Methodology

- TVL counts only wallets that have approved both USDC and USDT to the vault, so LPs on other pairs (e.g. USDC/WETH) are excluded even if they happen to hold both tokens.
- Fees use raw `taker_amount − maker_amount` in token units, not the API's oracle-priced USD fields, to avoid rounding noise from stablecoin depeg on small trades.
- APY is annualised per window: `(fees / days / TVL) × 365`.

# Checklist

- [x] Adapter fetches live on-chain TVL via `@defillama/sdk` multicall
- [x] Volume and fees from Barter Superposition API (raw token amounts)
- [x] Only USDC↔USDT swaps counted
- [x] Only wallets with both tokens approved counted toward TVL
- [x] `apyBase` (1d) and `apyBase7d` (7d) both provided
- [x] `volumeUsd1d` and `volumeUsd7d` both provided
- [x] Tested with live data

# Form

**Name (to be shown on DefiLlama):** Barter Superposition

**Twitter Link:** https://x.com/BarterDeFi

**List of audit links if any:** https://github.com/mixbytes/audits_public/tree/master/Barter%20DAO

**Website Link:** https://superposition.barterswap.xyz

**Chain:** Ethereum

**Short Description:** Barter Superposition is a non-custodial liquidity layer on Ethereum — LPs earn spread by approving USDC/USDT to the vault without depositing into a shared pool.

**Category:** DEX
