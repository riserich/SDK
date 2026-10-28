// Rise Pro (v2) SDK — anchor-free: hand-assembled instructions mirroring the
// Rise backend's production builders (account orders proven by devnet
// simulation), plus a bit-exact off-chain quote oracle.
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  DEFAULT_V2_PROGRAM_ID,
  DEVNET_V2_PROGRAM_ID,
  setV2ProgramId,
  v2ProgramId,
  V2_COMPUTE_UNIT_LIMIT,
  V2_COMPUTE_UNIT_PRICE,
} from "./constants";
import { marketPda, positionPda, PDA_V2 } from "./pda";
import {
  decodeRiseProMarket,
  decodeRiseProPosition,
  RiseProMarketAccount,
  RiseProPositionAccount,
} from "./deserialize";
import { quoteBuy, quoteSell, spotPrice, spotPriceNumber } from "./quote";
import {
  buildBuy,
  buildSell,
  buildDeposit,
  buildWithdraw,
  buildBorrow,
  buildRepay,
  buildLeverageBuy,
  buildLeverageSell,
  buildClaimCreatorFees,
} from "./transactions/builders";

export * from "./constants";
export * from "./pda";
export * from "./deserialize";
export * from "./math";
export {
  curveStateFromMarket,
  spotPrice,
  spotPriceNumber,
  quoteBuy as quoteBuyMarket,
  quoteSell as quoteSellMarket,
} from "./quote";
export * from "./transactions";

export interface RiseProSDKConfig {
  connection?: Connection;
  rpcUrl?: string;
  programId?: PublicKey;
  computeUnitLimit?: number;
  computeUnitPrice?: number;
}

export interface MarketV2 extends RiseProMarketAccount {
  /** The market PDA address. */
  address: PublicKey;
  /** `mintToken` / `mintMain` as PublicKeys (the decoder stores base58 strings). */
  mintTokenPk: PublicKey;
  mintMainPk: PublicKey;
  /** Token program owning `mintMain` (SPL Token or Token-2022), read from the market account. */
  tokenProgramMainPk: PublicKey;
  version: 2;
}

type Amount = bigint | number | string;
const toBig = (v: Amount): bigint => BigInt(typeof v === "number" ? Math.trunc(v) : v.toString());

export class RiseProSDK {
  readonly connection: Connection;
  private readonly cuLimit: number;
  private readonly cuPrice: number;

  constructor(cfg: RiseProSDKConfig = {}) {
    if (cfg.connection) this.connection = cfg.connection;
    else if (cfg.rpcUrl) this.connection = new Connection(cfg.rpcUrl, "confirmed");
    else throw new Error("RiseProSDK: connection or rpcUrl required");
    if (cfg.programId) setV2ProgramId(cfg.programId);
    this.cuLimit = cfg.computeUnitLimit ?? V2_COMPUTE_UNIT_LIMIT;
    this.cuPrice = cfg.computeUnitPrice ?? V2_COMPUTE_UNIT_PRICE;
  }

  /** Resolve + decode a market from its mint OR its market address.
   *  One getAccountInfo when given the market address; two when given a mint
   *  that is not a market (PDA derivation is free). */
  async getMarket(mintOrMarket: PublicKey): Promise<MarketV2> {
    // Try as market address first.
    let address = mintOrMarket;
    let info = await this.connection.getAccountInfo(address);
    let decoded = info ? decodeRiseProMarket(info.data) : null;
    if (!decoded) {
      // Treat input as the token mint: market is a pure derivation.
      address = marketPda(mintOrMarket);
      info = await this.connection.getAccountInfo(address);
      decoded = info ? decodeRiseProMarket(info.data) : null;
    }
    if (!decoded) throw new Error(`RiseProSDK: no v2 market found for ${mintOrMarket.toBase58()}`);
    return {
      ...decoded,
      address,
      mintTokenPk: new PublicKey(decoded.mintToken),
      mintMainPk: new PublicKey(decoded.mintMain),
      tokenProgramMainPk: new PublicKey(decoded.tokenProgramMain),
      version: 2,
    };
  }

  /** Lending/leverage position; zeros when the account does not exist. */
  async getPosition(
    market: PublicKey,
    owner: PublicKey,
  ): Promise<RiseProPositionAccount> {
    const info = await this.connection.getAccountInfo(positionPda(market, owner));
    const decoded = info ? decodeRiseProPosition(info.data) : null;
    return (
      decoded ?? { bump: 0, market, owner, collateral: 0n, debt: 0n }
    );
  }

  quoteBuy(market: MarketV2, cashIn: Amount) {
    return quoteBuy(market, toBig(cashIn));
  }
  quoteSell(market: MarketV2, tokenIn: Amount) {
    return quoteSell(market, toBig(tokenIn));
  }
  spotPrice(market: MarketV2): bigint {
    return spotPrice(market);
  }
  spotPriceNumber(market: MarketV2): number {
    return spotPriceNumber(market);
  }

  private async compile(
    payer: PublicKey,
    ixs: TransactionInstruction[],
  ): Promise<VersionedTransaction> {
    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: this.cuLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.cuPrice }),
        ...ixs,
      ],
    }).compileToV0Message();
    return new VersionedTransaction(msg);
  }

  async buildBuyTransaction(
    market: MarketV2,
    wallet: PublicKey,
    cashIn: Amount,
    minTokenOut: Amount = 0n,
  ): Promise<VersionedTransaction> {
    const { ixs } = buildBuy(
      wallet, market.address, market.mintTokenPk, market.mintMainPk,
      toBig(cashIn).toString(), toBig(minTokenOut).toString(), market.tokenProgramMainPk,
    );
    return this.compile(wallet, ixs);
  }

  async buildSellTransaction(
    market: MarketV2,
    wallet: PublicKey,
    tokenIn: Amount,
    minCashOut: Amount = 0n,
  ): Promise<VersionedTransaction> {
    const { ixs } = buildSell(
      wallet, market.address, market.mintTokenPk, market.mintMainPk,
      toBig(tokenIn).toString(), toBig(minCashOut).toString(), market.tokenProgramMainPk,
    );
    return this.compile(wallet, ixs);
  }

  async buildDepositTransaction(
    market: MarketV2,
    wallet: PublicKey,
    amount: Amount,
  ): Promise<VersionedTransaction> {
    const { ix } = buildDeposit(wallet, market.address, market.mintTokenPk, toBig(amount).toString());
    return this.compile(wallet, [ix]);
  }

  async buildWithdrawTransaction(
    market: MarketV2,
    wallet: PublicKey,
    amount: Amount,
  ): Promise<VersionedTransaction> {
    const { ix } = buildWithdraw(wallet, market.address, market.mintTokenPk, toBig(amount).toString());
    return this.compile(wallet, [ix]);
  }

  async buildBorrowTransaction(
    market: MarketV2,
    wallet: PublicKey,
    amount: Amount,
  ): Promise<VersionedTransaction> {
    const { ixs } = buildBorrow(wallet, market.address, market.mintMainPk, toBig(amount).toString(), market.tokenProgramMainPk);
    return this.compile(wallet, ixs);
  }

  async buildRepayTransaction(
    market: MarketV2,
    wallet: PublicKey,
    amount: Amount,
  ): Promise<VersionedTransaction> {
    const { ixs } = buildRepay(wallet, market.address, market.mintMainPk, toBig(amount).toString(), market.tokenProgramMainPk);
    return this.compile(wallet, ixs);
  }

  async buildLeverageBuyTransaction(
    market: MarketV2,
    wallet: PublicKey,
    cashIn: Amount,
    borrowAmount: Amount,
    minTokenOut: Amount = 0n,
  ): Promise<VersionedTransaction> {
    const { ixs } = buildLeverageBuy(
      wallet, market.address, market.mintTokenPk, market.mintMainPk,
      toBig(cashIn).toString(), toBig(borrowAmount).toString(), toBig(minTokenOut).toString(),
      market.tokenProgramMainPk,
    );
    return this.compile(wallet, ixs);
  }

  async buildLeverageSellTransaction(
    market: MarketV2,
    wallet: PublicKey,
    collateralIn: Amount,
    decreaseDebtBy: Amount,
    minCashOut: Amount = 0n,
  ): Promise<VersionedTransaction> {
    const { ixs } = buildLeverageSell(
      wallet, market.address, market.mintTokenPk, market.mintMainPk,
      toBig(collateralIn).toString(), toBig(decreaseDebtBy).toString(), toBig(minCashOut).toString(),
      market.tokenProgramMainPk,
    );
    return this.compile(wallet, ixs);
  }

  async buildClaimCreatorFeesTransaction(
    market: MarketV2,
    creator: PublicKey,
  ): Promise<VersionedTransaction> {
    const { ixs } = buildClaimCreatorFees(creator, market.address, market.mintMainPk, market.tokenProgramMainPk);
    return this.compile(creator, ixs);
  }
}

export { DEFAULT_V2_PROGRAM_ID, DEVNET_V2_PROGRAM_ID, v2ProgramId, setV2ProgramId, PDA_V2 };
