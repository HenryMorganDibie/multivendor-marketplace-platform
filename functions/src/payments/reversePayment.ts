import { https } from "firebase-functions/v2";
import { db, FieldValue, Timestamp } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { enforceRateLimit } from "../subscriptions/rateLimit";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { applyRevenueDelta } from "./vendorRevenueTotals";
import {
  recomputeInvoiceFromLedger,
  deriveLedgerPaymentStatus,
  readOrderLedgerBaselineInTx,
  LedgerPaymentStatus,
  PaymentType,
} from "./paymentLedger";
import { toMinorUnits } from "../subscriptions/countryPricing";

/**
 * Undoing a payment, without destroying the record of it.
 *
 * A reversal is a row pointing at what it undoes, never a deletion and never an
 * edit to the original amount. The history then shows what was believed and
 * what corrected it, which is what an audit needs and what a vendor needs when
 * a customer disputes a figure months later.
 *
 * Three real cases, one mechanism:
 *
 *   recorded in error  → reversal for the full amount
 *   refunded           → reversal for the refunded amount
 *   wrong amount       → reversal, then a new payment at the right amount
 *
 * The last is deliberately two rows. An edit would leave no trace that the
 * first figure was ever believed, which is exactly the thing that makes
 * financial history worth keeping.
 */

export const reversePayment = https.onCall(async (request) => {
  checkAppCheck(request, "reversePayment");

  if (!request.auth) {
    throw new https.HttpsError("unauthenticated", "Sign in to reverse a payment.");
  }

  await enforceRateLimit(request.auth.uid, "reversePayment", 20);

  const data = (request.data ?? {}) as Record<string, unknown>;
  const paymentId = data.paymentId as string | undefined;
  const reason = (data.reason as string | undefined)?.trim();
  const idempotencyKey = data.idempotencyKey as string | undefined;
  const requestedAmount = data.amountMinorUnits as number | undefined;

  if (!paymentId) throw new https.HttpsError("invalid-argument", "paymentId is required.");
  if (!reason) throw new https.HttpsError("invalid-argument", "A reason is required to reverse a payment.");
  if (!idempotencyKey) throw new https.HttpsError("invalid-argument", "idempotencyKey is required.");

  const originalRef = db.collection("payments").doc(paymentId);

  // Pre-transaction: existence, type, and authorization setup only. Nothing
  // read here is used to compute or validate the reversal amount, the
  // revenue delta, or the order projection below — that all comes from a
  // transaction-fresh read of the same document, per the reasoning in the
  // block comment above the transaction.
  const originalSnap = await originalRef.get();
  if (!originalSnap.exists) throw new https.HttpsError("not-found", "Payment not found.");

  const original = originalSnap.data() ?? {};

  if (original.type === "reversal") {
    throw new https.HttpsError(
      "failed-precondition",
      "A reversal cannot itself be reversed. Record a new payment instead."
    );
  }

  const vendorId = original.vendorId as string;
  const callerRole = request.auth.token.role as string | undefined;
  const callerVendorId = request.auth.token.vendorId as string | undefined;
  const isOwner = callerRole === "vendor" && callerVendorId === vendorId;
  const isAdmin = callerRole === "admin";

  // A customer may dispute a payment, which is a support matter. They may not
  // reverse one: that is a change to the vendor's books.
  if (!isOwner && !isAdmin) {
    throw new https.HttpsError("permission-denied", "Only the vendor or an admin can reverse a payment.");
  }

  const reversalId = `${paymentId}_rev_${idempotencyKey}`.replace(/[/.#$[\]]/g, "_").slice(0, 400);
  const reversalRef = db.collection("payments").doc(reversalId);

  /**
   * The reversal row, the vendor's running total, the original payment's own
   * status, and (for an External Order) its ledger projection all move
   * together, in one transaction.
   *
   * How much of the original payment remains reversible used to be computed
   * before this transaction started (a query plus arithmetic, both closed
   * over as plain variables). That is unsafe under concurrency: two
   * different reversal requests against the same original payment — not
   * retries of each other, genuinely different idempotency keys — could both
   * read "10,000 remaining" before either commits, both pass validation
   * against that same stale number, and both go on to reverse the full
   * amount, understating revenue and, once this transaction also maintains
   * the order projection, driving it negative.
   *
   * Every value the writes below depend on is now read fresh, through tx,
   * inside this callback: the original payment itself, and the prior-
   * reversals query. Firestore's transaction retry — not application code —
   * is what makes two concurrent requests serialize correctly: whichever
   * commits second has its read set invalidated (either the original
   * document, if a full reversal already flipped its status, or the
   * prior-reversals query itself, if a partial reversal added a new matching
   * row) and is retried automatically with fresh reads, the same mechanism
   * recomputeInvoiceFromLedger already relies on for its own ledger query.
   */
  const result = await db.runTransaction(async (tx) => {
    const existing = await tx.get(reversalRef);
    if (existing.exists) return { alreadyReversed: true as const };

    // Transaction-fresh read of the payment being reversed. Everything
    // financial below is derived from THIS snapshot, not from `original`
    // above (which only served existence/type/authorization).
    const originalFreshSnap = await tx.get(originalRef);
    if (!originalFreshSnap.exists) throw new https.HttpsError("not-found", "Payment not found.");
    const originalFresh = originalFreshSnap.data()!;

    // Defensive: a payment's identity fields are never supposed to change
    // after creation (the whole point of this ledger is that nothing is
    // edited). If they somehow differ between the pre-transaction read and
    // this one, that is a data-integrity condition, not an ordinary
    // precondition failure — fail safely rather than reverse against
    // inconsistent refs.
    if (
      originalFresh.vendorId !== original.vendorId ||
      (originalFresh.orderId ?? null) !== (original.orderId ?? null) ||
      (originalFresh.invoiceId ?? null) !== (original.invoiceId ?? null) ||
      originalFresh.amountMinorUnits !== original.amountMinorUnits
    ) {
      throw new https.HttpsError(
        "internal",
        "This payment's recorded details changed unexpectedly. Reversal aborted rather than applied against inconsistent data."
      );
    }

    const freshVendorId = originalFresh.vendorId as string;
    const freshOrderId = (originalFresh.orderId as string | null) ?? null;
    const freshInvoiceId = (originalFresh.invoiceId as string | null) ?? null;
    const originalAmount = (originalFresh.amountMinorUnits as number) ?? 0;

    // Prior reversals, read as a query THROUGH tx — not before the
    // transaction — so a concurrent reversal that commits a new row matching
    // this same filter forces a retry that sees it, instead of this
    // transaction committing against a result set that is already stale.
    const priorReversalsSnap = await tx.get(
      db.collection("payments").where("reversesPaymentId", "==", paymentId)
    );
    const alreadyReversed = priorReversalsSnap.docs.reduce(
      (sum, d) => sum + ((d.data().amountMinorUnits as number) ?? 0),
      0
    );
    const remaining = originalAmount - alreadyReversed;
    const amount = requestedAmount ?? remaining;

    if (!Number.isInteger(amount) || amount <= 0) {
      throw new https.HttpsError("invalid-argument", "The reversal amount must be a positive whole number.");
    }
    if (amount > remaining) {
      throw new https.HttpsError(
        "failed-precondition",
        `Cannot reverse ${amount}: only ${remaining} of this payment remains unreversed.`
      );
    }

    // External Order ledger projection baseline — same helper recordPayment
    // uses, same reasoning: read fresh, reconstruct from the ledger through
    // tx only if the projection field is absent.
    let orderData: FirebaseFirestore.DocumentData | null = null;
    let nextLedgerAmount: number | null = null;
    let nextLedgerStatus: LedgerPaymentStatus | null = null;

    if (freshOrderId) {
      const orderRef = db.collection("orders").doc(freshOrderId);
      const orderSnap = await tx.get(orderRef);
      if (orderSnap.exists) {
        orderData = orderSnap.data()!;
        if (orderData.orderSource === "external") {
          const currentAmount = await readOrderLedgerBaselineInTx(tx, freshVendorId, freshOrderId, orderData);
          nextLedgerAmount = currentAmount - amount;
          const requiredMinorUnits = toMinorUnits(
            (orderData.orderSnapshot?.total as number) ?? 0,
            (orderData.orderSnapshot?.currency as string) ?? (originalFresh.currency as string) ?? "NGN"
          );
          nextLedgerStatus = deriveLedgerPaymentStatus(nextLedgerAmount, requiredMinorUnits);
        }
      }
    }

    // ---- all reads are done; writes only from here ----

    tx.set(reversalRef, {
      paymentId: reversalId,
      vendorId: freshVendorId,
      customerId: originalFresh.customerId ?? null,
      // Positive, and subtracted by its type. A negative amount stored in a
      // financial record is a mistake waiting to be summed wrongly.
      amountMinorUnits: amount,
      currency: originalFresh.currency ?? "NGN",
      orderId: freshOrderId,
      invoiceId: freshInvoiceId,
      method: originalFresh.method ?? "other",
      reference: originalFresh.reference ?? null,
      recordedBy: request.auth!.uid,
      recordedByRole: isAdmin ? "admin" : "vendor",
      type: "reversal" as PaymentType,
      reversesPaymentId: paymentId,
      reversalReason: reason,
      status: "recorded",
      idempotencyKey,
      paidAt: Timestamp.now(),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // A reversal takes back what a payment added.
    applyRevenueDelta(tx, freshVendorId, -amount);

    // The original is marked reversed only when nothing of it remains, so a
    // partial reversal leaves it standing for the rest.
    if (amount === remaining) {
      tx.update(originalRef, { status: "reversed", updatedAt: FieldValue.serverTimestamp() });
    }

    if (freshOrderId && orderData?.orderSource === "external" && nextLedgerAmount !== null) {
      tx.set(
        db.collection("orders").doc(freshOrderId),
        {
          ledgerAmountPaidMinorUnits: nextLedgerAmount,
          ledgerPaymentStatus: nextLedgerStatus,
          lastLedgerActivityAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    return { alreadyReversed: false as const, amount, invoiceId: freshInvoiceId, currency: originalFresh.currency as string | undefined };
  });

  if (result.alreadyReversed) {
    return { success: true, reversalId, alreadyReversed: true };
  }

  if (result.invoiceId) await recomputeInvoiceFromLedger(result.invoiceId);

  await writeAuditLog({
    requestId: newRequestId(),
    functionName: "reversePayment",
    actorUid: request.auth.uid,
    actorRole: isAdmin ? "admin" : "vendor",
    actorType: isAdmin ? "admin" : "vendor",
    targetType: "payment",
    targetId: reversalId,
    eventType: "payment.reversed",
    message: `Reversed ${result.amount} ${result.currency ?? "NGN"} of payment ${paymentId}: ${reason}`,
    appCheck: { present: false, verified: null },
  });

  return { success: true, reversalId, alreadyReversed: false };
});
