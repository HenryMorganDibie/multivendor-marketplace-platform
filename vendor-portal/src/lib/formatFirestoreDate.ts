/**
 * Formats a date that may arrive in any of the shapes a callable can hand back.
 *
 * Firestore Timestamps are not JSON, so they cross the callable boundary as a
 * plain object — and the Admin SDK serializes them with underscore-prefixed
 * keys, `{ _seconds, _nanoseconds }`. Every date on the subscription and
 * invoice screens was checked with `"seconds" in value`, which is false for
 * that shape, so each one silently fell through to the em dash: the
 * subscription page read "Renews on —" for an active, paying vendor, and
 * invoice rows showed no date at all.
 *
 * Both spellings are accepted here, plus ISO strings (what
 * getVendorBillingHistory already returns, having converted server-side) and
 * epoch millis, so a caller never has to know which end did the conversion.
 */
/**
 * Deliberately takes `unknown`. Several of these fields are typed loosely
 * because they come straight off a callable response, and every shape is
 * validated below anyway — accepting `unknown` keeps that validation in one
 * place instead of scattering casts across the call sites.
 */
function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;

  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  if (typeof value === "number" || typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const seconds =
    typeof record.seconds === "number"
      ? record.seconds
      : typeof record._seconds === "number"
        ? record._seconds
        : null;

  if (seconds === null) return null;
  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "12 Aug 2026", or an em dash when there is genuinely no date. */
export function formatFirestoreDate(value: unknown): string {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
