// Launch-mode markets (market_kind = 1) — exact mirror of the program's launch
// curve (risepro-program curve/launch_exp.rs, instructions/launch/
// {mod,launch_buy,launch_sell}.rs).
//
// Every launch quote runs on the market's effective curve, read off its OWN
// current fields (never hard-coded; a launch sell landing in the floor band
// refits them on-chain):
//
//   E(x) = F                       x ≤ x1          (floor band, `floor_price`)
//        = F + s·(M(x) − M(x1))    x1 < x ≤ x2     (ramp: `ramp_start_x`,
//        = M(x)                    x > x2           `ramp_scalar`, `x2_cached`,
//                                                   `m_x1_cached`)
//
// with M the launch characteristic (curve kind 3), `char_params = [p0, m, ±g2, k]`
// and `start = hinge_x`:
//
//   M(x)  = p0 + m·d + σ·g2·(e^u − 1 − u)               d = max(x − start, 0)
//   ∫₀ˣ M = p0·x + m·d²/2 + σ·g3·(e^u − 1 − u − u²/2)   u = k·d, g3 = g2/k
//
// σ = −1 (concave) when g2 < 0. A fresh market stores [P0, P0·k, P0, k] with
// start 0 (pristine P0·e^{k·x}): its fill takes the closed-form inverse (a
// fixed-point ln, two Newton steps on the exact area); a refitted curve fills by
// Newton from above. Both back off by a dust margin checked on the exact area.
// Below the ramp's end the band / ramp leg runs the overlay's exact search,
// then the curve leg (mod.rs fill_on). Same operation order and rounding as the
// program, so a quote computed here equals the transaction result.
import {
  Characteristic,
  CurveMathError,
  FeeLegs,
  ONE_Q64,
  Overlay,
  ShiftedCharacteristic,
  U64_MAX,
  ceilQ64,
  defaultAreaBetween,
  divQ64Hp,
  divQ64Wide,
  expQ64,
  mulHp,
  mulInt,
  mulQ64Wide,
  splitFee,
  BuyQuote,
  SellQuote,
  MBPS_DENOMINATOR,
} from "./math";
import { RiseProMarketAccount } from "./deserialize";
import { CURVE_KIND_LAUNCH_EXP, LAUNCH_PHASE, MARKET_KIND_LAUNCH } from "./constants";

const Q64 = 1n << 64n;
const LIMIT_U128 = 1n << 128n;
/** round(ln 2 · 2^64) — curve/hinged_exp.rs LN2_Q64. */
const LN2_Q64 = 12786308645202655660n;

const checkU128 = (v: bigint): bigint => {
  if (v < 0n || v >= LIMIT_U128) throw new CurveMathError("MathOverflow");
  return v;
};
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const ceilMulQ64 = (p: bigint, units: bigint): bigint => ceilDiv(p * units, Q64);
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
// u64 saturating arithmetic, as the Rust side.
const satAdd = (a: bigint, b: bigint): bigint => min(a + b, U64_MAX);
const satSub = (a: bigint, b: bigint): bigint => (a > b ? a - b : 0n);
const satMul = (a: bigint, b: bigint): bigint => min(a * b, U64_MAX);
const toU64OrMax = (v: bigint): bigint => min(v, U64_MAX);
const toU64 = (v: bigint): bigint => {
  if (v > U64_MAX) throw new CurveMathError("MathOverflow");
  return v;
};

/** The launch characteristic (curve/launch_exp.rs) — bit-exact mirror. */
export class LaunchExpCharacteristic implements Characteristic {
  /** |g2|, Q64.64. */
  readonly g2: bigint;
  /** |g2| / k (div_q64_hp), Q64.64. */
  readonly g3: bigint;
  /** σ = −1: the growth term is subtracted (g2 < 0 in char_params). */
  readonly concave: boolean;

  constructor(
    /** Price at (and below) `start`, Q64.64. */
    readonly p0: bigint,
    /** Linear slope above `start`, per raw token, Q64.96. */
    readonly m: bigint,
    g2Signed: bigint,
    /** Intensity per raw token, Q64.96. Never zero. */
    readonly k: bigint,
    /** Supply (raw units) the exponential starts from (`hinge_x`). */
    readonly start: bigint,
  ) {
    if (p0 < 0n || m < 0n || k <= 0n) throw new CurveMathError("InvalidCurveParams");
    this.concave = g2Signed < 0n;
    this.g2 = this.concave ? -g2Signed : g2Signed;
    this.g3 = divQ64Hp(this.g2, k);
  }

  /** From the stored `char_params = [p0, m, ±g2, k]` and `start` (`hinge_x`). */
  static fromParams(p: readonly bigint[], start: bigint): LaunchExpCharacteristic {
    return new LaunchExpCharacteristic(p[0], p[1], p[2], p[3], start);
  }

  /** The pure exponential p0 + g2·(e^u − 1) (no stored slope). */
  isPure(): boolean {
    return this.m === 0n && !this.concave;
  }

  /** P0·e^{k·x} as a fresh launch market stores it (closed-form fill). */
  isPristine(): boolean {
    return this.start === 0n && !this.concave && this.p0 === this.g2;
  }

  /** (u, e^u − 1 − u) at d, u Q64.64. Zero at d = 0 exactly. */
  private uA2(d: bigint): [bigint, bigint] {
    const u = mulHp(this.k, d);
    const a2 = expQ64(u) - ONE_Q64 - u;
    if (a2 < 0n) throw new CurveMathError("MathOverflow");
    return [u, a2];
  }

  private signed(base: bigint, term: bigint): bigint {
    return checkU128(this.concave ? base - term : base + term);
  }

  price(x: bigint): bigint {
    const d = x > this.start ? x - this.start : 0n;
    const [u, a2] = this.uA2(d);
    if (this.isPure()) return checkU128(this.p0 + mulQ64Wide(this.g2, a2 + u));
    const base = checkU128(this.p0 + mulHp(this.m, d));
    if (a2 === 0n) return base;
    return this.signed(base, mulQ64Wide(this.g2, a2));
  }

  area(x: bigint): bigint {
    const d = x > this.start ? x - this.start : 0n;
    const base = mulInt(this.p0, x);
    const [u, a2] = this.uA2(d);
    if (this.isPure()) {
      if (a2 === 0n) return base;
      return checkU128(base + mulQ64Wide(this.g3, a2));
    }
    const quad = mulHp(this.m, checkU128(d * d) / 2n);
    const area = checkU128(base + quad);
    if (a2 === 0n) return area;
    const u2Half = mulQ64Wide(u, u) / 2n;
    const a3 = a2 > u2Half ? a2 - u2Half : 0n;
    if (a3 === 0n) return area;
    return this.signed(area, mulQ64Wide(this.g3, a3));
  }

  areaBetween(lo: bigint, hi: bigint): bigint {
    return defaultAreaBetween(this, lo, hi);
  }
}

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
  /** Exact cost of the fill, rounded up (raw lamports). */
  cost: bigint;
}

/** The plain launch curve of one market plus the sale cap that bounds every
 *  search — `LaunchCurve::of` mirror. */
export class LaunchCurve {
  readonly c: LaunchExpCharacteristic;

  constructor(
    charParams: readonly bigint[],
    /** `sale_cap`: no token trades past it. */
    readonly cap: bigint,
    /** `hinge_x`: where the (refitted) exponential starts. */
    start: bigint = 0n,
  ) {
    this.c = LaunchExpCharacteristic.fromParams(charParams, start);
  }

  static of(m: RiseProMarketAccount): LaunchCurve {
    if (m.curveKind !== CURVE_KIND_LAUNCH_EXP) throw new CurveMathError("InvalidCurveParams");
    return new LaunchCurve(m.charParams, m.saleCap, m.hingeX);
  }

  get p0(): bigint { return this.c.p0; }
  get k(): bigint { return this.c.k; }

  /** Marginal price of the plain curve at `sold`, Q64.64 lamports per raw token. */
  price(sold: bigint): bigint { return this.c.price(sold); }

  /** Supply where P0·e^{k·x} = y·P0: ln(y)/k, floored (mod.rs x_at_ratio). */
  private xAtRatio(yQ64: bigint): bigint {
    const ln = mulQ64Wide(log2Q64(yQ64), LN2_Q64);
    if (ln >> 96n !== 0n) throw new CurveMathError("MathOverflow");
    return toU64((ln << 32n) / this.k);
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

  /** Newton from above on a refitted curve's area (mod.rs newton_fill); null
   *  when the area at `cap` is still within `target` (the buy fills to the cap). */
  private newtonFill(sold: bigint, cash: bigint, target: bigint): bigint | null {
    if (this.c.area(this.cap) <= target) return null;
    const spot = this.c.price(sold);
    const over = toU64OrMax((cash << 64n) / max(spot, 1n));
    let x = min(satAdd(satAdd(sold, over), 1n), this.cap);
    for (let i = 0; i < 32; i++) {
      const a = this.c.area(x);
      if (a <= target) break;
      const p = max(this.c.price(x), 1n);
      const step = toU64OrMax(ceilDiv(a - target, p));
      x = max(satSub(x, step), sold);
      if (step <= 1n) break;
    }
    return x;
  }

  /** Largest-but-dust `t` whose cost from `sold`, rounded up, fits `cash`
   *  (mod.rs tokens_for_cash). The pristine path does not clamp to the cap. */
  tokensForCash(sold: bigint, cash: bigint): LaunchFill {
    if (cash === 0n) return { t: 0n, cost: 0n };
    const base = this.c.area(sold);
    const target = checkU128(base + (cash << 64n));
    let x: bigint;
    if (this.c.isPristine()) {
      const totalLamports = (base >> 64n) + cash;
      const z = divQ64Wide(mulHp(this.c.k, totalLamports), this.c.p0);
      const xEst = this.xAtRatio(checkU128(z + ONE_Q64));
      x = this.refineArea(max(xEst, sold), target);
    } else {
      const n = this.newtonFill(sold, cash, target);
      if (n === null) {
        const a = this.c.area(this.cap);
        if (a < base || this.cap < sold) throw new CurveMathError("MathOverflow");
        return { t: this.cap - sold, cost: ceilQ64(a - base) };
      }
      x = n;
    }
    let back = margin(x);
    let t = satSub(satSub(x, sold), back);
    for (;;) {
      const to = toU64(sold + t);
      const a = this.c.area(to);
      if (a < base) throw new CurveMathError("MathOverflow");
      const cost = ceilQ64(a - base);
      if (cost <= cash) return { t, cost };
      t = satSub(t, back);
      back = satMul(back, 2n);
    }
  }
}

export const isLaunchMarket = (m: RiseProMarketAccount): boolean =>
  m.marketKind === MARKET_KIND_LAUNCH;

/** The market's effective curve (`Market::quotable()`): floor band, ramp, then
 *  the launch curve, all from the market's current fields. */
export function launchOverlay(m: RiseProMarketAccount): Overlay<Characteristic> {
  const c = LaunchCurve.of(m).c;
  const y = m.yShift ?? 0n;
  const ch: Characteristic = y === 0n ? c : new ShiftedCharacteristic(c, y);
  return new Overlay(ch, m.floorPrice, m.rampStartX, m.rampScalar, m.x2Cached, m.mX1Cached);
}

/** Supply from which the effective curve is the plain launch curve (mod.rs curve_from). */
export const launchCurveFrom = (m: RiseProMarketAccount): bigint => max(m.x2Cached, m.rampStartX);

/** The fill over an effective curve `q` whose plain launch curve starts at
 *  `top`: the band / ramp leg by the exact search, then the curve leg (mod.rs fill_on). */
export function launchFillOn(
  q: Overlay<Characteristic>,
  curve: LaunchCurve,
  top: bigint,
  sold: bigint,
  cash: bigint,
): LaunchFill {
  if (sold >= top) return curve.tokensForCash(sold, cash);
  const toTop = toU64(ceilQ64(q.cost(sold, top)));
  if (cash < toTop) {
    const f = q.tokensForCash(sold, cash);
    return { t: f.tokens, cost: f.cost };
  }
  const leg = curve.tokensForCash(top, cash - toTop);
  return { t: toU64(top - sold + leg.t), cost: toU64(toTop + leg.cost) };
}

/** Spot price of a launch market, Q64.64: the effective price at supply. */
export function launchSpotPrice(m: RiseProMarketAccount): bigint {
  return launchOverlay(m).effPrice(m.tokenSupply);
}

export interface LaunchBuyQuote extends BuyQuote {
  /** Cash actually taken. Equals `cashIn` unless the buy fills the sale cap,
   *  in which case only the cap's (grossed-up) cost is used; the rest stays
   *  with the buyer. */
  cashUsed: bigint;
  /** True when this buy fills the last token of the sale cap (the market then
   *  moves to phase 1 and graduates to Raydium). */
  capHit: boolean;
  /** Floor after the fill, Q64.64. A buy never moves it (the crank raises it
   *  afterwards), so this is the current `floorPrice`. */
  floorAfter: bigint;
}

const feeLegs = (m: RiseProMarketAccount, base: bigint, rateMbps: number): FeeLegs =>
  splitFee(BigInt(m.feesCreator), BigInt(m.feesTeam), base, BigInt(rateMbps));

function requireBonding(m: RiseProMarketAccount): void {
  if (m.launchPhase !== LAUNCH_PHASE.BONDING) throw new CurveMathError("LaunchWrongPhase");
}

/** Quote an exact-cash-in `launch_buy` — launch_buy.rs mirror, including the
 *  partial fill at the sale cap. `vaultBalance` (the market vault's SPL
 *  balance) is not needed by the buy maths; kept for signature compatibility. */
export function quoteLaunchBuy(
  m: RiseProMarketAccount,
  cashIn: bigint,
  _vaultBalance?: bigint,
): LaunchBuyQuote {
  requireBonding(m);
  const S = m.tokenSupply;
  const rate = BigInt(m.buyFeeMbps);
  if (S >= m.saleCap) throw new CurveMathError("LaunchCapReached");
  if (cashIn < m.minTradeAmount) throw new CurveMathError("TradeBelowMinimum");

  let cashUsed = cashIn;
  let fee = feeLegs(m, cashUsed, m.buyFeeMbps);
  if (fee.total > cashUsed) throw new CurveMathError("MathOverflow");
  let net = cashUsed - fee.total;
  if (net <= 0n) throw new CurveMathError("DustTrade");
  const curve = LaunchCurve.of(m);
  const q = launchOverlay(m);
  let { t, cost } = launchFillOn(q, curve, launchCurveFrom(m), S, net);

  let capHit = false;
  const remaining = m.saleCap - S;
  if (t >= remaining) {
    capHit = true;
    t = remaining;
    cost = toU64(ceilQ64(q.cost(S, toU64(S + remaining))));
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
  return {
    fee,
    net,
    reflection: 0n,
    tokenOut: t,
    spent: cost,
    spotAfter: q.effPrice(soldAfter),
    cashUsed,
    capHit,
    floorAfter: m.floorPrice,
  };
}

/** Quote an exact-token-in `launch_sell` — launch_sell.rs mirror. The payout
 *  is the effective-curve value, clamped so the tokens left stay backed at the
 *  floor (`bookShortfall` = the clamped part). A sale landing in the floor band
 *  refits the curve on-chain after paying: the payout is unaffected, and
 *  `spotAfter` (the floor there) is read on the pre-sale curve. */
export function quoteLaunchSell(
  m: RiseProMarketAccount,
  tokenIn: bigint,
  vaultBalance: bigint,
): SellQuote {
  requireBonding(m);
  const S = m.tokenSupply;
  const F = m.floorPrice;
  if (tokenIn <= 0n) throw new CurveMathError("DustTrade");
  if (tokenIn > S) throw new CurveMathError("SupplyUnderflow");

  const q = launchOverlay(m);
  const grossCurve = toU64(q.cashForTokens(S, tokenIn));
  const soldAfter = S - tokenIn;
  const capacity = satSub(vaultBalance, ceilMulQ64(F, soldAfter));
  const gross = min(grossCurve, capacity);
  if (gross <= 0n) throw new CurveMathError("DustOutput");
  if (gross < m.minTradeAmount) throw new CurveMathError("TradeBelowMinimum");
  const fee = feeLegs(m, gross, m.sellFeeMbps);
  return {
    gross,
    fee,
    reflection: 0n,
    payout: gross - fee.total,
    spotAfter: q.effPrice(soldAfter),
    bookShortfall: grossCurve - gross,
  };
}
