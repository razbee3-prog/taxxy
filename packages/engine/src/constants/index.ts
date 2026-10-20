import type { TaxConstants } from "../types.js";
import { CONSTANTS_2026 } from "./2026.js";

const BY_YEAR: Record<number, TaxConstants> = { 2026: CONSTANTS_2026 };

export class UnsupportedTaxYearError extends Error {
  constructor(public readonly taxYear: number) {
    super(
      `Tax year ${taxYear} is not supported; constants exist for ${supportedTaxYears().join(", ")}`,
    );
    this.name = "UnsupportedTaxYearError";
  }
}

export function supportedTaxYears(): number[] {
  return Object.keys(BY_YEAR).map(Number);
}

export function getConstants(taxYear: number): TaxConstants {
  const c = BY_YEAR[taxYear];
  if (!c) throw new UnsupportedTaxYearError(taxYear);
  return c;
}

export { CONSTANTS_2026 };
