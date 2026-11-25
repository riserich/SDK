// Launch-mode markets (market_kind = 1) — exact mirror of the program's launch
// curve (risepro-program instructions/launch/{mod,launch_buy,launch_sell}.rs).
//
// P(x) = P0·e^{k·x}, ×10 over the `sale_cap` tokens sold on the curve, stored as
// a hinge-less hinged exponential `char_params = [P0, P0·k, P0, k]`
// (curve_kind 3). The floor is the average price paid (vault / sold): below
// the supply where the curve crosses it, tokens trade flat at the floor.
// Fills and the band edge invert the curve exactly as on-chain: a fixed-point
// ln, two Newton steps on the exact area / price, then a dust margin checked
// against the exact curve. Same operation order and rounding as the program,
// so a quote computed here equals the transaction result.
//
// The curve is read off the market account (never hard-coded), so the same
// code quotes mainnet and devnet launch markets.
import {
  CurveMathError,
  FeeLegs,
  HingedExponentialCharacteristic,
  ONE_Q64,
  U64_MAX,
  divQ64Wide,
  mulHp,
  mulQ64Wide,
  splitFee,
  BuyQuote,
  SellQuote,
  MBPS_DENOMINATOR,
} from "./math";
import { RiseProMarketAccount } from "./deserialize";
import { CURVE_KIND_LAUNCH_EXP, LAUNCH_PHASE, MARKET_KIND_LAUNCH } from "./constants";

const Q64 = 1n << 64n;
/** round(ln 2 · 2^64) — curve/hinged_exp.rs LN2_Q64. */
const LN2_Q64 = 12786308645202655660n;

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const ceilQ64 = (v: bigint): bigint => (v >> 64n) + ((v & (Q64 - 1n)) !== 0n ? 1n : 0n);
const ceilMulQ64 = (p: bigint, units: bigint): bigint => ceilDiv(p * units, Q64);
const floorMulQ64 = (p: bigint, units: bigint): bigint => (p * units) / Q64;
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
// u64 saturating arithmetic, as the Rust side.
const satAdd = (a: bigint, b: bigint): bigint => min(a + b, U64_MAX);
const satSub = (a: bigint, b: bigint): bigint => (a > b ? a - b : 0n);
const satMul = (a: bigint, b: bigint): bigint => min(a * b, U64_MAX);
const toU64OrMax = (v: bigint): bigint => min(v, U64_MAX);

/** log2(y) Q64.64 for y ≥ 1 (Q64.64) — mod.rs log2_q64: integer part from the
 *  leading bit, 64 fractional bits by squaring the Q1.63 mantissa. */
export function log2Q64(y: bigint): bigint {
  if (y < Q64) throw new CurveMathError("MathOverflow");
  const n = BigInt(y.toString(2).length - 1 - 64);
  let r = y >> (n + 1n); // [2^63, 2^64): Q1.63 in a u64
  let frac = 0n;
  for (let bit = 63n; bit >= 0n; bit--) {
    const sq = (r * r) >> 63n; // [2^63, 2^65)
    if (sq >> 64n !== 0n) {
      frac |= 1n << bit;
      r = sq >> 1n;
    } else {
      r = sq;
    }
  }
  return (n << 64n) | frac;
}

/** mod.rs margin: x / 2^36 + 64, saturating. */
const margin = (x: bigint): bigint => satAdd(x >> 36n, 64n);

export interface LaunchFill {
  /** Tokens filled (raw). */
  t: bigint;
  /** Exact curve cost of the fill, rounded up (raw lamports). */
  cost: bigint;
}

/** The launch curve of one market — `LaunchCurve::of` mirror. */
export class LaunchCurve {
  readonly c: HingedExponentialCharacteristic;

  constructor(
    charParams: readonly bigint[],
    /** `sale_cap`: no token trades past it, so it bounds every search. */
    readonly cap: bigint,
  ) {
    this.c = new HingedExponentialCharacteristic(
      charParams[0], charParams[1], charParams[2], charParams[3], 0n,
    );
  }

  static of(m: RiseProMarketAccount): LaunchCurve {
    if (m.curveKind !== CURVE_KIND_LAUNCH_EXP) throw new CurveMathError("InvalidCurveParams");
    return new LaunchCurve(m.charParams, m.saleCap);
  }

  get p0(): bigint { return this.c.p0; }
  get k(): bigint { return this.c.k; }

  /** Marginal curve price at `sold`, Q64.64 lamports per raw token. */
  price(sold: bigint): bigint { return this.c.price(sold); }

  /** Supply where P0·e^{k·x} = y·P0: ln(y)/k, floored (mod.rs x_at_ratio). */
  private xAtRatio(yQ64: bigint): bigint {
    const ln = mulQ64Wide(log2Q64(yQ64), LN2_Q64);
    if (ln >> 96n !== 0n) throw new CurveMathError("MathOverflow");
    const x = (ln << 32n) / this.k;
    if (x > U64_MAX) throw new CurveMathError("MathOverflow");
    return x;
  }

  /** Two Newton steps on the exact area towards area(x) = target (mod.rs refine_area). */
  private refineArea(x0: bigint, target: bigint): bigint {
    let x = x0;
    for (let i = 0; i < 2; i++) {
      const a = this.c.area(x);
      const p = this.c.price(x);
      x = a < target ? satAdd(x, toU64OrMax((target - a) / p)) : satSub(x, toU64OrMax((a - target) / p));
    }
    return x;
  }

  /** Two Newton steps on the exact price towards price(x) = target (mod.rs refine_price). */
  private refinePrice(x0: bigint, target: bigint): bigint {
    let x = x0;
    for (let i = 0; i < 2; i++) {
      const p = this.c.price(x);
      const up = p < target;
      const gap = up ? target - p : p - target;
      const rel = divQ64Wide(gap, p);
      const dx = toU64OrMax((rel << 32n) / this.k);
      x = up ? satAdd(x, dx) : satSub(x, dx);
    }
    return x;
  }

  /** Supply below which the curve prices under the floor `F` (end of the flat
   *  band) — mod.rs band_end. */
  bandEnd(F: bigint): bigint {
    if (F <= this.p0) return 0n;
    const xEst = this.xAtRatio(divQ64Wide(F, this.p0));
    const x = this.refinePrice(min(xEst, this.cap), F);
    let step = margin(x);
    let xf = min(satAdd(x, step), this.cap);
    while (xf < this.cap && this.c.price(xf) < F) {
      xf = min(satAdd(xf, step), this.cap);
      step = satMul(step, 2n);
    }
    return xf;
  }

  /** Largest-but-dust `t` whose curve cost from `sold` fits `cash`; cost rounded
   *  up (mod.rs tokens_for_cash). */
  tokensForCash(sold: bigint, cash: bigint): LaunchFill {
    if (cash === 0n) return { t: 0n, cost: 0n };
    const base = this.c.area(sold);
    const totalLamports = (base >> 64n) + cash;
    const z = divQ64Wide(mulHp(this.k, totalLamports), this.p0);
    const xEst = this.xAtRatio(z + ONE_Q64);
    const target = base + (cash << 64n);
    const x = this.refineArea(max(xEst, sold), target);
    let back = margin(x);
    let t = satSub(satSub(x, sold), back);
    for (;;) {
      const to = sold + t;
      if (to > U64_MAX) throw new CurveMathError("MathOverflow");
      const a = this.c.area(to);
      if (a < base) throw new CurveMathError("MathOverflow");
      const cost = ceilQ64(a - base);
      if (cost <= cash) return { t, cost };
      t = satSub(t, back);
      back = satMul(back, 2n);
    }
  }

  /** Buy with `cash` net lamports from `sold`: flat band at `F`, then the curve. */
  buy(sold: bigint, cash: bigint, F: bigint): LaunchFill {
    const xf = this.bandEnd(F);
    if (sold >= xf) return this.tokensForCash(sold, cash);
    const bandLeft = xf - sold;
    const bandCost = ceilMulQ64(F, bandLeft);
    if (cash < bandCost) {
      const t = (cash << 64n) / F;
      return { t, cost: ceilMulQ64(F, t) };
    }
    const { t, cost } = this.tokensForCash(xf, cash - bandCost);
    return { t: bandLeft + t, cost: bandCost + cost };
  }

  /** Exact cost of `t` tokens from `sold`, rounded up (the capped fill). */
  buyCost(sold: bigint, t: bigint, F: bigint): bigint {
    const to = sold + t;
    const xf = this.bandEnd(F);
    let c = 0n;
    const bandHi = min(to, xf);
    if (bandHi > sold) c += ceilMulQ64(F, bandHi - sold);
    const lo = max(sold, xf);
    if (to > lo) c += ceilQ64(this.c.areaBetween(lo, to));
    return c;
  }

  /** Curve value of selling `t` tokens back from `sold`, rounded down. */
  sellValue(sold: bigint, t: bigint, F: bigint): bigint {
    const a = sold - t;
    const xf = this.bandEnd(F);
    let v = 0n;
    const bandHi = min(sold, xf);
    if (bandHi > a) v += floorMulQ64(F, bandHi - a);
    const lo = max(a, xf);
    if (sold > lo) v += this.c.areaBetween(lo, sold) >> 64n;
    return v;
  }
}

export const isLaunchMarket = (m: RiseProMarketAccount): boolean =>
  m.marketKind === MARKET_KIND_LAUNCH;

/** Spot price of a launch market, Q64.64: max(floor, curve price at supply). */
export function launchSpotPrice(m: RiseProMarketAccount): bigint {
  return max(m.floorPrice, LaunchCurve.of(m).price(m.tokenSupply));
}

export interface LaunchBuyQuote extends BuyQuote {
  /** Cash actually taken. Equals `cashIn` unless the buy fills the sale cap,
   *  in which case only the cap's (grossed-up) cost is used; the rest stays
   *  with the buyer. */
  cashUsed: bigint;
  /** True when this buy fills the last token of the sale cap (the market then
   *  moves to phase 1 and graduates to Raydium). */
  capHit: boolean;
  /** Floor after the fill, Q64.64 (average price paid, only ratchets up). */
  floorAfter: bigint;
}

const feeLegs = (m: RiseProMarketAccount, base: bigint, rateMbps: number): FeeLegs =>
  splitFee(BigInt(m.feesCreator), BigInt(m.feesTeam), base, BigInt(rateMbps));

function requireBonding(m: RiseProMarketAccount): void {
  if (m.launchPhase !== LAUNCH_PHASE.BONDING) throw new CurveMathError("LaunchWrongPhase");
}

/** Quote an exact-cash-in `launch_buy` — launch_buy.rs mirror, including the
 *  partial fill at the sale cap. `vaultBalance` = SPL balance of the market
 *  vault (launch markets do not track it in `floor_reserve`). */
export function quoteLaunchBuy(
  m: RiseProMarketAccount,
  cashIn: bigint,
  vaultBalance: bigint,
): LaunchBuyQuote {
  requireBonding(m);
  const curve = LaunchCurve.of(m);
  const S = m.tokenSupply;
  const F = m.floorPrice;
  const rate = BigInt(m.buyFeeMbps);
  if (S >= m.saleCap) throw new CurveMathError("LaunchCapReached");
  if (cashIn < m.minTradeAmount) throw new CurveMathError("TradeBelowMinimum");

  let cashUsed = cashIn;
  let fee = feeLegs(m, cashUsed, m.buyFeeMbps);
  let net = cashUsed - fee.total;
  if (net <= 0n) throw new CurveMathError("DustTrade");
  let { t, cost } = curve.buy(S, net, F);

  let capHit = false;
  const remaining = m.saleCap - S;
  if (t >= remaining) {
    capHit = true;
    t = remaining;
    cost = curve.buyCost(S, remaining, F);
    cashUsed = ceilDiv(cost * MBPS_DENOMINATOR, MBPS_DENOMINATOR - rate);
    for (let i = 0; i < 8; i++) {
      fee = feeLegs(m, cashUsed, m.buyFeeMbps);
      net = cashUsed - fee.total;
      if (net >= cost) break;
      cashUsed += 1n;
    }
    if (net < cost || cashUsed > cashIn) throw new CurveMathError("MathCorruption");
  }
  if (t <= 0n) throw new CurveMathError("DustOutput");

  const soldAfter = S + t;
  const vaultAfter = vaultBalance + cashUsed - fee.creator - fee.team;
  const floorAfter = soldAfter > 0n ? max(F, (vaultAfter << 64n) / soldAfter) : F;
  return {
    fee,
    net,
    reflection: 0n,
    tokenOut: t,
    spent: cost,
    spotAfter: max(floorAfter, curve.price(soldAfter)),
    cashUsed,
    capHit,
    floorAfter,
  };
}

/** Quote an exact-token-in `launch_sell` — launch_sell.rs mirror. The payout
 *  is the curve value, clamped so the tokens left stay backed at the floor
 *  (`bookShortfall` = the clamped part). */
export function quoteLaunchSell(
  m: RiseProMarketAccount,
  tokenIn: bigint,
  vaultBalance: bigint,
): SellQuote {
  requireBonding(m);
  const curve = LaunchCurve.of(m);
  const S = m.tokenSupply;
  const F = m.floorPrice;
  if (tokenIn <= 0n) throw new CurveMathError("DustTrade");
  if (tokenIn > S) throw new CurveMathError("SupplyUnderflow");

  const grossCurve = curve.sellValue(S, tokenIn, F);
  const capacity = max(0n, vaultBalance - ceilMulQ64(F, S - tokenIn));
  const gross = min(grossCurve, capacity);
  if (gross <= 0n) throw new CurveMathError("DustOutput");
  if (gross < m.minTradeAmount) throw new CurveMathError("TradeBelowMinimum");
  const fee = feeLegs(m, gross, m.sellFeeMbps);
  const soldAfter = S - tokenIn;
  return {
    gross,
    fee,
    reflection: 0n,
    payout: gross - fee.total,
    spotAfter: max(F, curve.price(soldAfter)),
    bookShortfall: grossCurve - gross,
  };
}
