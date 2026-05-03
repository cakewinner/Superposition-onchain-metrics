Description
This PR adds an adapter to track Barter's aggregator trading volume on Ethereum.

Changes
Added aggregators/barter/index.ts — tracks daily aggregator volume via on-chain token transfer events
Data Source
On-chain ERC-20 Transfer events received by Barter executor contracts:

Executor	Address
Executor 1	0x2c0552e5dcb79b064fd23e358a86810bc5994244
Executor 2	0x2141af658ffda533da864dd11b2ffdb8529c8b94
Executor 3	0xb2f72662ed42067ccce278f8462a0215b6adcabb
The adapter uses addTokensReceived to track token inflows to executor contracts. A logFilter deduplicates by transaction hash so only one transfer per swap is counted (the sell-side token from the user), avoiding double-counting from DEX returns and multi-hop routing.

Reference Dune query for volume verification: https://dune.com/queries/6493443

Technical Details
Category: Aggregators
Chain: Ethereum
Start Date: 2023-01-01
Protocol: https://app.barterswap.xyz
Adapter version: 2
Test Results
Note on local testing: The addTokensReceived helper relies on the DefiLlama token-transfer indexer, which is not available in a local environment (Llama Indexer URL/api key is not set). The fallback to getLogs with noTarget: true also fails on standard RPC endpoints that do not support broad log queries across all contracts.

To verify the adapter locally, a separate test was run with a hardcoded list of major tokens (WETH, USDC, USDT, DAI, WBTC, wstETH, stETH, weETH, etc.) queried individually as getLogs targets. This approach works on any RPC but only covers a subset of tokens, so the actual volume in production (where the indexer discovers all tokens automatically) is expected to be higher than the test results shown below.

🦙 Running BARTER-LOCAL-TEST adapter 🦙
---------------------------------------------------
Start Date:     Wed, 04 Feb 2026 00:00:00 GMT
End Date:       Thu, 05 Feb 2026 00:00:00 GMT
---------------------------------------------------

ETHEREUM 👇
Backfill start time: 1/1/2023
Daily volume: 46.23 M
End timestamp: 1770249599 (2026-02-04T23:59:59.000Z)
Methodology
For each transaction involving a Barter executor, only the first ERC-20 transfer received by the executor is counted as volume. This represents the sell-side token sent by the user. Subsequent transfers within the same transaction (buy-token returns from DEXes, multi-hop intermediates) are excluded via per-tx deduplication.

Checklist
 Adapter fetches data from on-chain logs
 Per-transaction deduplication to avoid double-counting
 Inter-executor transfers filtered out
 Start timestamp configured correctly
 Code follows project conventions
 Tested with recent dates
Form
Name (to be shown on DefiLlama): Barter

Twitter Link: https://x.com/BarterDeFi

List of audit links if any: https://github.com/mixbytes/audits_public/tree/master/Barter%20DAO

Website Link: https://barterswap.xyz/

Logo (High resolution, will be shown with rounded borders): icon-logo

Chain: Ethereum

Short Description (to be shown on DefiLlama): Barter is one of the largest aggregators on Ethereum, powering major intent DEXs and frontends to provide DeFi users best prices

Category (full list at https://defillama.com/categories) *Please choose only one: DEX aggregator