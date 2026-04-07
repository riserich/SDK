import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { RISE_PROGRAM_ID } from "./constants";
import { PDA } from "./pda";
import {
  deserializeRiseMarket,
  deserializeMarketLinear,
  deserializeMarketMeta,
} from "./deserialize";
import {
  calculatePrice,
  calculateTokensFromCash,
  calculateCashFromTokens,
} from "./quote";
import { buildBuyTransaction } from "./transactions/buy";
import { buildSellTransaction } from "./transactions/sell";
import { MarketData, QuoteResult } from "./types";
import riseIdl from "./idl/rise.json";

export class RiseSDK {
  readonly connection: Connection;
  private program: anchor.Program;

  constructor(opts: { rpcUrl: string } | { connection: Connection }) {
    this.connection = "connection" in opts ? opts.connection : new Connection(opts.rpcUrl, "confirmed");

    // Read-only Anchor provider (no wallet needed — SDK only builds unsigned txs)
    const dummyWallet = {
      publicKey: PublicKey.default,
      signTransaction: async (tx: any) => tx,
      signAllTransactions: async (txs: any) => txs,
    } as anchor.Wallet;
    const provider = new anchor.AnchorProvider(this.connection, dummyWallet, { commitment: "confirmed" });
    this.program = new anchor.Program(riseIdl as any, RISE_PROGRAM_ID, provider);
  }

  // ─── Resolve mint token address → market address ─────────────────────

  async resolveMarketAddress(mintOrMarket: string | PublicKey): Promise<PublicKey> {
    const key = typeof mintOrMarket === "string" ? new PublicKey(mintOrMarket) : mintOrMarket;

    // Try mint token first (most common use case)
    // Rise Market layout: 8 (discriminator) + 32 (tenant) + 32 (marketMeta) = offset 72 for mintToken
    const accounts = await this.connection.getProgramAccounts(RISE_PROGRAM_ID, {
      filters: [
        { memcmp: { offset: 72, bytes: key.toBase58() } },
      ],
    });

    if (accounts.length > 0) {
      return accounts[0].pubkey;
    }

    // Not a mint — check if it's a market address directly
    const accountInfo = await this.connection.getAccountInfo(key, "confirmed");
    if (accountInfo?.owner.equals(RISE_PROGRAM_ID)) {
      return key;
    }

    throw new Error(`No Rise market found for address: ${key.toBase58()}`);
  }

  // ─── Get Market ─────────────────────────────────────────────────────────

  async getMarket(addressOrMint: string | PublicKey): Promise<MarketData> {
    const address = await this.resolveMarketAddress(addressOrMint);

    // Fetch Rise Market account first to get marketMeta address
    const riseAccountInfo = await this.connection.getAccountInfo(address, "confirmed");
    if (!riseAccountInfo?.data) throw new Error(`Market not found: ${address.toBase58()}`);

    const riseMarket = deserializeRiseMarket(riseAccountInfo.data as Buffer);
    const marketMetaKey = riseMarket.marketMeta;

    // Derive MarketLinear PDA from marketMeta
    const marketLinearKey = PDA.marketLinear(marketMetaKey);

    // Fetch MarketMeta + MarketLinear in one call
    const [metaInfo, linearInfo] = await this.connection.getMultipleAccountsInfo(
      [marketMetaKey, marketLinearKey],
      "confirmed",
    );

    if (!metaInfo?.data) throw new Error(`MarketMeta not found: ${marketMetaKey.toBase58()}`);
    if (!linearInfo?.data) throw new Error(`MarketLinear not found: ${marketLinearKey.toBase58()}`);

    const meta = deserializeMarketMeta(metaInfo.data as Buffer);
    const linear = deserializeMarketLinear(linearInfo.data as Buffer);

    const decimals = riseMarket.tokenDecimals;
    const decimalsFactor = Math.pow(10, decimals);

    // Normalize curve params for price calculation
    const supplyHuman = Number(linear.tokenSupply) / decimalsFactor;
    const m1Normalized = linear.m1 * decimalsFactor;
    const m2Normalized = linear.m2 * decimalsFactor;
    const x2Normalized = Number(linear.x2) / decimalsFactor;

    const price = calculatePrice(supplyHuman, linear.floor, m1Normalized, m2Normalized, x2Normalized, linear.b2);

    return {
      address,
      // Rise Market
      tenant: riseMarket.tenant,
      marketMeta: marketMetaKey,
      mintToken: riseMarket.mintToken,
      mintMain: riseMarket.mintMain,
      tokenDecimals: decimals,
      cashEscrow: riseMarket.cashEscrow,
      creator: riseMarket.creator,
      flags: riseMarket.flags,
      level: riseMarket.level,
      lastFloorRaiseTimestamp: riseMarket.lastFloorRaiseTimestamp,
      startingPrice: riseMarket.startingPrice,
      creatorRevPercent: riseMarket.creatorRevPercent,
      totalFeesFloor: riseMarket.totalFeesFloor,
      totalFeesCreator: riseMarket.totalFeesCreator,
      totalFeesCreatorWithdrawn: riseMarket.totalFeesCreatorWithdrawn,
      totalFeesTeam: riseMarket.totalFeesTeam,
      buyFee: riseMarket.buyFeeMicroBasisPoints / 1_000_000,
      sellFee: riseMarket.sellFeeMicroBasisPoints / 1_000_000,
      borrowFee: riseMarket.borrowFeeMicroBasisPoints / 1_000_000,
      // MarketMeta
      marketGroup: meta.marketGroup,
      tokenUnitScale: meta.tokenUnitScale,
      // MarketLinear
      tokenSupply: linear.tokenSupply,
      totalCashLiquidity: linear.totalCashLiquidity,
      totalDebt: linear.totalDebt,
      totalCollateral: linear.totalCollateral,
      cumulativeRevenueMarket: linear.cumulativeRevenueMarket,
      cumulativeRevenueTenant: linear.cumulativeRevenueTenant,
      floor: linear.floor,
      m1: linear.m1,
      m2: linear.m2,
      x2: linear.x2,
      b2: linear.b2,
      b1: linear.b1,
      // Computed
      price,
      floorPrice: linear.floor,
      supplyHuman,
    };
  }

  // ─── Quote ──────────────────────────────────────────────────────────────

  async quote(
    marketOrAddress: MarketData | string | PublicKey,
    amount: number | bigint,
    direction: "buy" | "sell",
  ): Promise<QuoteResult> {
    const market =
      typeof marketOrAddress === "object" && "address" in marketOrAddress
        ? marketOrAddress
        : await this.getMarket(marketOrAddress);

    const decimals = market.tokenDecimals;
    const decimalsFactor = Math.pow(10, decimals);

    // Normalize curve params
    const supplyHuman = Number(market.tokenSupply) / decimalsFactor;
    const m1 = market.m1 * decimalsFactor;
    const m2 = market.m2 * decimalsFactor;
    const x2 = Number(market.x2) / decimalsFactor;

    const amountRaw = BigInt(amount);
    const amountHuman = Number(amountRaw) / decimalsFactor;

    const currentPrice = calculatePrice(supplyHuman, market.floor, m1, m2, x2, market.b2);

    if (direction === "buy") {
      const feeRate = market.buyFee;
      const feeRaw = BigInt(Math.floor(Number(amountRaw) * feeRate));
      const effectiveCashHuman = amountHuman * (1 - feeRate);

      const tokensOut = calculateTokensFromCash(supplyHuman, effectiveCashHuman, market.floor, m1, m2, x2, market.b2);
      const tokensOutRaw = BigInt(Math.floor(tokensOut * decimalsFactor));

      const newSupply = supplyHuman + tokensOut;
      const newPrice = calculatePrice(newSupply, market.floor, m1, m2, x2, market.b2);
      const avgPrice = tokensOut > 0 ? effectiveCashHuman / tokensOut : currentPrice;

      return {
        direction: "buy",
        amountIn: amountRaw,
        amountInHuman: amountHuman,
        amountOut: tokensOutRaw,
        amountOutHuman: tokensOut,
        fee: feeRaw,
        feeHuman: Number(feeRaw) / decimalsFactor,
        feeRate,
        currentPrice,
        newPrice,
        averageFillPrice: avgPrice,
        priceImpact: currentPrice > 0 ? (newPrice - currentPrice) / currentPrice : 0,
        currentSupplyHuman: supplyHuman,
        newSupplyHuman: newSupply,
      };
    } else {
      const feeRate = market.buyFee;
      const totalCash = calculateCashFromTokens(supplyHuman, amountHuman, market.floor, m1, m2, x2, market.b2);
      const fee = totalCash * feeRate;
      const cashOut = totalCash - fee;

      const cashOutRaw = BigInt(Math.floor(cashOut * decimalsFactor));
      const feeRaw = BigInt(Math.floor(fee * decimalsFactor));

      const newSupply = supplyHuman - amountHuman;
      const newPrice = calculatePrice(Math.max(0, newSupply), market.floor, m1, m2, x2, market.b2);
      const avgPrice = amountHuman > 0 ? cashOut / amountHuman : currentPrice;

      return {
        direction: "sell",
        amountIn: amountRaw,
        amountInHuman: amountHuman,
        amountOut: cashOutRaw,
        amountOutHuman: cashOut,
        fee: feeRaw,
        feeHuman: Number(feeRaw) / decimalsFactor,
        feeRate,
        currentPrice,
        newPrice,
        averageFillPrice: avgPrice,
        priceImpact: currentPrice > 0 ? (newPrice - currentPrice) / currentPrice : 0,
        currentSupplyHuman: supplyHuman,
        newSupplyHuman: Math.max(0, newSupply),
      };
    }
  }

  // ─── Build Buy Transaction ──────────────────────────────────────────────

  async buildBuyTransaction(
    marketOrAddress: MarketData | string | PublicKey,
    wallet: string | PublicKey,
    cashIn: number | bigint | BN,
    minTokenOut: number | bigint | BN,
  ): Promise<VersionedTransaction> {
    const market =
      typeof marketOrAddress === "object" && "address" in marketOrAddress
        ? marketOrAddress
        : await this.getMarket(marketOrAddress);

    const walletKey = typeof wallet === "string" ? new PublicKey(wallet) : wallet;
    const cashInBN = BN.isBN(cashIn) ? cashIn : new BN(cashIn.toString());
    const minTokenOutBN = BN.isBN(minTokenOut) ? minTokenOut : new BN(minTokenOut.toString());

    return buildBuyTransaction(this.connection, this.program, market, walletKey, cashInBN, minTokenOutBN);
  }

  // ─── Build Sell Transaction ─────────────────────────────────────────────

  async buildSellTransaction(
    marketOrAddress: MarketData | string | PublicKey,
    wallet: string | PublicKey,
    tokenIn: number | bigint | BN,
    minCashOut: number | bigint | BN,
  ): Promise<VersionedTransaction> {
    const market =
      typeof marketOrAddress === "object" && "address" in marketOrAddress
        ? marketOrAddress
        : await this.getMarket(marketOrAddress);

    const walletKey = typeof wallet === "string" ? new PublicKey(wallet) : wallet;
    const tokenInBN = BN.isBN(tokenIn) ? tokenIn : new BN(tokenIn.toString());
    const minCashOutBN = BN.isBN(minCashOut) ? minCashOut : new BN(minCashOut.toString());

    return buildSellTransaction(this.connection, this.program, market, walletKey, tokenInBN, minCashOutBN);
  }
}

// Re-exports
export { MarketData, QuoteResult } from "./types";
export { PDA } from "./pda";
export * from "./constants";
export { calculatePrice, calculateTokensFromCash, calculateCashFromTokens } from "./quote";
