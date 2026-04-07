import { PublicKey } from "@solana/web3.js";
import { MAYFLOWER_PROGRAM_ID, RISE_PROGRAM_ID } from "./constants";

function findPDA(seeds: Buffer[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

// Mayflower PDAs
export const PDA = {
  marketLinear: (marketMeta: PublicKey): PublicKey =>
    findPDA([Buffer.from("market_linear"), marketMeta.toBuffer()], MAYFLOWER_PROGRAM_ID),

  liqVaultMain: (marketMeta: PublicKey): PublicKey =>
    findPDA([Buffer.from("liq_vault_main"), marketMeta.toBuffer()], MAYFLOWER_PROGRAM_ID),

  revEscrowGroup: (marketMeta: PublicKey): PublicKey =>
    findPDA([Buffer.from("rev_escrow_group"), marketMeta.toBuffer()], MAYFLOWER_PROGRAM_ID),

  revEscrowTenant: (marketMeta: PublicKey): PublicKey =>
    findPDA([Buffer.from("rev_escrow_tenant"), marketMeta.toBuffer()], MAYFLOWER_PROGRAM_ID),

  personalPosition: (marketMeta: PublicKey, owner: PublicKey): PublicKey =>
    findPDA(
      [Buffer.from("personal_position"), marketMeta.toBuffer(), owner.toBuffer()],
      MAYFLOWER_PROGRAM_ID,
    ),

  personalPositionEscrow: (personalPosition: PublicKey): PublicKey =>
    findPDA([Buffer.from("personal_position_escrow"), personalPosition.toBuffer()], MAYFLOWER_PROGRAM_ID),

  logAccount: (): PublicKey =>
    findPDA([Buffer.from("log")], MAYFLOWER_PROGRAM_ID),

  // Rise PDAs
  creatorEscrow: (riseMarket: PublicKey): PublicKey =>
    findPDA([Buffer.from("creator_escrow"), riseMarket.toBuffer()], RISE_PROGRAM_ID),

  teamEscrow: (mintMain: PublicKey): PublicKey =>
    findPDA([Buffer.from("team_escrow"), mintMain.toBuffer()], RISE_PROGRAM_ID),
};
