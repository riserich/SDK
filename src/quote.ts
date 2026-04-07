/**
 * Price curve math for Rise Protocol bonding curves.
 *
 * Three regions:
 * - Floor Region (0 to x1): price = floor
 * - Shoulder Region (x1 to x2): price = m1 * x + b1
 * - Main Region (x2 to infinity): price = m2 * x + b2
 *
 * Where:
 * - b1 = (m2 - m1) * x2 + b2
 * - x1 = (floor - b1) / m1
 */

export function calculatePrice(
  tokenSupply: number,
  floor: number,
  m1: number,
  m2: number,
  x2: number,
  b2: number,
): number {
  const b1 = (m2 - m1) * x2 + b2;
  const x1 = Math.abs(m1) < 1e-30 ? Infinity : (floor - b1) / m1;

  if (tokenSupply <= x1) return floor;
  if (tokenSupply <= x2) return m1 * tokenSupply + b1;
  return m2 * tokenSupply + b2;
}

export function integratePriceCurve(
  x1: number,
  x2: number,
  floor: number,
  m1: number,
  m2: number,
  x2Boundary: number,
  b2: number,
): number {
  if (x1 >= x2) return 0;

  const b1 = (m2 - m1) * x2Boundary + b2;
  const x1Boundary = (floor - b1) / m1;

  const integrateLinear = (m: number, b: number, from: number, to: number): number =>
    (m / 2) * (to * to - from * from) + b * (to - from);

  let integral = 0;
  let currentX = x1;

  while (currentX < x2) {
    if (currentX < x1Boundary) {
      const endX = Math.min(x2, x1Boundary);
      integral += floor * (endX - currentX);
      currentX = endX;
    } else if (currentX < x2Boundary) {
      const endX = Math.min(x2, x2Boundary);
      integral += integrateLinear(m1, b1, currentX, endX);
      currentX = endX;
    } else {
      integral += integrateLinear(m2, b2, currentX, x2);
      currentX = x2;
    }
  }

  return integral;
}

export function calculateTokensFromCash(
  currentTokenSupply: number,
  cashIn: number,
  floor: number,
  m1: number,
  m2: number,
  x2: number,
  b2: number,
): number {
  if (cashIn <= 0) return 0;

  const currentPrice = calculatePrice(currentTokenSupply, floor, m1, m2, x2, b2);

  let low = currentTokenSupply;
  let high: number;

  if (currentTokenSupply > x2) {
    high = currentTokenSupply + (cashIn / currentPrice) * 2;
  } else if (currentTokenSupply > 0) {
    high = currentTokenSupply + (cashIn / floor) * 10;
  } else {
    high = (cashIn / floor) * 10;
  }

  if (high <= currentTokenSupply) {
    high = currentTokenSupply + Math.max(cashIn / currentPrice, cashIn / floor) * 2;
  }

  for (let i = 0; i < 100; i++) {
    const mid = (low + high) / 2;
    const integral = integratePriceCurve(currentTokenSupply, mid, floor, m1, m2, x2, b2);

    if (Math.abs(integral - cashIn) < 0.0001) return mid - currentTokenSupply;
    if (integral < cashIn) low = mid;
    else high = mid;
  }

  return (low + high) / 2 - currentTokenSupply;
}

export function calculateCashFromTokens(
  currentTokenSupply: number,
  tokenIn: number,
  floor: number,
  m1: number,
  m2: number,
  x2: number,
  b2: number,
): number {
  if (tokenIn <= 0) return 0;

  const startSupply = currentTokenSupply - tokenIn;
  if (startSupply < 0) {
    return integratePriceCurve(0, currentTokenSupply, floor, m1, m2, x2, b2);
  }

  return integratePriceCurve(startSupply, currentTokenSupply, floor, m1, m2, x2, b2);
}
