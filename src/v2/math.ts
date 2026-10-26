// Rise Pro (v2) curve maths — exact TypeScript mirror of the on-chain code.
// Ported verbatim from the Rise backend (src/utils/rise-pro-curve.ts), which
// itself mirrors rise-program/programs/rise/src/curve*. Everything is bigint
// Q64.64: same truncations, same rounding, same bisection — a quote computed
// here equals the on-chain result bit for bit. DO NOT "clean up" the maths.

export const ONE_Q64 = 1n << 64n;
const MASK_64 = ONE_Q64 - 1n;
const LIMIT_U128 = 1n << 128n;
export const U64_MAX = (1n << 64n) - 1n;

/** Thrown where the program would revert with MathOverflow / RampBelowFloor. */
export class CurveMathError extends Error {}

function checkU128(v: bigint): bigint {
  if (v < 0n || v >= LIMIT_U128) throw new CurveMathError("MathOverflow");
  return v;
}

/** Q64.64 × Q64.64 → Q64.64 — exact mirror of overlay.rs::mul_q64, including
 *  the low×low >> 64 truncation and the revert when the true value ≥ 2^128. */
export function mulQ64(a: bigint, b: bigint): bigint {
  const ai = a >> 64n;
  const af = a & MASK_64;
  const bi = b >> 64n;
  const bf = b & MASK_64;
  const hiRaw = ai * bi;
  if (hiRaw >> 64n !== 0n) throw new CurveMathError("MathOverflow");
  const hi = hiRaw << 64n;
  const mid = checkU128(ai * bf + af * bi);
  const lo = (af * bf) >> 64n;
  return checkU128(checkU128(hi + mid) + lo);
}

/** Q64.64 × integer → Q64.64 (curve.rs::mul_int). */
export function mulInt(a: bigint, b: bigint): bigint {
  return checkU128(a * b);
}

/** Q64.64 → integer, rounding up (what a user pays). */
export function ceilQ64(v: bigint): bigint {
  return (v >> 64n) + ((v & MASK_64) !== 0n ? 1n : 0n);
}

/** Q64.64 → integer, rounding down (what a user receives). */
export function floorQ64(v: bigint): bigint {
  return v >> 64n;
}

// ---------------------------------------------------------------------------
// Characteristic
// ---------------------------------------------------------------------------

/** A characteristic price function M(x): non-decreasing, evaluable, integrable. */
export interface Characteristic {
  /** M(x), Q64.64. */
  price(x: bigint): bigint;
  /** ∫₀ˣ M, Q64.64. */
  area(x: bigint): bigint;
  /** ∫ₗₒʰⁱ M as a definite integral — curve.rs::area_between mirror. On the
   *  shifted characteristic only the final slice is range-checked, never the
   *  from-0 areas, which a strongly-negative Y drives below zero even though
   *  the slice is positive (the exit-freeze bug, shifted.rs:58). */
  areaBetween(lo: bigint, hi: bigint): bigint;
}

/** Trait-default mirror: `area(hi) − area(lo)`, underflow = MathOverflow. */
function defaultAreaBetween(c: Characteristic, lo: bigint, hi: bigint): bigint {
  const aHi = c.area(hi);
  const aLo = c.area(lo);
  if (aHi < aLo) throw new CurveMathError("MathOverflow");
  return aHi - aLo;
}

/** M(x) = p0 + m·x — mirror of curve/linear.rs (x²/2 before the slope multiply). */
export class LinearCharacteristic implements Characteristic {
  constructor(
    public readonly p0: bigint, // Q64.64
    public readonly m: bigint, // Q64.96 per raw token unit
  ) {}

  price(x: bigint): bigint {
    return checkU128(this.p0 + mulHp(this.m, x));
  }

  area(x: bigint): bigint {
    const base = mulInt(this.p0, x);
    const x2 = checkU128(x * x);
    const quad = checkU128(mulHp(this.m, x2 / 2n));
    return checkU128(base + quad);
  }

  areaBetween(lo: bigint, hi: bigint): bigint {
    return defaultAreaBetween(this, lo, hi);
  }
}

// ---------------------------------------------------------------------------
// Hinged exponential (curve/hinged_exp.rs) — bit-exact mirror, Φ-free form.
// The normative contract is rise-program/docs/hinged-exp-fixed-point.md:
//   M(x) = p0 + m·x + g2·(e^u − 1 − u)              u = k·d, g2 = 2q/k²
//   A(x) = p0·x + m·x²/2 + g3·(e^u − 1 − u − u²/2)  g3 = div_q64(g2, k)
// One exp + one wide multiply on the hot path; constants and operation order
// MUST match the Rust module exactly (asserted by scripts/_check_exp_mirror.ts).
// ---------------------------------------------------------------------------

export const CURVE_KIND_HINGED_EXP = 1;

const LN2_Q64 = 12786308645202655660n;
const U_MAX_Q64 = 32n << 64n;
const LIMIT_U128_LOCAL = 1n << 128n;

/** floor(a·b / 2^64) on the FULL product (not the legacy low×low shortcut). */
export function mulQ64Wide(a: bigint, b: bigint): bigint {
  const v = (a * b) >> 64n;
  if (v >= LIMIT_U128_LOCAL) throw new CurveMathError("MathOverflow");
  return v;
}

/** floor(a·2^64 / b), checked — same domain guards as the Rust side. */
export function divQ64Wide(a: bigint, b: bigint): bigint {
  if (b === 0n || b >= 1n << 96n) throw new CurveMathError("MathOverflow");
  if (a >> 64n >= b) throw new CurveMathError("MathOverflow");
  return (a << 64n) / b;
}

/** The per-raw-unit params (`m`, `k`) are Q64.96 — 32 extra fractional bits
 *  (curve/hinged_exp.rs `SLOPE_FRAC_EXTRA`) so v1-grade launch prices stay
 *  representable on expensive many-decimal collateral. */
export const SLOPE_FRAC_EXTRA = 32n;

/** floor(a·b / 2^32) — Q64.96 per-raw-unit × integer → Q64.64, mirror of mul_hp. */
export function mulHp(a: bigint, b: bigint): bigint {
  const p = a * b;
  if (p >> 160n !== 0n) throw new CurveMathError("MathOverflow");
  return p >> 32n;
}

/** floor(a·2^96 / b) — Q64.64 over Q64.96 → Q64.64, mirror of div_q64_hp. */
export function divQ64Hp(a: bigint, b: bigint): bigint {
  if (b === 0n || b >= 1n << 96n) throw new CurveMathError("MathOverflow");
  if (a >= b << 32n) throw new CurveMathError("MathOverflow");
  return (a << 96n) / b;
}

/** e^u in Q64.64 for 0 ≤ u ≤ 32 — ln2 range-reduction + 20-term Taylor, the
 *  loop in 64-bit semantics exactly as on-chain (term ≤ r < 2^64). */
export function expQ64(u: bigint): bigint {
  if (u > U_MAX_Q64) throw new CurveMathError("MathOverflow");
  const n = u / LN2_Q64;
  const r = u - n * LN2_Q64;
  let acc = ONE_Q64 + r;
  let t = r;
  for (let i = 2n; i <= 20n; i++) {
    t = ((t * r) >> 64n) / i;
    if (t === 0n) break;
    acc += t;
  }
  return checkU128(acc * (1n << n));
}

/**
 * The hinged exponential in the Φ-free form. char_params kind 1 =
 * [p0, m, g2, k] (all Q64.64); g3 derives at construction with the same
 * floor as on-chain. Below the hinge the growth term is identically zero
 * (expQ64(0) = 2^64 exactly), so the curve IS the line there.
 */
export class HingedExponentialCharacteristic implements Characteristic {
  public readonly g3: bigint;

  constructor(
    public readonly p0: bigint, // Q64.64
    public readonly m: bigint, // Q64.96 per raw unit
    public readonly g2: bigint, // Q64.64 — 2q/k²
    public readonly k: bigint, // Q64.96 per raw unit
    public readonly hingeX: bigint, // raw supply units
  ) {
    this.g3 = divQ64Hp(g2, k);
  }

  /** (u, e^u − 1 − u) at this supply. `u` is Q64.64. */
  private uA2(x: bigint): [bigint, bigint] {
    const d = x > this.hingeX ? x - this.hingeX : 0n;
    const u = mulHp(this.k, d);
    const a2 = expQ64(u) - ONE_Q64 - u;
    if (a2 < 0n) throw new CurveMathError("MathOverflow");
    return [u, a2];
  }

  price(x: bigint): bigint {
    const base = checkU128(this.p0 + mulHp(this.m, x));
    const [, a2] = this.uA2(x);
    if (a2 === 0n) return base;
    return checkU128(base + mulQ64Wide(this.g2, a2));
  }

  /** Linear terms exactly as the linear kind; the last subtraction saturates
   *  (one-ulp wiggle at tiny u clamps to zero rather than reverting). */
  area(x: bigint): bigint {
    const base = mulInt(this.p0, x);
    const x2 = checkU128(x * x);
    const quad = checkU128(mulHp(this.m, x2 / 2n));
    let area = checkU128(base + quad);
    const [u, a2] = this.uA2(x);
    if (a2 > 0n) {
      const u2Half = mulQ64Wide(u, u) / 2n;
      const a3 = a2 > u2Half ? a2 - u2Half : 0n;
      if (a3 > 0n) {
        area = checkU128(area + mulQ64Wide(this.g3, a3));
      }
    }
    return area;
  }

  areaBetween(lo: bigint, hi: bigint): bigint {
    return defaultAreaBetween(this, lo, hi);
  }
}

/** init_market.rs creation checks for the hinged-exponential family
 *  (Sherlock #51). Throws "InvalidCurveParams" when the price math cannot be
 *  built from the params, "CurveCapReachable" when the exp computation wall
 *  (u = k·d = 32) can be reached with less than 2^63 raw collateral — a buy
 *  there would be capped by curve overflow and now reverts. Linear: no-op. */
export function assertCurveCreatable(
  curveKind: number,
  charParams: readonly (bigint | string)[],
  hingeX: bigint | string,
): void {
  if (curveKind !== CURVE_KIND_HINGED_EXP) return;
  const [p0, m, g2, k] = charParams.map((v) => BigInt(v));
  const hinge = BigInt(hingeX);
  let c: HingedExponentialCharacteristic;
  try {
    c = new HingedExponentialCharacteristic(p0, m, g2, k, hinge);
  } catch {
    throw new CurveMathError("InvalidCurveParams");
  }
  const d = (32n << 96n) / k;
  if (d > U64_MAX) return;
  const xLim = hinge + d;
  if (xLim > U64_MAX) return;
  let cost: bigint;
  try {
    cost = c.area(xLim);
  } catch {
    return; // the wall costs more than u128 can express — unreachable
  }
  if (ceilQ64(cost) < 1n << 63n) throw new CurveMathError("CurveCapReachable");
}

// ---------------------------------------------------------------------------
// Overlay: floor + ramp over the characteristic (curve/overlay.rs)
// ---------------------------------------------------------------------------

export class Overlay<C extends Characteristic> {
  constructor(
    public readonly characteristic: C,
    /** Q64.64 floor price. */
    public readonly floor: bigint,
    /** End of the flat band, raw token units. */
    public readonly x1: bigint,
    /** Ramp steepness, Q64.64, > 1. */
    public readonly s: bigint,
    /** Cached crossover; 0 = degenerate ramp (C ≡ M above x1). */
    public readonly x2: bigint,
    /** Cached M(x1). */
    public readonly mX1: bigint,
  ) {}

  private rampPrice(x: bigint): bigint {
    const m = this.characteristic.price(x);
    const delta = m > this.mX1 ? m - this.mX1 : 0n; // saturating_sub
    const scaled = mulQ64(this.s, delta);
    return checkU128(this.floor + scaled);
  }

  private rampArea(x: bigint): bigint {
    const width = x - this.x1;
    if (width < 0n) throw new CurveMathError("MathOverflow");
    // `A(x) − A(x1)` as a definite integral (overlay.rs::ramp_area), so a
    // downward shift never makes a from-0 area underflow.
    const slice = this.characteristic.areaBetween(this.x1, x);
    const pos = checkU128(mulInt(this.floor, width) + mulQ64(this.s, slice));
    const neg = mulInt(mulQ64(this.s, this.mX1), width);
    if (pos < neg) throw new CurveMathError("RampBelowFloor");
    return pos - neg;
  }

  effPrice(x: bigint): bigint {
    if (x <= this.x1) return this.floor;
    if (this.x2 > this.x1 && x <= this.x2) return this.rampPrice(x);
    return this.characteristic.price(x);
  }

  effArea(x: bigint): bigint {
    if (x <= this.x1) return mulInt(this.floor, x);
    const flat = mulInt(this.floor, this.x1);
    if (this.x2 > this.x1 && x <= this.x2) {
      return checkU128(flat + this.rampArea(x));
    }
    if (this.x2 > this.x1) {
      const uptoX2 = checkU128(flat + this.rampArea(this.x2));
      // `A(x) − A(x2)` as a definite integral (safe under a negative shift).
      const tail = this.characteristic.areaBetween(this.x2, x);
      return checkU128(uptoX2 + tail);
    }
    // Degenerate ramp: the flat band ends where the characteristic takes over.
    const tail = this.characteristic.areaBetween(this.x1, x);
    return checkU128(flat + tail);
  }

  private subOrThrow(a: bigint, b: bigint): bigint {
    if (a < b) throw new CurveMathError("MathOverflow");
    return a - b;
  }

  /** Exact cost of moving supply from → to, Q64.64. Never rounded here. */
  cost(from: bigint, to: bigint): bigint {
    return this.subOrThrow(this.effArea(to), this.effArea(from));
  }

  /**
   * Largest tokens whose cost, rounded up, still fits cashIn raw collateral
   * units. Returns { tokens, cost } — exact mirror of Quotable::tokens_for_cash
   * (spot-seeded hi, ceil midpoint, overflow treated as "too expensive").
   */
  tokensForCash(supply: bigint, cashIn: bigint): { tokens: bigint; cost: bigint } {
    if (cashIn === 0n) return { tokens: 0n, cost: 0n };
    const spot = this.effPrice(supply);
    const remaining = U64_MAX - supply;
    let hi: bigint;
    if (spot === 0n) {
      hi = remaining;
    } else {
      const est = (cashIn << 64n) / spot + 2n;
      hi = est > remaining ? remaining : est;
    }
    let lo = 0n;
    while (lo < hi) {
      const gap = hi - lo;
      const mid = lo + gap / 2n + (gap % 2n === 0n ? 0n : 1n); // div_ceil
      const to = supply + mid;
      let fits = false;
      try {
        fits = ceilQ64(this.cost(supply, to)) <= cashIn;
      } catch {
        fits = false; // overflow = too expensive
      }
      if (fits) lo = mid;
      else hi = mid - 1n;
    }
    // curve.rs::bisect_fill (Sherlock #51): a fill capped by curve overflow,
    // not by cash, reverts — evaluating the next token throws MathOverflow.
    if (lo < remaining) this.effArea(supply + lo + 1n);
    const cost = ceilQ64(this.cost(supply, supply + lo));
    return { tokens: lo, cost };
  }

  /** Proceeds from selling tokens, rounded down. */
  cashForTokens(supply: bigint, tokens: bigint): bigint {
    if (tokens > supply) throw new CurveMathError("MathOverflow");
    return floorQ64(this.cost(supply - tokens, supply));
  }
}

/**
 * A characteristic quoted bare — the buy-side curve of a self-healing market
 * (curve/shifted.rs::Bare mirror). Implemented as a degenerate Overlay: with
 * `floor = M(0)`, `x1 = 0`, `x2 = 0` the overlay IS the characteristic, so the
 * exact same spot-seeded search runs, bit-identically to the chain's.
 */
export function bareQuotable(c: Characteristic): Overlay<Characteristic> {
  // floor/mX1 = 0n, NOT c.price(0n): with x1 = x2 = 0 the overlay never reads
  // them above x = 0, and evaluating M̃(0) here would throw "shift below zero"
  // on a healing market whose deep sells pushed Y under −M(0) — a legitimate
  // state the chain's Bare<Shifted> quotes fine, because it only ever
  // evaluates the curve on [supply, to], never at 0.
  return new Overlay(c, 0n, 0n, 2n * ONE_Q64, 0n, 0n);
}

/**
 * Leftmost x ≥ x1 where the ramp catches the characteristic — mirror of
 * curve.rs::derive_x2 including both degenerate cases (F == M(x1) → x1;
 * F > M(x1) → u64::MAX, the ramp is the curve forever).
 */
export function deriveX2(
  c: Characteristic,
  floor: bigint,
  x1: bigint,
  s: bigint,
): bigint {
  const mX1 = c.price(x1);
  if (floor > mX1) return U64_MAX;
  if (floor === mX1) return x1;
  const target = mulQ64(s, mX1);
  const sMinusOne = s - ONE_Q64;
  const catches = (x: bigint): boolean => {
    try {
      if (sMinusOne < 0n) return true;
      const lhs = mulQ64(sMinusOne, c.price(x));
      const sum = lhs + floor; // saturating_add: bigint cannot overflow upward here
      return (sum >= LIMIT_U128 ? LIMIT_U128 - 1n : sum) >= target;
    } catch {
      return true;
    }
  };
  let lo = x1;
  let hi = U64_MAX;
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2n;
    if (catches(mid)) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Fees (util.rs::split_fee) — mbps = parts-per-million, split legs in bps
// ---------------------------------------------------------------------------

export const MBPS_DENOMINATOR = 1_000_000n;
export const BPS_DENOMINATOR = 10_000n;

export interface FeeLegs {
  total: bigint;
  floor: bigint;
  creator: bigint;
  team: bigint;
}

/** Total rounded UP, creator/team legs rounded DOWN, floor = remainder. */
export function splitFee(
  feesCreatorBps: bigint,
  feesTeamBps: bigint,
  base: bigint,
  rateMbps: bigint,
): FeeLegs {
  const p = base * rateMbps;
  const total = p / MBPS_DENOMINATOR + (p % MBPS_DENOMINATOR === 0n ? 0n : 1n);
  const creator = (total * feesCreatorBps) / BPS_DENOMINATOR;
  const team = (total * feesTeamBps) / BPS_DENOMINATOR;
  const floor = total - creator - team;
  if (floor < 0n) throw new CurveMathError("MathOverflow");
  return { total, floor, creator, team };
}

// ---------------------------------------------------------------------------
// Market state plumbing
// ---------------------------------------------------------------------------

export const CURVE_KIND_LINEAR = 0;

/** The curve-relevant slice of a v2 market row (all raw on-chain integers). */
export interface V2CurveState {
  curveKind: number;
  charParams: [bigint, bigint, bigint, bigint];
  floor: bigint; // Q64.64
  rampStartX: bigint; // u64
  rampScalar: bigint; // Q64.64
  x2: bigint; // u64 (0 = degenerate)
  mX1: bigint; // Q64.64
  tokenSupply: bigint; // u64
  /** Raw supply where the exponential ignites (kind 1 only; 0n for linear). */
  hingeX: bigint;
  /** Self-healing translation Y, signed Q64.64 (SELF_HEALING.md). 0n legacy. */
  yShift?: bigint;
  /** Market carries the SELF_HEALING behavior flag (buys ride the main). */
  selfHealing?: boolean;
}

/** M-tilde = M + Y: the self-healing translation (curve/shifted.rs mirror).
 *  Identity when y = 0n, so every state routes through it. */
export class ShiftedCharacteristic implements Characteristic {
  constructor(
    private readonly inner: Characteristic,
    private readonly y: bigint,
  ) {}
  price(x: bigint): bigint {
    const m = this.inner.price(x);
    const v = this.y >= 0n ? m + this.y : m - -this.y;
    if (v < 0n) throw new CurveMathError("shift below zero");
    return v;
  }
  area(x: bigint): bigint {
    const a = this.inner.area(x);
    const shift = mulInt(this.y >= 0n ? this.y : -this.y, x);
    const v = this.y >= 0n ? a + shift : a - shift;
    if (v < 0n) throw new CurveMathError("shift below zero");
    return v;
  }

  /** `∫ₗₒʰⁱ M̃ = (A(hi) − A(lo)) + Y·(hi − lo)` — shifted.rs::area_between
   *  mirror: only the final slice is range-checked, never the from-0 areas,
   *  which a strongly-negative Y drives below zero even though the slice is
   *  positive (the exit-freeze bug). */
  areaBetween(lo: bigint, hi: bigint): bigint {
    const base = this.inner.areaBetween(lo, hi);
    const dy = mulInt(this.y >= 0n ? this.y : -this.y, hi - lo);
    const v = this.y >= 0n ? base + dy : base - dy;
    if (v < 0n) throw new CurveMathError("MathOverflow");
    return v;
  }
}

/** Market flag bit for the self-healing behavior (state/market.rs::flags). */
export const SELF_HEALING_FLAG = 1 << 8;

/** Build the characteristic for a state — the single curve-family dispatch point. */
function baseCharacteristicOf(state: V2CurveState): Characteristic {
  if (state.curveKind === CURVE_KIND_LINEAR) {
    return new LinearCharacteristic(state.charParams[0], state.charParams[1]);
  }
  if (state.curveKind === CURVE_KIND_HINGED_EXP) {
    const [p0, m, q, k] = state.charParams;
    return new HingedExponentialCharacteristic(p0, m, q, k, state.hingeX);
  }
  throw new CurveMathError(`unsupported curve_kind ${state.curveKind}`);
}

/** The effective (quotable) curve for a state. */
export function characteristicOf(state: V2CurveState): Characteristic {
  const base = baseCharacteristicOf(state);
  const y = state.yShift ?? 0n;
  return y === 0n ? base : new ShiftedCharacteristic(base, y);
}

export function overlayOf(state: V2CurveState): Overlay<Characteristic> {
  return new Overlay(
    characteristicOf(state),
    state.floor,
    state.rampStartX,
    state.rampScalar,
    state.x2,
    state.mX1,
  );
}

// ---------------------------------------------------------------------------
// Quotes (mirror of buy.rs / sell.rs flow)
// ---------------------------------------------------------------------------

export interface BuyQuote {
  fee: FeeLegs;
  net: bigint;
  /** Reflection tax leg, ceil(cashIn × reflection_bps / 10000) — buy.rs parity. */
  reflection: bigint;
  tokenOut: bigint;
  /** Exact curve cost of the fill, rounded up (≤ net). */
  spent: bigint;
  /** Spot price after the fill, Q64.64. */
  spotAfter: bigint;
}

/** fee off the top (ceil) → the whole net traverses the curve. The glide split
 *  only allocates reserves; it never changes tokenOut. */
/** The BUY-side curve — market.buy_quotable() mirror: self-healing markets
 *  buy on the shifted main alone (SELF_HEALING.md), legacy markets on the
 *  effective overlay. Single dispatch point for every buy-side quote. */
/**
 * Chain Bare<C> mirror (shifted.rs:75-101): the buy-side curve of a
 * self-healing market — no floor band, no ramp. The fill search quotes costs
 * as definite integrals `areaBetween(supply, to)` so a downward y_shift can
 * never make a from-0 area underflow mid-search and refuse an otherwise-valid
 * buy (the deep-dump variant of the exit-freeze bug).
 */
export class BareQuotable {
  constructor(public readonly characteristic: Characteristic) {}

  effPrice(x: bigint): bigint {
    return this.characteristic.price(x);
  }

  effArea(x: bigint): bigint {
    return this.characteristic.area(x);
  }

  cost(from: bigint, to: bigint): bigint {
    return this.characteristic.areaBetween(from, to);
  }

  tokensForCash(supply: bigint, cashIn: bigint): { tokens: bigint; cost: bigint } {
    if (cashIn === 0n) return { tokens: 0n, cost: 0n };
    const spot = this.effPrice(supply);
    const remaining = U64_MAX - supply;
    let hi: bigint;
    if (spot === 0n) {
      hi = remaining;
    } else {
      const est = (cashIn << 64n) / spot + 2n;
      hi = est > remaining ? remaining : est;
    }
    let lo = 0n;
    while (lo < hi) {
      const gap = hi - lo;
      const mid = lo + gap / 2n + (gap % 2n === 0n ? 0n : 1n); // div_ceil
      let fits = false;
      try {
        fits = ceilQ64(this.cost(supply, supply + mid)) <= cashIn;
      } catch {
        fits = false; // overflow = too expensive
      }
      if (fits) lo = mid;
      else hi = mid - 1n;
    }
    // curve.rs::bisect_fill (Sherlock #51) — see Overlay.tokensForCash.
    if (lo < remaining) this.characteristic.areaBetween(supply, supply + lo + 1n);
    const cost = ceilQ64(this.cost(supply, supply + lo));
    return { tokens: lo, cost };
  }

  cashForTokens(supply: bigint, tokens: bigint): bigint {
    if (tokens > supply) throw new CurveMathError("MathOverflow");
    return floorQ64(this.cost(supply - tokens, supply));
  }
}

export function buyCurveOf(
  state: V2CurveState,
): Overlay<Characteristic> | BareQuotable {
  return state.selfHealing
    ? new BareQuotable(characteristicOf(state))
    : overlayOf(state);
}

/** Pre-trade ledgers the buy-side F* cap reads (state/market.rs::floor_backing). */
export interface BackingLedgers {
  floorReserve: bigint;
  totalDebt: bigint;
  debtFromPrice?: bigint;
}

/** buy.rs / leverage_buy.rs (Sherlock #49): a buy may not take tokens below the
 *  crankable floor F* = max(buffered floor_backing / supply, floor). Returns the
 *  token cap for `net`, or null when there is no supply (no cap). */
export function crankableFloorCap(
  state: V2CurveState,
  net: bigint,
  ledgers: BackingLedgers,
): bigint | null {
  if (state.tokenSupply === 0n) return null;
  const floorDrawn = ledgers.totalDebt - (ledgers.debtFromPrice ?? 0n);
  const backing = ledgers.floorReserve + (floorDrawn > 0n ? floorDrawn : 0n);
  const fromBacking = ((backing * 9_950n) / 10_000n << 64n) / state.tokenSupply;
  const fStar = fromBacking > state.floor ? fromBacking : state.floor;
  const cap = (net << 64n) / fStar;
  return cap > U64_MAX ? U64_MAX : cap;
}

export function quoteBuy(
  state: V2CurveState,
  cashIn: bigint,
  buyFeeMbps: bigint,
  feesCreatorBps: bigint,
  feesTeamBps: bigint,
  reflectionBps: bigint = 0n,
  ledgers?: BackingLedgers,
): BuyQuote {
  const curve = buyCurveOf(state);
  const fee = splitFee(feesCreatorBps, feesTeamBps, cashIn, buyFeeMbps);
  // buy.rs parity: the reflection leg comes off `net` BEFORE the curve quote,
  // rounded up (mul_div_ceil).
  const reflection =
    reflectionBps > 0n
      ? (cashIn * reflectionBps + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR
      : 0n;
  const net = cashIn - fee.total - reflection;
  if (net <= 0n) throw new CurveMathError("DustTrade");
  const fill = curve.tokensForCash(state.tokenSupply, net);
  let tokens = fill.tokens;
  if (ledgers) {
    const cap = crankableFloorCap(state, net, ledgers);
    if (cap !== null && cap < tokens) tokens = cap;
  }
  return {
    fee,
    net,
    reflection,
    tokenOut: tokens,
    // The program keeps the curve fill's cost even when the cap binds.
    spent: fill.cost,
    spotAfter: curve.effPrice(state.tokenSupply + tokens),
  };
}

export interface SellQuote {
  gross: bigint;
  fee: FeeLegs;
  /** Reflection tax leg, ceil(gross × reflection_bps / 10000) — sell.rs parity. */
  reflection: bigint;
  payout: bigint;
  spotAfter: bigint;
  /** Curve value the ledgers could not cover — clamped off the payout by the
   *  program's unconditional-exit fallback. 0n when the books cover the sale
   *  (the normal case) or when no ledger state was provided. */
  bookShortfall: bigint;
}

/** Ledger state for the unconditional-exit clamp (sell.rs mirror). */
export interface SellLedgers {
  floorReserve: bigint;
  priceReserve: bigint;
  totalDebt: bigint;
}

/** leverage_sell.rs: the repay refills the reserves BEFORE the sale is clamped —
 *  floor first up to ceil(F·S), the rest to the price reserve. */
export function postRepayLedgers(
  state: V2CurveState,
  ledgers: SellLedgers,
  repaid: bigint,
): SellLedgers {
  const requiredLive = ceilQ64(state.floor * state.tokenSupply);
  const floorGap =
    requiredLive > ledgers.floorReserve ? requiredLive - ledgers.floorReserve : 0n;
  const toFloor = repaid < floorGap ? repaid : floorGap;
  return {
    floorReserve: ledgers.floorReserve + toFloor,
    priceReserve: ledgers.priceReserve + (repaid - toFloor),
    totalDebt: ledgers.totalDebt > repaid ? ledgers.totalDebt - repaid : 0n,
  };
}

/** util.rs::fee_feedback_extension (Sherlock #68): a clamped sale's fee_floor
 *  comes back to the floor in the same tx, so the clamp is extended by it —
 *  fixed point of d = split_fee(capacity + d).floor − 2, capped at shortfall. */
export function feeFeedbackExtension(
  feesCreatorBps: bigint,
  feesTeamBps: bigint,
  rateMbps: bigint,
  capacity: bigint,
  shortfall: bigint,
): bigint {
  let delta = 0n;
  for (let i = 0; i < 32; i++) {
    const floorLeg = splitFee(feesCreatorBps, feesTeamBps, capacity + delta, rateMbps).floor;
    let next = floorLeg > 2n ? floorLeg - 2n : 0n;
    if (next > shortfall) next = shortfall;
    if (next <= delta) break;
    delta = next;
  }
  return delta;
}

/** gross rounded down by the curve → clamped to the ledgers (never below the
 *  floor value of the tokens, per Law 1) → fee on the clamped gross → payout. */
export function quoteSell(
  state: V2CurveState,
  tokenIn: bigint,
  sellFeeMbps: bigint,
  feesCreatorBps: bigint,
  feesTeamBps: bigint,
  ledgers?: SellLedgers,
  reflectionBps: bigint = 0n,
): SellQuote {
  const curve = overlayOf(state);
  const grossCurve = curve.cashForTokens(state.tokenSupply, tokenIn);
  let gross = grossCurve;
  if (ledgers) {
    const requiredAfter = ceilQ64(state.floor * (state.tokenSupply - tokenIn));
    const mustRetain =
      requiredAfter > ledgers.totalDebt ? requiredAfter - ledgers.totalDebt : 0n;
    const maxFloorDraw =
      ledgers.floorReserve > mustRetain ? ledgers.floorReserve - mustRetain : 0n;
    let capacity = maxFloorDraw + ledgers.priceReserve;
    if (grossCurve > capacity) {
      capacity += feeFeedbackExtension(
        feesCreatorBps,
        feesTeamBps,
        sellFeeMbps,
        capacity,
        grossCurve - capacity,
      );
    }
    if (capacity < gross) gross = capacity;
  }
  const fee = splitFee(feesCreatorBps, feesTeamBps, gross, sellFeeMbps);
  // sell.rs parity: the reflection leg is carved out of the payout, computed
  // on the clamped gross, rounded up (mul_div_ceil).
  const reflection =
    reflectionBps > 0n
      ? (gross * reflectionBps + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR
      : 0n;
  return {
    gross,
    fee,
    reflection,
    payout: gross - fee.total - reflection,
    spotAfter: curve.effPrice(state.tokenSupply - tokenIn),
    bookShortfall: grossCurve - gross,
  };
}

/** Spot price at the current supply, Q64.64. */
export function spotPriceQ64(state: V2CurveState): bigint {
  return overlayOf(state).effPrice(state.tokenSupply);
}
