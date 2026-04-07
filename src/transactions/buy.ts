import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { MarketData } from "../types";
import { PDA } from "../pda";
import {
  MAYFLOWER_PROGRAM_ID,
  MAYFLOWER_TENANT,
  RISE_TENANT,
  RISE_TENANT_SEED,
  NATIVE_MINT,
  COMPUTE_UNIT_LIMIT,
  COMPUTE_UNIT_PRICE,
} from "../constants";
import { serializeDecimal } from "../utils";

export async function buildBuyTransaction(
  connection: Connection,
  program: anchor.Program,
  market: MarketData,
  buyer: PublicKey,
  cashIn: BN,
  minTokenOut: BN,
): Promise<VersionedTransaction> {
  const instructions = [];

  const mintToken = market.mintToken;
  const mintMain = market.mintMain;
  const isWSOL = mintMain.equals(NATIVE_MINT);

  // Buyer's ATAs
  const mainSrc = getAssociatedTokenAddressSync(mintMain, buyer, false, TOKEN_PROGRAM_ID);
  const tokenDst = getAssociatedTokenAddressSync(mintToken, buyer, false, TOKEN_PROGRAM_ID);

  // WSOL handling: wrap SOL before buy
  if (isWSOL) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(buyer, mainSrc, buyer, NATIVE_MINT, TOKEN_PROGRAM_ID),
    );
    instructions.push(
      SystemProgram.transfer({ fromPubkey: buyer, toPubkey: mainSrc, lamports: BigInt(cashIn.toString()) }),
    );
    instructions.push(createSyncNativeInstruction(mainSrc));
  }

  // Create token destination ATA
  instructions.push(
    createAssociatedTokenAccountIdempotentInstruction(buyer, tokenDst, buyer, mintToken, TOKEN_PROGRAM_ID),
  );

  // Derive PDAs
  const marketMeta = market.marketMeta;
  const mayflowerMarket = PDA.marketLinear(marketMeta);
  const liqVaultMain = PDA.liqVaultMain(marketMeta);
  const revEscrowGroup = PDA.revEscrowGroup(marketMeta);
  const revEscrowTenant = PDA.revEscrowTenant(marketMeta);
  const mayLogAccount = PDA.logAccount();
  const creatorEscrow = PDA.creatorEscrow(market.address);
  const teamEscrow = PDA.teamEscrow(mintMain);

  // Floor raise params (disabled — pass zeros)
  const newShoulderEnd = new BN(0);
  const floorIncreaseRatio = serializeDecimal(0);
  const maxNewFloor = serializeDecimal(0);
  const maxAreaShrinkageTolerance = new BN(100_000_000);
  const minLiqRatio = serializeDecimal(0);

  // Build buy instruction
  const buyIx = await program.methods
    .buyWithExactCashIn(
      cashIn,
      minTokenOut,
      newShoulderEnd,
      floorIncreaseRatio,
      maxNewFloor,
      maxAreaShrinkageTolerance,
      minLiqRatio,
    )
    .accounts({
      buyer,
      tenant: RISE_TENANT,
      market: market.address,
      cashEscrow: market.cashEscrow,
      creatorEscrow,
      mayTenant: MAYFLOWER_TENANT,
      mayMarketGroup: market.marketGroup,
      marketMeta,
      mayMarket: mayflowerMarket,
      tenantSeed: RISE_TENANT_SEED,
      mintToken,
      mintMain,
      tokenDst,
      mainSrc,
      liqVaultMain,
      revEscrowGroup,
      revEscrowTenant,
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenProgramMain: TOKEN_PROGRAM_ID,
      mayLogAccount,
      mayflowerProgram: MAYFLOWER_PROGRAM_ID,
      teamEscrow,
    })
    .instruction();

  instructions.push(buyIx);

  // Build versioned transaction
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const messageV0 = new TransactionMessage({
    payerKey: buyer,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE }),
      ...instructions,
    ],
  }).compileToV0Message();

  return new VersionedTransaction(messageV0);
}
