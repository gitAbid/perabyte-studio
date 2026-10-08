/* ------------------------------------------------------------------ */
/* Money display helpers — minor-unit conversion (spec 17)             */
/* ------------------------------------------------------------------ */
/*
 * The frozen budget kernel speaks minor units (e.g. cents) so money never
 * floats through contracts. Turning a frozen quote's minor-unit estimates
 * into creator-readable main-unit numbers (dollars) is the UI's job — these
 * helpers are the single place the cost preflight does that.
 */

/** Convert frozen minor units (integer cents) into main units (e.g. dollars). */
export function minorUnitsToMain(minor: number): number {
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw new RangeError("minor units must be a nonnegative safe integer");
  }
  return minor / 100;
}

/** Format a main-unit amount for display: "$4.20" for ISO codes, "12.5 Spark" otherwise. */
export function formatMainAmount(amount: number, currency: string): string {
  const rounded = Math.round(amount * 100) / 100;
  if (/^[a-z]{3}$/i.test(currency)) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(rounded);
    } catch {
      // Unrecognized code — fall through to the plain suffix below.
    }
  }
  return `${rounded} ${currency}`;
}
