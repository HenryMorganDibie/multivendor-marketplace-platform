import { db, FieldValue, Timestamp } from "../admin";

/**
 * Running revenue totals, maintained rather than recomputed.
 *
 * getVendorRevenue read every payment row a vendor had ever received on each
 * dashboard open — no limit, no date bound. Invisible at two hundred rows and a
 * memory-limited function at fifty thousand, which means it degrades at exactly
 * the point a vendor becomes valuable.
 *
 * A limit() would have been the wrong fix: a truncated revenue figure is worse
 * than a slow correct one, because it is wrong without looking wrong. So the
 * total is maintained instead. Every ledger row already passes through one of
 * two functions, and each knows its own delta, so the figure can be moved by
 * that delta at the moment the row is written.
 *
 * The increment happens inside the same transaction that creates the payment
 * row. That matters more than it looks: the row id is derived from the caller's
 * idempotency key, so a retry writes the same document — but an increment
 * outside a transaction would apply twice and inflate revenue on every retry.
 * Creating the row and moving the total together makes a retry a no-op for
 * both.
 *
 * The stored figure is a cache of the rows, never the source of truth. The rows
 * remain canonical, and rebuildVendorRevenueTotal recomputes from them.
 */

export interface RevenueTotals {
  revenueTotalMinorUnits: number;
  revenueUpdatedAt: Timestamp | null;
}

/**
 * Applies a ledger delta to a vendor's running total inside an existing
 * transaction.
 *
 * Positive for a payment, negative for a reversal. The caller decides the sign,
 * because only it knows which kind of row it is writing.
 */
export function applyRevenueDelta(
  tx: FirebaseFirestore.Transaction,
  vendorId: string,
  deltaMinorUnits: number,
): void {
  tx.set(
    db.collection("vendors").doc(vendorId),
    {
      revenueTotalMinorUnits: FieldValue.increment(deltaMinorUnits),
      revenueUpdatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/**
 * Recomputes a vendor's total from the rows.
 *
 * For the backfill, and for repair if a total is ever doubted. This is the one
 * place a full scan of a vendor's payments is correct — it runs deliberately,
 * not on a screen open.
 */
export async function rebuildVendorRevenueTotal(vendorId: string): Promise<number> {
  const snap = await db.collection("payments").where("vendorId", "==", vendorId).get();

  const total = snap.docs.reduce((sum, d) => {
    const amount = (d.data().amountMinorUnits as number) ?? 0;
    // A reversal is stored as a positive amount and subtracted by type, so the
    // history reads as what happened rather than as a negative number.
    return d.data().type === "reversal" ? sum - amount : sum + amount;
  }, 0);

  await db.collection("vendors").doc(vendorId).set(
    { revenueTotalMinorUnits: total, revenueUpdatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );

  return total;
}

/**
 * Reads the cached total, rebuilding it once if it has never been set.
 *
 * A vendor whose payments predate this field would otherwise read zero, and
 * showing a trading vendor no revenue is worse than one slow first call. After
 * that rebuild the field exists and the fast path applies. `null` is the "never
 * computed" signal — 0 is a real total for a vendor who has taken no money, and
 * conflating the two would rebuild on every call for every new vendor.
 */
export async function readVendorRevenueTotal(vendorId: string): Promise<number> {
  const snap = await db.collection("vendors").doc(vendorId).get();
  const cached = snap.data()?.revenueTotalMinorUnits;

  if (typeof cached === "number") return cached;

  return rebuildVendorRevenueTotal(vendorId);
}
