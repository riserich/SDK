// Market-level quoting: bridges a decoded Market account into the bit-exact
// curve mirror. Fee parameters are read straight off the account — one fetch
// is all a quote ever needs.
import {
  V2CurveState,
  CURVE_KIND_LINEAR,
  SELF_HEALING_FLAG,
  quoteBuy as quoteBuyState,
  quoteSell as quoteSellState,
  spotPriceQ64,
  BuyQuote,
  SellQuote,
  SellLedgers,
} from "./math";
import { RiseProMarketAccount } from "./deserialize";

/** Decoded Market account → the curve state the mirror evaluates. */
export function curveStateFromMarket(m: RiseProMarketAccount): V2CurveState {
  return {
    curveKind: m.curveKind,
    charParams: m.charParams,
    floor: m.floorPrice,
    rampStartX: m.rampStartX,
    rampScalar: m.rampScalar,
    x2: m.x2Cached,
    mX1: m.mX1Cached,
    tokenSupply: m.tokenSupply,
    hingeX: m.curveKind === CURVE_KIND_LINEAR ? m.hingeX : m.hingeX,
    yShift: m.yShift,
    selfHealing: (m.flags & SELF_HEALING_FLAG) !== 0,
  };
}

/** Spot price in Q64.64 (collateral-raw per token-raw). */
export function spotPrice(m: RiseProMarketAccount): bigint {
  return spotPriceQ64(curveStateFromMarket(m));
}

/** Spot price as a float in whole collateral units per whole token.
 *  Valid because v2 enforces tokenDecimals == collateralDecimals. */
export function spotPriceNumber(m: RiseProMarketAccount): number {
  return Number(spotPrice(m)) / 2 ** 64;
}

/** Quote an exact-cash-in buy. `cashIn` in raw collateral units. */
export function quoteBuy(m: RiseProMarketAccount, cashIn: bigint): BuyQuote {
  return quoteBuyState(
    curveStateFromMarket(m),
    cashIn,
    BigInt(m.buyFeeMbps),
    BigInt(m.feesCreator),
    BigInt(m.feesTeam),
    BigInt(m.reflectionBps),
    { floorReserve: m.floorReserve, totalDebt: m.totalDebt, debtFromPrice: m.debtFromPrice },
  );
}

/** Quote an exact-token-in sell. The Law-1 exit clamp is applied using the
 *  market's own ledgers, exactly like sell.rs. */
export function quoteSell(m: RiseProMarketAccount, tokenIn: bigint): SellQuote {
  const ledgers: SellLedgers = {
    floorReserve: m.floorReserve,
    priceReserve: m.priceReserve,
    totalDebt: m.totalDebt,
  };
  return quoteSellState(
    curveStateFromMarket(m),
    tokenIn,
    BigInt(m.sellFeeMbps),
    BigInt(m.feesCreator),
    BigInt(m.feesTeam),
    ledgers,
    BigInt(m.reflectionBps),
  );
}
