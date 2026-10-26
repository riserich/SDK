// Manual decoder for the on-chain Rise Pro `Market` account (v2 layout).
//
// Used by RECONCILIATION paths only (the v2 cron's drift check, one-shot
// backfills) — the indexer itself never reads accounts, it is event-sourced.
// Field order mirrors idl/rise_pro.json types.Market exactly.

import { PublicKey } from "@solana/web3.js";

// Position account layout (IDL `Position`): disc(8) | bump u8 | market pk |
// owner pk | collateral u64 | debt u64 | reserved.
export interface RiseProPositionAccount {
  bump: number;
  market: PublicKey;
  owner: PublicKey;
  collateral: bigint;
  debt: bigint;
}

export function decodeRiseProPosition(data: Buffer): RiseProPositionAccount | null {
  if (data.length < 8 + 1 + 32 + 32 + 8 + 8) return null;
  let o = 8;
  const bump = data.readUInt8(o); o += 1;
  const market = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const owner = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const collateral = data.readBigUInt64LE(o); o += 8;
  const debt = data.readBigUInt64LE(o);
  return { bump, market, owner, collateral, debt };
}

export const RISE_PRO_MARKET_DISC = Buffer.from([
  219, 190, 213, 55, 0, 227, 198, 154,
]);

class R {
  private o = 0;
  constructor(private b: Buffer) {}
  u8() { return this.b.readUInt8(this.o++); }
  u16() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  private uint(n: number): bigint {
    let v = 0n;
    for (let i = 0; i < n; i++) v |= BigInt(this.b[this.o + i]) << (8n * BigInt(i));
    this.o += n;
    return v;
  }
  u64() { return this.uint(8); }
  u128() { return this.uint(16); }
  i64() { const u = this.uint(8); return u >= 1n << 63n ? u - (1n << 64n) : u; }
  i128() { const u = this.uint(16); return u >= 1n << 127n ? u - (1n << 128n) : u; }
  pk() { const v = new PublicKey(this.b.subarray(this.o, this.o + 32)); this.o += 32; return v.toBase58(); }
  skip(n: number) { this.o += n; }
}

export interface RiseProMarketAccount {
  curveKind: number;
  tokenDecimals: number;
  flags: number;
  creator: string;
  mintToken: string;
  mintMain: string;
  feeConfigVersion: number;
  buyFeeMbps: number;
  sellFeeMbps: number;
  borrowFeeMbps: number;
  feesTeam: number;
  feesCreator: number;
  feesFloor: number;
  qMaxBps: number;
  charParams: [bigint, bigint, bigint, bigint];
  floorPrice: bigint;
  rampStartX: bigint;
  rampScalar: bigint;
  x2Cached: bigint;
  mX1Cached: bigint;
  yShift: bigint;
  tokenSupply: bigint;
  floorReserve: bigint;
  priceReserve: bigint;
  totalDebt: bigint;
  totalCollateral: bigint;
  totalFeesFloor: bigint;
  totalFeesCreator: bigint;
  totalFeesTeam: bigint;
  cumNetInflow: bigint;
  g0Mbps: number;
  gMinMbps: number;
  glideEndInflow: bigint;
  maxFloorStepBps: number;
  lastFloorRaiseTs: bigint;
  stateSeq: bigint;
  hingeX: bigint;
  reflectionBps: number;
  /** Part of totalDebt drawn from the price reserve (excluded from floor backing). */
  debtFromPrice: bigint;
  /** Self-healing descent reference shift (Q64.64) and low-water mark / locked credit. */
  yRef: bigint;
  healLowX: bigint;
  healLocked: bigint;
  // Reflexive fast-raise window + raise bookkeeping (crank inputs)
  peakPrice: bigint; // u128 Q64.64
  peakSlot: bigint; // u64
  reflexiveArmRatioMbps: number; // u32
  reflexiveBandMbps: number; // u32
  reflexiveStepBps: number; // u16
  lastRaiseSlot: bigint; // u64
  minRampHeadroomX: bigint; // u64
}

/** Decode a raw Market account (including the 8-byte discriminator). */
// Minimum body size: sum of all fixed-width fields up to state_seq (the
// reserved tail may grow). A short buffer returns null instead of throwing.
const MIN_BODY_LEN = 700;

export function decodeRiseProMarket(data: Buffer): RiseProMarketAccount | null {
  if (data.length < 8 + MIN_BODY_LEN) return null;
  if (!data.subarray(0, 8).equals(RISE_PRO_MARKET_DISC)) {
    return null;
  }
  const r = new R(data.subarray(8));
  r.u8(); // bump
  r.u8(); // version
  const curveKind = r.u8();
  const tokenDecimals = r.u8();
  const flags = r.u16();
  const creator = r.pk();
  const mintToken = r.pk();
  const mintMain = r.pk();
  r.pk(); r.pk(); r.pk(); r.pk(); // token_program_main, vault, collateral_vault, creator_claim
  r.skip(3); // vault_bumps
  const feeConfigVersion = r.u32();
  const buyFeeMbps = r.u32();
  const sellFeeMbps = r.u32();
  const borrowFeeMbps = r.u32();
  r.u32(); // redeem_fee_mbps
  const feesTeam = r.u16();
  const feesCreator = r.u16();
  const feesFloor = r.u16();
  r.u64(); // min_trade_amount
  const qMaxBps = r.u16();
  const charParams: [bigint, bigint, bigint, bigint] = [
    r.i128(), r.i128(), r.i128(), r.i128(),
  ];
  const floorPrice = r.u128();
  const rampStartX = r.u64();
  const rampScalar = r.u128();
  const x2Cached = r.u64();
  const mX1Cached = r.u128();
  const yShift = r.i128();
  const tokenSupply = r.u64();
  const floorReserve = r.u64();
  const priceReserve = r.u64();
  const totalDebt = r.u64();
  const totalCollateral = r.u64();
  const totalFeesFloor = r.u64();
  const totalFeesCreator = r.u64();
  const totalFeesTeam = r.u64();
  const cumNetInflow = r.u128();
  const g0Mbps = r.u32();
  const gMinMbps = r.u32();
  const glideEndInflow = r.u128();
  const peakPrice = r.u128();
  const peakSlot = r.u64();
  const reflexiveArmRatioMbps = r.u32();
  const reflexiveBandMbps = r.u32();
  const reflexiveStepBps = r.u16();
  r.u128(); // starting_price
  const lastFloorRaiseTs = r.i64();
  r.u32(); // floor_raise_count
  const lastRaiseSlot = r.u64();
  const maxFloorStepBps = r.u16();
  const minRampHeadroomX = r.u64();
  r.u128(); // area_under_curve
  const stateSeq = r.u64();
  const hingeX = r.u64();
  const reflectionBps = r.u16(); // carved from the front of `reserved` (88 → 86)
  const debtFromPrice = r.u64();
  const yRef = r.i128();
  const healLowX = r.u64();
  const healLocked = r.u64();

  return {
    hingeX,
    reflectionBps,
    debtFromPrice,
    yRef,
    healLowX,
    healLocked,
    curveKind, tokenDecimals, flags, creator, mintToken, mintMain,
    feeConfigVersion, buyFeeMbps, sellFeeMbps, borrowFeeMbps,
    feesTeam, feesCreator, feesFloor, qMaxBps, charParams,
    floorPrice, rampStartX, rampScalar, x2Cached, mX1Cached, yShift,
    tokenSupply, floorReserve, priceReserve, totalDebt, totalCollateral,
    totalFeesFloor, totalFeesCreator, totalFeesTeam, cumNetInflow,
    g0Mbps, gMinMbps, glideEndInflow, maxFloorStepBps, lastFloorRaiseTs,
    stateSeq,
    peakPrice, peakSlot, reflexiveArmRatioMbps, reflexiveBandMbps,
    reflexiveStepBps, lastRaiseSlot, minRampHeadroomX,
  };
}
