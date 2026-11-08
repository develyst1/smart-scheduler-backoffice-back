// Money for the pay engine (SPEC-100 §4): integer SATANG in code, `numeric(14,2)` baht in the database. NEVER float arithmetic.
// Converting is done on the decimal STRING, so no value ever passes through a JS float.

const NUMERIC_RE = /^(-?)(\d+)(?:\.(\d{1,2}))?$/; // Postgres numeric(14,2) text: "12345.67", "-5.50", "0", "100.00" (never more than 2 decimals)

/** "12345.67" → 1234567 · "-5.5" → -550 · "100" → 10000. Throws on anything that is not a plain decimal. */
export function satangFromNumeric(text: string): number {
  const m = NUMERIC_RE.exec(text.trim());
  if (!m) throw new Error(`not a numeric amount: ${text}`);
  const [, sign, whole, frac = ""] = m;
  const satang = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(satang)) throw new Error(`amount out of range: ${text}`);
  return sign === "-" ? -satang : satang;
}

/** 1234567 → "12345.67" · -550 → "-5.50". The value to hand to Postgres `numeric(14,2)` and to the CSV. */
export function numericFromSatang(satang: number): string {
  if (!Number.isSafeInteger(satang)) throw new Error(`not an integer satang: ${satang}`);
  const abs = Math.abs(satang);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${satang < 0 ? "-" : ""}${whole}.${frac}`;
}
