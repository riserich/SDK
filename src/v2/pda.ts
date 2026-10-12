// Rise Pro (v2) PDAs. Every helper takes an optional program id override.
import { PublicKey } from "@solana/web3.js";
import { v2ProgramId } from "./constants";

const seed = (s: string) => Buffer.from(s);

export const marketPda = (mintToken: PublicKey, pid: PublicKey = v2ProgramId()) =>
  PublicKey.findProgramAddressSync([seed("market"), mintToken.toBuffer()], pid)[0];
export const vaultPda = (market: PublicKey, pid: PublicKey = v2ProgramId()) =>
  PublicKey.findProgramAddressSync([seed("vault"), market.toBuffer()], pid)[0];
export const collateralVaultPda = (market: PublicKey, pid: PublicKey = v2ProgramId()) =>
  PublicKey.findProgramAddressSync([seed("collateral_vault"), market.toBuffer()], pid)[0];
export const creatorClaimPda = (market: PublicKey, pid: PublicKey = v2ProgramId()) =>
  PublicKey.findProgramAddressSync([seed("creator_claim"), market.toBuffer()], pid)[0];
export const positionPda = (market: PublicKey, owner: PublicKey, pid: PublicKey = v2ProgramId()) =>
  PublicKey.findProgramAddressSync([seed("position"), market.toBuffer(), owner.toBuffer()], pid)[0];
export const reflectionVaultPda = (market: PublicKey, pid: PublicKey = v2ProgramId()) =>
  PublicKey.findProgramAddressSync([seed("reflection_vault"), market.toBuffer()], pid)[0];
export const teamVaultPda = (mintMain: PublicKey, pid: PublicKey = v2ProgramId()) =>
  PublicKey.findProgramAddressSync([seed("team_vault"), mintMain.toBuffer()], pid)[0];
export const eventAuthorityPda = (pid: PublicKey = v2ProgramId()) =>
  PublicKey.findProgramAddressSync([seed("__event_authority")], pid)[0];

export const PDA_V2 = {
  market: marketPda,
  vault: vaultPda,
  collateralVault: collateralVaultPda,
  creatorClaim: creatorClaimPda,
  position: positionPda,
  reflectionVault: reflectionVaultPda,
  teamVault: teamVaultPda,
  eventAuthority: eventAuthorityPda,
};
