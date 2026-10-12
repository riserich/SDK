// Rise Pro (v2) — program id and instruction discriminators.
// The program id is injectable: devnet today, mainnet at launch.
import { PublicKey } from "@solana/web3.js";

export const DEFAULT_V2_PROGRAM_ID = new PublicKey(
  "9nJ9wghEHY8bnsJQYrqV77uC9y4ccFHcCT1XyJxAkBVR", // devnet
);

let programId = DEFAULT_V2_PROGRAM_ID;
/** Override the Rise Pro program id (e.g. at mainnet launch). */
export function setV2ProgramId(pk: PublicKey): void { programId = pk; }
export function v2ProgramId(): PublicKey { return programId; }

export const V2_COMPUTE_UNIT_LIMIT = 300_000; // expo buys measured <= 240k CU
export const V2_COMPUTE_UNIT_PRICE = 50_000; // micro-lamports

// sha256("global:<name>")[..8] — copied from the backend's verified table.
export const DISC = {
  buy: Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]),
  sell: Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]),
  deposit: Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]),
  borrow: Buffer.from([228, 253, 131, 202, 207, 116, 89, 18]),
  repay: Buffer.from([234, 103, 67, 82, 208, 234, 219, 166]),
  withdraw: Buffer.from([183, 18, 70, 156, 148, 109, 161, 34]),
  leverage_buy: Buffer.from([113, 153, 55, 91, 207, 24, 175, 171]),
  leverage_sell: Buffer.from([158, 249, 120, 75, 3, 70, 48, 108]),
  claim_creator_fees: Buffer.from([0, 23, 125, 234, 156, 118, 134, 89]),
};
