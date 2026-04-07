import { PublicKey } from "@solana/web3.js";

export interface MarketData {
  // Address
  address: PublicKey;

  // Rise Market fields
  tenant: PublicKey;
  marketMeta: PublicKey;
  mintToken: PublicKey;
  mintMain: PublicKey;
  tokenDecimals: number;
  cashEscrow: PublicKey;
  creator: PublicKey | null;
  flags: number;
  level: number;
  lastFloorRaiseTimestamp: bigint;
  startingPrice: number;
  creatorRevPercent: number;
  totalFeesFloor: bigint;
  totalFeesCreator: bigint;
  totalFeesCreatorWithdrawn: bigint;
  totalFeesTeam: bigint;

  // Fees (from gov, converted to decimal: micro basis points / 1_000_000)
  buyFee: number;
  sellFee: number;
  borrowFee: number;

  // MarketMeta fields
  marketGroup: PublicKey;
  tokenUnitScale: number;

  // MarketLinear fields (curve state)
  tokenSupply: bigint;
  totalCashLiquidity: bigint;
  totalDebt: bigint;
  totalCollateral: bigint;
  cumulativeRevenueMarket: bigint;
  cumulativeRevenueTenant: bigint;
  floor: number;
  m1: number;
  m2: number;
  x2: bigint;
  b2: number;
  b1: number;

  // Computed fields (human-readable, normalized by decimals)
  price: number;
  floorPrice: number;
  supplyHuman: number;
}

export interface QuoteResult {
  direction: "buy" | "sell";
  amountIn: bigint;
  amountInHuman: number;
  amountOut: bigint;
  amountOutHuman: number;
  fee: bigint;
  feeHuman: number;
  feeRate: number;
  currentPrice: number;
  newPrice: number;
  averageFillPrice: number;
  priceImpact: number;
  currentSupplyHuman: number;
  newSupplyHuman: number;
}
