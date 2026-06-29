/** Money and quantities stored as integer minor units (satang, whole hours, etc.). */

export const DEFAULT_CURRENCY = "THB";

export function assertPositiveInt(n: number, label: string) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

export function assertNonNegativeInt(n: number, label: string) {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}
