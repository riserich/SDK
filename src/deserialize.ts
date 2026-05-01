import { PublicKey } from "@solana/web3.js";
// @ts-ignore
import { RustDecimal } from "@nvana-dharma/rust-decimal";

function readDecimal(buffer: Buffer, offset: number): number {
  const bytes = Array.from(buffer.subarray(offset, offset + 16));
  const rustDecimal = RustDecimal.deserializeFromAnchorized(bytes);
  return rustDecimal.toFloat();
}

function readU64(buffer: Buffer, offset: number): bigint {
  return buffer.readBigUInt64LE(offset);
}

function readU128(buffer: Buffer, offset: number): bigint {
  const low = buffer.readBigUInt64LE(offset);
  const high = buffer.readBigUInt64LE(offset + 8);
  return low + (high << 64n);
}

function readPubkey(buffer: Buffer, offset: number): PublicKey {
  return new PublicKey(buffer.subarray(offset, offset + 32));
}

// ─── Rise Market Account ────────────────────────────────────────────────────

export interface RiseMarketRaw {
  tenant: PublicKey;
  marketMeta: PublicKey;
  mintToken: PublicKey;
  mintMain: PublicKey;
  tokenDecimals: number;
  cashEscrow: PublicKey;
  buyFeeMicroBasisPoints: number;
  sellFeeMicroBasisPoints: number;
  borrowFeeMicroBasisPoints: number;
  flags: number;
  lastFloorRaiseTimestamp: bigint;
  level: number;
  creator: PublicKey | null;
  totalFeesFloor: bigint;
  totalFeesCreator: bigint;
  totalFeesCreatorWithdrawn: bigint;
  totalFeesTeam: bigint;
  creatorRevPercent: number;
  startingPrice: number;
}

export function deserializeRiseMarket(data: Buffer): RiseMarketRaw {
  // Skip 8-byte Anchor discriminator
  let offset = 8;

  const tenant = readPubkey(data, offset); offset += 32;
  const marketMeta = readPubkey(data, offset); offset += 32;
  const mintToken = readPubkey(data, offset); offset += 32;
  const mintMain = readPubkey(data, offset); offset += 32;
  const tokenDecimals = data.readUInt8(offset); offset += 1;
  const cashEscrow = readPubkey(data, offset); offset += 32;

  // GlobalBallotItem = u32 value | u32 min | u32 max | u32 step | u64 totalVotesUp | u64 totalVotesDown = 32 bytes
  const buyFeeMicroBasisPoints = data.readUInt32LE(offset); offset += 32;
  const sellFeeMicroBasisPoints = data.readUInt32LE(offset); offset += 32;
  const borrowFeeMicroBasisPoints = data.readUInt32LE(offset); offset += 32;
  offset += 32; // floorRaiseCooldownSeconds (GlobalBallotItem)
  offset += 32; // floorRaiseLiquidityBufferMicroBasisPoints (GlobalBallotItem)
  offset += 32; // floorInvestmentMicroBasisPoints (GlobalBallotItem)
  // SimpleGlobalBallotItem = u64 totalVotesUp | u64 totalVotesDown = 16 bytes
  offset += 16; // priceCurveSensitivity
  offset += 4;  // priceCurveSensitivityChangeRateMicroBasisPoints (u32)

  // bump: [u8; 1]
  offset += 1;

  // lastFloorRaiseTimestamp: u64
  const lastFloorRaiseTimestamp = readU64(data, offset); offset += 8;

  // level: u32
  const level = data.readUInt32LE(offset); offset += 4;

  // levelRevCalculator: { yIntercept: f64, maxAsymptote: f64, k: f64 } = 24 bytes
  offset += 24;

  // flags: u16
  const flags = data.readUInt16LE(offset); offset += 2;

  // creator: PublicKey (may not exist in old markets)
  let creator: PublicKey | null = null;
  if (offset + 32 <= data.length) {
    creator = readPubkey(data, offset); offset += 32;
  }

  // totalFeesFloor: u64
  let totalFeesFloor = 0n;
  let totalFeesCreator = 0n;
  let totalFeesCreatorWithdrawn = 0n;
  let totalFeesTeam = 0n;
  let creatorRevPercent = 0;
  let startingPrice = 0;

  if (offset + 8 <= data.length) {
    totalFeesFloor = readU64(data, offset); offset += 8;
  }
  if (offset + 8 <= data.length) {
    totalFeesCreator = readU64(data, offset); offset += 8;
  }
  if (offset + 8 <= data.length) {
    totalFeesCreatorWithdrawn = readU64(data, offset); offset += 8;
  }
  if (offset + 8 <= data.length) {
    totalFeesTeam = readU64(data, offset); offset += 8;
  }
  if (offset + 1 <= data.length) {
    creatorRevPercent = data.readUInt8(offset); offset += 1;
  }
  if (offset + 16 <= data.length) {
    startingPrice = readDecimal(data, offset); offset += 16;
  }

  return {
    tenant, marketMeta, mintToken, mintMain, tokenDecimals, cashEscrow,
    buyFeeMicroBasisPoints, sellFeeMicroBasisPoints, borrowFeeMicroBasisPoints,
    flags, lastFloorRaiseTimestamp, level, creator,
    totalFeesFloor, totalFeesCreator, totalFeesCreatorWithdrawn, totalFeesTeam,
    creatorRevPercent, startingPrice,
  };
}

// ─── Mayflower MarketLinear Account ─────────────────────────────────────────

export interface MarketLinearRaw {
  marketMeta: PublicKey;
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
}

export function deserializeMarketLinear(data: Buffer): MarketLinearRaw {
  let offset = 8; // Skip discriminator

  const marketMeta = readPubkey(data, offset); offset += 32;
  const tokenSupply = readU64(data, offset); offset += 8;
  const totalCashLiquidity = readU64(data, offset); offset += 8;
  const totalDebt = readU64(data, offset); offset += 8;
  const totalCollateral = readU64(data, offset); offset += 8;
  const cumulativeRevenueMarket = readU128(data, offset); offset += 16;
  const cumulativeRevenueTenant = readU128(data, offset); offset += 16;
  const floor = readDecimal(data, offset); offset += 16;
  const m1 = readDecimal(data, offset); offset += 16;
  const m2 = readDecimal(data, offset); offset += 16;
  const x2 = readU64(data, offset); offset += 8;
  const b2 = readDecimal(data, offset); offset += 16;

  // b1 = (m2 - m1) * x2 + b2
  const x2Num = Number(x2);
  const b1 = (m2 - m1) * x2Num + b2;

  return {
    marketMeta, tokenSupply, totalCashLiquidity, totalDebt, totalCollateral,
    cumulativeRevenueMarket, cumulativeRevenueTenant,
    floor, m1, m2, x2, b2, b1,
  };
}

// ─── Mayflower MarketMeta Account ───────────────────────────────────────────

export interface MarketMetaRaw {
  mintMain: PublicKey;
  mintToken: PublicKey;
  mintOptions: PublicKey;
  marketGroup: PublicKey;
  market: PublicKey;
  tokenProgramMain: PublicKey;
  liqVaultMain: PublicKey;
  revEscrowGroup: PublicKey;
  revEscrowTenant: PublicKey;
  seed: PublicKey;
  bump: number;
  decimals: number;
  tokenUnitScale: number;
}

export function deserializeMarketMeta(data: Buffer): MarketMetaRaw {
  let offset = 8; // Skip discriminator

  const mintMain = readPubkey(data, offset); offset += 32;
  const mintToken = readPubkey(data, offset); offset += 32;
  const mintOptions = readPubkey(data, offset); offset += 32;
  const marketGroup = readPubkey(data, offset); offset += 32;
  const market = readPubkey(data, offset); offset += 32;
  const tokenProgramMain = readPubkey(data, offset); offset += 32;
  const liqVaultMain = readPubkey(data, offset); offset += 32;
  const revEscrowGroup = readPubkey(data, offset); offset += 32;
  const revEscrowTenant = readPubkey(data, offset); offset += 32;

  // PdaMeta: { bump: [u8; 1], seed: PublicKey }
  const bump = data.readUInt8(offset); offset += 1;
  const seed = readPubkey(data, offset); offset += 32;

  const decimals = data.readUInt8(offset); offset += 1;

  // permissions: u16 (bitfield)
  offset += 2;

  // startTime: u64
  offset += 8;

  // dutchConfig: { initBoost: f64, duration: u32, curvature: f64 } = 20 bytes
  offset += 20;

  // tokenUnitScale: i8
  const tokenUnitScale = data.readInt8(offset); offset += 1;

  return {
    mintMain, mintToken, mintOptions, marketGroup, market,
    tokenProgramMain, liqVaultMain, revEscrowGroup, revEscrowTenant,
    seed, bump, decimals, tokenUnitScale,
  };
}
