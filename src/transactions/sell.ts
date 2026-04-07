import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { MarketData } from "../types";
import { PDA } from "../pda";
import {
  MAYFLOWER_PROGRAM_ID,
  MAYFLOWER_TENANT,
  RISE_TENANT,
  NATIVE_MINT,
  COMPUTE_UNIT_LIMIT,
  COMPUTE_UNIT_PRICE,
} from "../constants";

export async function buildSellTransaction(
  connection: Connection,
  program: anchor.Program,
  market: MarketData,
  seller: PublicKey,
  tokenIn: BN,
  minCashOut: BN,
): Promise<VersionedTransaction> {
  const instructions = [];

  const mintToken = market.mintToken;
  const mintMain = market.mintMain;
  const isWSOL = mintMain.equals(NATIVE_MINT);

  // Seller's ATAs
  const tokenSrc = getAssociatedTokenAddressSync(mintToken, seller, false, TOKEN_PROGRAM_ID);
  const mainDst = getAssociatedTokenAddressSync(mintMain, seller, false, TOKEN_PROGRAM_ID);

  // Create ATAs (idempotent)
  instructions.push(
    createAssociatedTokenAccountIdempotentInstruction(seller, mainDst, seller, mintMain, TOKEN_PROGRAM_ID),
  );
  instructions.push(
    createAssociatedTokenAccountIdempotentInstruction(seller, tokenSrc, seller, mintToken, TOKEN_PROGRAM_ID),
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

  // Build sell instruction
  const sellIx = await program.methods
    .sellWithExactTokenIn(tokenIn, minCashOut)
    .accounts({
      seller,
      tenant: RISE_TENANT,
      market: market.address,
      cashEscrow: market.cashEscrow,
      creatorEscrow,
      mayTenant: MAYFLOWER_TENANT,
      mayMarketGroup: market.marketGroup,
      marketMeta,
      mayMarket: mayflowerMarket,
      mintToken,
      mintMain,
      tokenSrc,
      mainDst,
      liqVaultMain,
      revEscrowGroup,
      revEscrowTenant,
      tokenProgramMain: TOKEN_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      mayLogAccount,
      mayflowerProgram: MAYFLOWER_PROGRAM_ID,
      teamEscrow,
    })
    .instruction();

  instructions.push(sellIx);

  // WSOL: unwrap after sell
  if (isWSOL) {
    instructions.push(createCloseAccountInstruction(mainDst, seller, seller, []));
  }

  // Build versioned transaction
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const messageV0 = new TransactionMessage({
    payerKey: seller,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE }),
      ...instructions,
    ],
  }).compileToV0Message();

  return new VersionedTransaction(messageV0);
}
