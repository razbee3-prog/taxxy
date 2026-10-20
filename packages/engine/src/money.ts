/** Round to cents, half away from zero, avoiding binary drift (e.g. 1.005 → 1.01). */
export function cents(n: number): number {
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(n) * 100 + 1e-9)) / 100;
}

export function clamp0(n: number): number {
  return n > 0 ? n : 0;
}

export function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0);
}
