# Barter Superposition — On-chain Metrics

On-chain integrations for **Barter Superposition** (USDC/USDT pair on Ethereum).

Barter Superposition is non-custodial: LPs keep their tokens in their own wallets
and approve them to the SuperpositionVault. The router fills taker orders against
LP balances directly. LP profit is the spread per swap — the difference between
what the taker sends and what the LP gives out.

| Contract | Address |
|---|---|
| SuperpositionVault | `0x69355223a0ce30aee41d353387c3082e5aafc4da` |
| SuperpositionRouter | `0x0b7250866f0b014E6983cACc5b854EeA7a3d9188` |
| USDC | `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` |
| USDT | `0xdac17f958d2ee523a2206206994597c13d831ec7` |

---

## Revert Finance integration

Outputs the fields Revert Finance tracks for a pool, across 1d / 5d / 7d windows:

| Field | How it's computed |
|---|---|
| TVL | `Σ min(allowance, balance)` per token per LP wallet |
| Volume | `Σ taker_amount` (raw) for USDC↔USDT swaps |
| Fees | `Σ (taker_amount − maker_amount)` — LP spread profit |
| Fees APR | `(fees / days / TVL) × 365` |

Scans `Approval(owner, vault)` events on USDC/USDT to discover LP wallets,
then decodes `router.swap()` calldata for volume and fees. TVL is computed
live via `allowance` + `balanceOf` calls for each LP.

**Quick start:**

```bash
cp .env.example .env   # fill in ETH_RPC_URL
npm install
npm start
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ETH_RPC_URL` | yes | Ethereum JSON-RPC — needs ≥25k block range support (e.g. `https://eth.llamarpc.com`) |
| `CHUNK_SIZE` | no | Blocks per `eth_getLogs` request (default: `25000`) |

See `.env.example` for the full template.

---

## Links

- Protocol: https://superposition.barterswap.xyz
- Audit: https://github.com/mixbytes/audits_public/tree/master/Barter%20DAO
- Twitter: https://x.com/BarterDeFi
