// Instruction assembly helpers + SOL<->WSOL legs — ported from the backend
// (uponly-backend src/utils/rise-pro.ts), account orders verified by on-chain
// simulation. The market token is always Token-2022; collateral ATAs use the
// collateral mint's own token program.
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import { v2ProgramId } from "../constants";
import { eventAuthorityPda } from "../pda";

export const u64le = (n: BN | number | string | bigint) =>
  new BN(n.toString()).toArrayLike(Buffer, "le", 8);
export const u128le = (n: BN | number | string | bigint) =>
  new BN(n.toString()).toArrayLike(Buffer, "le", 16);

export const RW = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
export const RO = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
export const eventCpi = () => [RO(eventAuthorityPda()), RO(v2ProgramId())];

/** The trader's collateral ATA (mint_main). */
export const cashAta = (mintMain: PublicKey, owner: PublicKey, tokenProgramMain: PublicKey) =>
  getAssociatedTokenAddressSync(mintMain, owner, true, tokenProgramMain);
/** The trader's market-token ATA (always Token-2022). */
export const tokenAta = (mintToken: PublicKey, owner: PublicKey) =>
  getAssociatedTokenAddressSync(mintToken, owner, true, TOKEN_2022_PROGRAM_ID);

export function ixOf(keys: any[], data: Buffer) {
  return new TransactionInstruction({ programId: v2ProgramId(), keys, data });
}

/** SOL→WSOL: fund the owner's WSOL ATA with `lamports` before a collateral inflow
 *  (ATA idempotent + transfer + syncNative, exactly the v1 sequence). Empty when
 *  the collateral is not native SOL. */
export function wrapNativeIxs(
  owner: PublicKey,
  mintMain: PublicKey,
  lamports: BN | number | string,
  tokenProgramMain = TOKEN_PROGRAM_ID,
): TransactionInstruction[] {
  if (!mintMain.equals(NATIVE_MINT)) return [];
  const ata = cashAta(mintMain, owner, tokenProgramMain);
  return [
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      ata,
      owner,
      NATIVE_MINT,
      tokenProgramMain,
    ),
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: ata,
      lamports: BigInt(String(lamports)),
    }),
    createSyncNativeInstruction(ata, tokenProgramMain),
  ];
}

/** WSOL→SOL: close the owner's WSOL ATA after a collateral outflow, returning the
 *  full balance as native SOL (v1 parity — any pre-existing WSOL is swept too).
 *  Empty when the collateral is not native SOL. */
export function unwrapNativeIxs(
  owner: PublicKey,
  mintMain: PublicKey,
  tokenProgramMain = TOKEN_PROGRAM_ID,
): TransactionInstruction[] {
  if (!mintMain.equals(NATIVE_MINT)) return [];
  return [
    createCloseAccountInstruction(
      cashAta(mintMain, owner, tokenProgramMain),
      owner,
      owner,
      [],
      tokenProgramMain,
    ),
  ];
}

