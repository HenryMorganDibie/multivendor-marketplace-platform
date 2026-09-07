import { https } from "firebase-functions/v2";
import { db, FieldValue, Timestamp } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { enforceRateLimit } from "../subscriptions/rateLimit";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { applyRevenueDelta } from "./vendorRevenueTotals";
import { recomputeInvoiceFromLedger } from "./paymentLedger";

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

  // How much of this payment is still standing. A payment may be reversed more
  // than once, partially, up to its original amount — a vendor refunding half
  // and later the rest is ordinary.
  const priorReversals = await db
    .collection("payments")
    .where("reversesPaymentId", "==", paymentId)
    .get();

  const alreadyReversed = priorReversals.docs.reduce(
    (sum, d) => sum + ((d.data().amountMinorUnits as number) ?? 0),
    0
  );

  const originalAmount = (original.amountMinorUnits as number) ?? 0;
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

  const reversalId = `${paymentId}_rev_${idempotencyKey}`.replace(/[/.#$[\]]/g, "_").slice(0, 400);
  const reversalRef = db.collection("payments").doc(reversalId);

  /**
   * The reversal row and the vendor's running total move together, for the same
   * reason recordPayment does it: the row id is derived from the idempotency
   * key, so a retry writes the same document, but an increment applied outside
   * a transaction would apply again and understate revenue on every retry.
   */
  const wasAlreadyRecorded = await db.runTransaction(async (tx) => {
    const existing = await tx.get(reversalRef);
    if (existing.exists) return true;

    tx.set(reversalRef, {
      paymentId: reversalId,
      vendorId,
      customerId: original.customerId ?? null,
      // Positive, and subtracted by its type. A negative amount stored in a
      // financial record is a mistake waiting to be summed wrongly.
      amountMinorUnits: amount,
      currency: original.currency ?? "NGN",
      orderId: original.orderId ?? null,
      invoiceId: original.invoiceId ?? null,
      method: original.method ?? "other",
      reference: original.reference ?? null,
      recordedBy: request.auth!.uid,
      recordedByRole: isAdmin ? "admin" : "vendor",
      type: "reversal",
      reversesPaymentId: paymentId,
      reversalReason: reason,
      status: "recorded",
      idempotencyKey,
      paidAt: Timestamp.now(),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // A reversal takes back what a payment added.
    applyRevenueDelta(tx, vendorId, -amount);

    // The original is marked reversed only when nothing of it remains, so a
    // partial reversal leaves it standing for the rest. Inside the transaction
    // so the row, the total and the original's status all land together.
    if (amount === remaining) {
      tx.update(originalRef, { status: "reversed", updatedAt: FieldValue.serverTimestamp() });
    }
    return false;
  });

  if (wasAlreadyRecorded) {
    return { success: true, reversalId, alreadyReversed: true };
  }

  if (original.invoiceId) await recomputeInvoiceFromLedger(original.invoiceId as string);

  await writeAuditLog({
    requestId: newRequestId(),
    functionName: "reversePayment",
    actorUid: request.auth.uid,
    actorRole: isAdmin ? "admin" : "vendor",
    actorType: isAdmin ? "admin" : "vendor",
    targetType: "payment",
    targetId: reversalId,
    eventType: "payment.reversed",
    message: `Reversed ${amount} ${original.currency ?? "NGN"} of payment ${paymentId}: ${reason}`,
    appCheck: { present: false, verified: null },
  });

  return { success: true, reversalId, alreadyReversed: false };
});
