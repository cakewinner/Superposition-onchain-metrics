# Description

This PR adds a TVL adapter for **Barter Superposition** (USDC/USDT) on Ethereum.

# Changes

Added `projects/barterswap/index.js`

# How Barter Superposition works

LPs do not deposit into a shared pool. They approve USDC and USDT to the Superposition contract and the Barter router fills taker orders against LP wallet balances. Granting an approval = deposit. Revoking it = withdrawal.

| Contract | Address |
|---|---|
| Superposition (LPs approve here) | `0x69355223a0ce30aee41d353387c3082e5aafc4da` |
| SuperpositionRouter (transfers go through this address) | `0x0b7250866f0b014E6983cACc5b854EeA7a3d9188` |

# TVL Methodology

```
TVL = Σ min(allowance, balance)  for USDC + USDT  per LP wallet
```

- **LP discovery:** `Approval(owner, spender=VAULT)` events on USDC and USDT,
  filtered by vault address in topic[2] so only vault approvals are cached
  (avoids pulling millions of unrelated USDC/USDT approvals).
  `getLogs` caches these incrementally — only new blocks are fetched each run.
- **Live balances:** `allowance(owner, vault)` and `balanceOf(owner)` via multicall.
- **Filter:** only wallets with both USDC **and** USDT approved count
  (rules out wallets that are LPs on other pairs).
- Fully on-chain — no off-chain API dependency.

# Test Results

`npm run tvl` → `barterswap` (2026-05-02):

```
failed to fetch data from s3 bucket: cache/logs/ethereum/0xdac17f958d2ee523a2206206994597c13d831ec7.json
failed to fetch data from s3 bucket: cache/logs/ethereum/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.json

--- ethereum ---
USDC                      65.91 k
USDT                      17.48 k
Total: 83.39 k

--- tvl ---
USDC                      65.91 k
USDT                      17.48 k
Total: 83.39 k

------ TVL ------
ethereum                  83.39 k
total                     83.39 k

Run time: 73.119 (seconds)
```

Note: the S3 cache miss warnings are expected on first run — the incremental log cache doesn't exist yet. Subsequent runs will be faster as only new blocks are fetched.

# Checklist

- [x] TVL computed entirely from on-chain data
- [x] `getLogs` used with vault topic filter — no unrelated events cached
- [x] `getLogs` caches incrementally (only new blocks fetched per run)
- [x] `api.multiCall` for allowance + balance in one batch
- [x] Only wallets with both tokens approved counted
- [x] No extra npm packages added
- [x] Start block set to vault deploy block (24621188)

# Form

(Needs to be filled only for new listings)

**Name (to be shown on DefiLlama):** Barter Superposition

**Twitter Link:** https://x.com/BarterDeFi

**List of audit links if any:** https://github.com/mixbytes/audits_public/tree/master/Barter%20DAO

**Website Link:** https://app.barterswap.xyz/liquidity

**Logo:** *(attach high-resolution logo before submitting PR)*

**Current TVL:** $83,390

**Treasury Addresses (if the protocol has treasury):** N/A

**Chain:** Ethereum

**Coingecko ID:** *(leave empty — not listed)*

**Coinmarketcap ID:** *(leave empty — not listed)*

**Short Description:** Barter Superposition is a non-custodial liquidity protocol where LPs approve USDC/USDT to the vault and earn spread on swaps without depositing into a shared pool.

**Token address and ticker if any:** N/A

**Category:** DEX

**Oracle Provider(s):** None — both tokens are stablecoins (USDC/USDT), priced at $1 by DefiLlama's own price feed.

**Implementation Details:** No oracle is used in the contract. TVL is computed as `min(allowance, balance)` in raw token units; USD value comes from DefiLlama's standard token pricing.

**Documentation/Proof:** https://superposition.barterswap.xyz

**forkedFrom:** N/A (original design)

**methodology:** TVL is the sum of `min(allowance, balance)` for USDC and USDT across all LP wallets that have approved both tokens to the SuperpositionVault (`0x69355223a0ce30aee41d353387c3082e5aafc4da`). Granting an approval is equivalent to a deposit; revoking it is equivalent to a withdrawal. Only wallets with active approvals for both tokens are counted.

**Github org/user:** https://github.com/cakewinner

**Does this project have a referral program?** No
