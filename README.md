# Rise SDK

TypeScript SDK for [Rise Protocol](https://rise.rich) — quote, buy, and sell tokens on Solana bonding curves.

Rise runs two on-chain programs, and this SDK covers both:

| | Program | Client |
|---|---|---|
| **v1** — Rise (Mayflower) | `RiseZSHaLdj7pfn1tisUoSdG2i3QcVz9sQKuaRG9rar` | `RiseSDK` |
| **v2** — Rise Pro | `RiseP9yY3UnMxd1df7mgGJiR39frg9QGsr1ro3zxrDq` | `RiseProSDK` |
| either | — | `Rise` (facade, detects the version for you) |

## Install

```bash
npm install @riserich/sdk
```

## Quick Start — the `Rise` facade (recommended)

`Rise` works with any Rise token: it detects whether a market is v1 or v2 and calls the right client.

```typescript
import { Rise } from "@riserich/sdk";
import { PublicKey } from "@solana/web3.js";

const rise = new Rise({ rpcUrl: "https://api.mainnet-beta.solana.com" });
const mint = new PublicKey("TokenMint...rise");
const wallet = new PublicKey("YourWallet...");

// Detects the version (one extra RPC call) and returns the market; `market.version` is 1 or 2.
const market = await rise.getMarket(mint);

// Unsigned VersionedTransactions, for either version.
const buyTx = await rise.buildBuyTransaction({ wallet, market: mint, cashIn: 10_000_000n, minTokenOut: 0n });
const sellTx = await rise.buildSellTransaction({ wallet, market: mint, tokenIn: 1_000_000n, minCashOut: 0n });
```

Quotes use the version-specific clients, available on the facade as `rise.v1` and `rise.v2`:

```typescript
if (market.version === 2) {
  const q = rise.v2.quoteBuy(market, 10_000_000n);
} else {
  const q = await rise.v1.quote(market, 1_000_000_000, "buy");
}
```

### Already know the version? Skip the detection

Detection costs one extra RPC call per facade call. If you know the version:

- pass `version: 1 | 2` to the facade methods (`getMarket(mint, 2)`, `buildBuyTransaction({ ..., version: 2 })`), or
- use the client directly — `RiseSDK` for v1, `RiseProSDK` for v2 — and reuse the market you fetched once: quotes then need no RPC at all, and building a transaction only fetches a blockhash.

---

## v2 — `RiseProSDK`

```typescript
import { RiseProSDK } from "@riserich/sdk";

const sdk = new RiseProSDK({ rpcUrl: "https://api.mainnet-beta.solana.com" });

// Accepts the token mint or the market address.
const market = await sdk.getMarket(new PublicKey("TokenMint...rise"));
console.log("spot:", sdk.spotPriceNumber(market)); // collateral per token
```

### Quote (no RPC call)

All v2 amounts are **raw `bigint`** (smallest units). A v2 token has the **same decimals as its collateral** (USDC 6, SOL 9, …).

```typescript
const buy = sdk.quoteBuy(market, 10_000_000n);   // 10 USDC in
buy.tokenOut;    // tokens received
buy.fee.total;   // trading fee (plus buy.reflection when the token has a reflection tax)
buy.spotAfter;   // spot after the trade, Q64.64

const sell = sdk.quoteSell(market, 1_000_000n);  // 1 token in
sell.payout;         // collateral received, after fees
sell.bookShortfall;  // > 0 when the exit is capped by the market's reserves (already deducted from payout)
```

Quotes are bit-exact with the program: the realized result equals the quote when the market has not moved in between.

### Buy / sell

```typescript
const slippageBps = 100n; // 1%
const buyTx = await sdk.buildBuyTransaction(market, wallet, 10_000_000n, (buy.tokenOut * (10_000n - slippageBps)) / 10_000n);
const sellTx = await sdk.buildSellTransaction(market, wallet, 1_000_000n, (sell.payout * (10_000n - slippageBps)) / 10_000n);
// sign and send with your wallet adapter
```

SOL markets are handled automatically (wrap on buy, unwrap on sell).

### Lending, leverage and creator fees

Every builder returns an unsigned `VersionedTransaction`.

```typescript
// Position of a wallet on a market (zeros when none).
const pos = await sdk.getPosition(market.address, wallet); // { collateral, debt }

// Lending: deposit tokens as collateral, borrow collateral currency against them.
await sdk.buildDepositTransaction(market, wallet, tokens);
await sdk.buildBorrowTransaction(market, wallet, amount);
await sdk.buildRepayTransaction(market, wallet, amount);
await sdk.buildWithdrawTransaction(market, wallet, tokens);

// Leverage: buy with your cash + borrowed cash in one transaction (tokens stay as collateral) …
await sdk.buildLeverageBuyTransaction(market, wallet, cashIn, borrowAmount, minTokenOut);
// … and unwind: sell collateral, repay debt, receive the rest.
await sdk.buildLeverageSellTransaction(market, wallet, collateralIn, decreaseDebtBy, minCashOut);

// Creator: claim the accumulated creator fees.
await sdk.buildClaimCreatorFeesTransaction(market, creatorWallet);
```

### Options, program id and devnet

| Option | Default | |
|---|---|---|
| `rpcUrl` / `connection` | — | RPC endpoint (one is required) |
| `programId` | mainnet `RiseP9yY…` | the Rise Pro program |
| `computeUnitLimit` | `600000` | compute budget per transaction |
| `computeUnitPrice` | `50000` | priority fee, micro-lamports per CU |

For **devnet**, pass the devnet program id:

```typescript
import { RiseProSDK, Rise, v2 } from "@riserich/sdk";

const sdk = new RiseProSDK({ rpcUrl: DEVNET_RPC, programId: v2.DEVNET_V2_PROGRAM_ID });
const rise = new Rise({ rpcUrl: DEVNET_RPC, v2ProgramId: v2.DEVNET_V2_PROGRAM_ID });
```

---

## v1 — `RiseSDK`

```typescript
import { RiseSDK } from "@riserich/sdk";

const rise = new RiseSDK({ rpcUrl: "https://api.mainnet-beta.solana.com" });

// Get market data
const market = await rise.getMarket("2QhguqVE2DsqD9XBsKK9ZZpEAWyGwv4LRfPSymnG5UuM");

console.log(`Price: ${market.price}`);
console.log(`Floor: ${market.floorPrice}`);
console.log(`Supply: ${market.supplyHuman}`);
console.log(`Buy fee: ${market.buyFee * 100}%`);
```

### Quote

```typescript
// Buy quote: how many tokens for 1 SOL?
const buyQuote = await rise.quote(market, 1_000_000_000, "buy"); // 1 SOL in lamports
console.log(`Tokens out: ${buyQuote.amountOutHuman}`);
console.log(`Price impact: ${(buyQuote.priceImpact * 100).toFixed(2)}%`);
console.log(`Fee: ${buyQuote.feeHuman}`);

// Sell quote: how much SOL for 1000 tokens?
const sellQuote = await rise.quote(market, 1000_000_000_000, "sell"); // 1000 tokens (9 decimals)
console.log(`Cash out: ${sellQuote.amountOutHuman}`);

// Quote with fresh on-chain data (pass address instead of cached market)
const freshQuote = await rise.quote("2QhguqVE...", 1_000_000_000, "buy");
```

### Build Transactions

```typescript
const wallet = "YourWalletAddress...";

// Build buy transaction (returns unsigned VersionedTransaction)
const buyTx = await rise.buildBuyTransaction(
  market,           // or market address string
  wallet,
  1_000_000_000,    // cashIn: 1 SOL in lamports
  0,                // minTokenOut: set to 0 for no slippage protection
);

// Build sell transaction
const sellTx = await rise.buildSellTransaction(
  market,
  wallet,
  1000_000_000_000, // tokenIn: 1000 tokens (9 decimals)
  0,                // minCashOut
);

// Sign and send with your wallet adapter
const signature = await wallet.signAndSendTransaction(buyTx);
```

### API

#### `new RiseSDK(opts)`

| Option | Type | Description |
|--------|------|-------------|
| `rpcUrl` | `string` | Solana RPC endpoint URL |
| `connection` | `Connection` | Existing `@solana/web3.js` Connection |

#### `rise.getMarket(address)`

Fetches market data from on-chain (2 RPC calls). Returns `MarketData` with all fields from Rise Market, MarketMeta, and MarketLinear accounts.

#### `rise.quote(marketOrAddress, amount, direction)`

Calculates trade outcome. Pass `MarketData` for no RPC calls, or pass address string for fresh data.

| Param | Type | Description |
|-------|------|-------------|
| `marketOrAddress` | `MarketData \| string` | Cached market data or address |
| `amount` | `number \| bigint` | Amount in RAW (lamports / smallest unit) |
| `direction` | `"buy" \| "sell"` | Trade direction |

#### `rise.buildBuyTransaction(marketOrAddress, wallet, cashIn, minTokenOut)`

Builds an unsigned `VersionedTransaction` for buying tokens. Handles WSOL wrapping automatically.

#### `rise.buildSellTransaction(marketOrAddress, wallet, tokenIn, minCashOut)`

Builds an unsigned `VersionedTransaction` for selling tokens. Handles WSOL unwrapping automatically.
