# Rise SDK

TypeScript SDK for [Rise Protocol](https://rise.rich) — quote, buy, and sell tokens on Solana bonding curves.

## Install

```bash
npm install @riserich/sdk
```

## Quick Start

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

## Quote

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

## Build Transactions

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

## API

### `new RiseSDK(opts)`

| Option | Type | Description |
|--------|------|-------------|
| `rpcUrl` | `string` | Solana RPC endpoint URL |
| `connection` | `Connection` | Existing `@solana/web3.js` Connection |

### `rise.getMarket(address)`

Fetches market data from on-chain (2 RPC calls). Returns `MarketData` with all fields from Rise Market, MarketMeta, and MarketLinear accounts.

### `rise.quote(marketOrAddress, amount, direction)`

Calculates trade outcome. Pass `MarketData` for no RPC calls, or pass address string for fresh data.

| Param | Type | Description |
|-------|------|-------------|
| `marketOrAddress` | `MarketData \| string` | Cached market data or address |
| `amount` | `number \| bigint` | Amount in RAW (lamports / smallest unit) |
| `direction` | `"buy" \| "sell"` | Trade direction |

### `rise.buildBuyTransaction(marketOrAddress, wallet, cashIn, minTokenOut)`

Builds an unsigned `VersionedTransaction` for buying tokens. Handles WSOL wrapping automatically.

### `rise.buildSellTransaction(marketOrAddress, wallet, tokenIn, minCashOut)`

Builds an unsigned `VersionedTransaction` for selling tokens. Handles WSOL unwrapping automatically.
