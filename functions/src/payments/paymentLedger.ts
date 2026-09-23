import { https } from "firebase-functions/v2";
import { db, FieldValue, Timestamp } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { applyRevenueDelta } from "./vendorRevenueTotals";
import { enforceRateLimit } from "../subscriptions/rateLimit";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { resolveEffectivePlan } from "../subscriptions/resolveEffectivePlan";
import { filterBrandingByPlan } from "../invoices/invoicePdf";
import { InvoiceBrandingDoc } from "../types4";
import { toMinorUnits } from "../subscriptions/countryPricing";

/**
 * The payment ledger.
 *
 * One record of money received, replacing two lists with a rule about which to
 * ignore. An invoice and an order could each record the same payment, and
 * revenue avoided double-counting by skipping any invoice carrying an orderId —
 * a workaround that worked, but meant the two sides never had to agree, and
 * could not express a partial payment at all, because status was a field
 * somebody set rather than a conclusion drawn from what was received.
 *
 * Every amount here is integer minor units. Decimals in money are where
 * rounding bugs live, and this matches subscriptionPricing.
 *
 * Nothing is ever deleted and no amount is ever edited. A correction is a
 * reversal row pointing at what it undoes; the original stays readable forever.
 * A reversal carries a positive amount and is subtracted by its type, because a
 * negative number sitting in a financial record is a mistake waiting to be
 * summed wrongly.
 */

export type PaymentMethod = "cash" | "transfer" | "card" | "other";
export type PaymentType = "payment" | "reversal";

const VALID_METHODS: PaymentMethod[] = ["cash", "transfer", "card", "other"];

/**
 * The document id is derived from the caller's idempotency key rather than
 * generated, so a retry writes to the same document instead of creating a
 * second one. Scoped by vendor so two vendors cannot collide on a key.
 */
function paymentIdFor(vendorId: string, idempotencyKey: string): string {
  const safe = `${vendorId}_${idempotencyKey}`.replace(/[/.#$[\]]/g, "_");
  return safe.slice(0, 400);
}

/** Derives an invoice's status from its ledger. Status is never set by hand. */
export function deriveInvoiceStatus(
  totalMinorUnits: number,
  paidMinorUnits: number,
  cancelled: boolean
): "unpaid" | "partial" | "paid" | "overpaid" | "cancelled" {
  if (cancelled) return "cancelled";
  if (paidMinorUnits === 0) return "unpaid";
  const balance = totalMinorUnits - paidMinorUnits;
  if (balance < 0) return "overpaid";
  if (balance === 0) return "paid";
  return "partial";
}

/**
 * Sums a ledger. Reversals subtract, so the total is what the vendor actually
 * holds rather than what was ever recorded.
 */
export function sumLedger(rows: { amountMinorUnits: number; type: PaymentType }[]): number {
  return rows.reduce(
    (total, row) => total + (row.type === "reversal" ? -row.amountMinorUnits : row.amountMinorUnits),
    0
  );
}

/**
 * External Orders only. Separate from deriveInvoiceStatus/deriveOrderStatus:
 * an order has no "cancelled" ledger state of its own (order.status already
 * carries that), so this only ever distinguishes how much has actually been
 * recorded relative to what is owed.
 */
export type LedgerPaymentStatus = "unpaid" | "partial" | "paid" | "overpaid";

export function deriveLedgerPaymentStatus(
  paidMinorUnits: number,
  requiredMinorUnits: number
): LedgerPaymentStatus {
  if (paidMinorUnits <= 0) return "unpaid";
  if (paidMinorUnits < requiredMinorUnits) return "partial";
  if (paidMinorUnits === requiredMinorUnits) return "paid";
  return "overpaid";
}

/**
 * The order-payment-projection baseline, read inside an existing
 * transaction. Trusts a present ledgerAmountPaidMinorUnits as-is (the cheap
 * path — no extra query); reconstructs it from the ledger only when the
 * field is absent (a historical order predating this feature), and does so
 * via tx.get on the query itself so a concurrent write to this order's
 * ledger forces a retry rather than committing against a stale sum — the
 * same reasoning recomputeInvoiceFromLedger already relies on above.
 *
 * Must be called with all of the caller's other tx.get() reads already
 * done that need to precede it, and before any writes in that transaction.
 */
export async function readOrderLedgerBaselineInTx(
  tx: FirebaseFirestore.Transaction,
  vendorId: string,
  orderId: string,
  orderData: FirebaseFirestore.DocumentData
): Promise<number> {
  if (typeof orderData.ledgerAmountPaidMinorUnits === "number") {
    return orderData.ledgerAmountPaidMinorUnits;
  }
  const ledgerSnap = await tx.get(
    db.collection("payments").where("vendorId", "==", vendorId).where("orderId", "==", orderId)
  );
  return sumLedger(
    ledgerSnap.docs.map((d) => ({
      amountMinorUnits: d.data().amountMinorUnits as number,
      type: d.data().type as PaymentType,
    }))
  );
}

/** Order statuses a vendor may record a new External Order payment against. */
export const RECORDABLE_EXTERNAL_ORDER_STATUSES = ["accepted", "confirmed", "in_progress", "completed"];

/**
 * Repairs (or lazily backfills) an External Order's ledger projection by
 * recomputing it from scratch, the same way rebuildVendorRevenueTotal
 * repairs the vendor revenue cache. Not on the recordPayment/reversePayment
 * hot path — those trust a present projection field and only fall back to
 * reconstruction inside their own transaction when it's missing. This is
 * for explicit repair (e.g. drift, or an admin action), safe to call any
 * number of times.
 */
export async function rebuildOrderPaymentProjection(orderId: string): Promise<void> {
  const orderRef = db.collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) return;
  const order = orderSnap.data()!;
  if (order.orderSource !== "external") return;

  const ledgerSnap = await db
    .collection("payments")
    .where("vendorId", "==", order.vendorId)
    .where("orderId", "==", orderId)
    .get();

  const rows = ledgerSnap.docs.map((d) => ({
    amountMinorUnits: d.data().amountMinorUnits as number,
    type: d.data().type as PaymentType,
    paidAt: d.data().paidAt as Timestamp | undefined,
  }));
  const paid = sumLedger(rows);
  const requiredMinorUnits = toMinorUnits(
    (order.orderSnapshot?.total as number) ?? 0,
    (order.orderSnapshot?.currency as string) ?? "NGN"
  );

  // "Last activity" is a property of the rows, not of when the cache
  // happened to be rebuilt — so this takes the latest paidAt among them
  // rather than stamping "now".
  const lastActivityAt = rows.reduce<Timestamp | null>((latest, row) => {
    if (!row.paidAt) return latest;
    return !latest || row.paidAt.toMillis() > latest.toMillis() ? row.paidAt : latest;
  }, null);

  await orderRef.set(
    {
      ledgerAmountPaidMinorUnits: paid,
      ledgerPaymentStatus: deriveLedgerPaymentStatus(paid, requiredMinorUnits),
      lastLedgerActivityAt: lastActivityAt,
    },
    { merge: true }
  );
}

/**
 * Recomputes an invoice's cached paid amount, balance and status from its
 * ledger, inside a transaction so two payments landing together cannot both
 * read the same stale total.
 */
export async function recomputeInvoiceFromLedger(invoiceId: string): Promise<void> {
  const invoiceRef = db.collection("invoices").doc(invoiceId);
  const preRead = await invoiceRef.get();
  const vendorId = preRead.data()?.vendorId as string | undefined;

  // Read before the transaction: a transaction may not read after its first
  // write, and this is only needed when the invoice settles.
  let brandingSnapshot: unknown = null;
  if (vendorId && !preRead.data()?.brandingSnapshot) {
    const { limits } = await resolveEffectivePlan(vendorId);
    const branding = (await db.collection("invoiceBranding").doc(vendorId).get()).data() as
      | InvoiceBrandingDoc
      | undefined;
    brandingSnapshot = filterBrandingByPlan(branding, limits);
  }

  const ledgerQuery = db.collection("payments").where("invoiceId", "==", invoiceId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(invoiceRef);
    if (!snap.exists) return;
    const data = snap.data() ?? {};

    /**
     * The ledger is summed inside the transaction, deliberately.
     *
     * It used to be queried above this block and the total closed over. That
     * looked safe because the transaction still read and wrote the invoice, so
     * Firestore would retry on a conflict — but a retry re-runs this body with
     * the total captured the first time. Two payments recorded at once could
     * therefore both compute their own total and the later write would install
     * a figure that never included the other, leaving the cached amount and
     * status disagreeing with the rows.
     *
     * Reading the query through tx makes the payment rows part of what the
     * transaction guards, so a concurrent write forces a retry that re-sums
     * them. The rows were always canonical; this makes the cache on the
     * invoice honest about them under concurrency.
     */
    const ledger = await tx.get(ledgerQuery);
    const paid = sumLedger(
      ledger.docs.map((d) => ({
        amountMinorUnits: d.data().amountMinorUnits as number,
        type: d.data().type as PaymentType,
      }))
    );

    // subtotal is the invoice total in minor units.
    const total = (data.subtotal as number) ?? 0;
    const cancelled = data.status === "cancelled";
    const status = deriveInvoiceStatus(total, paid, cancelled);

    // paidAt marks the moment the balance first reached zero, so it is set once
    // and not moved by a later payment or reversal.
    const alreadyPaidAt = data.paidAt ?? null;
    const reachedZeroNow = status === "paid" || status === "overpaid";

    const updates: Record<string, unknown> = {
      status,
      amountPaidMinorUnits: paid,
      balanceMinorUnits: total - paid,
      lastPaymentAt: ledger.empty ? null : Timestamp.now(),
      paidAt: reachedZeroNow ? (alreadyPaidAt ?? Timestamp.now()) : null,
      updatedAt: FieldValue.serverTimestamp(),
    };

    // Branding is frozen the first time an invoice settles, so a receipt keeps
    // the look it had when it was paid even if the vendor rebrands or changes
    // plan afterwards. This used to happen where "paid" was written by hand;
    // the ledger decides settlement now, so it belongs here. Snapshotted once
    // only: a later reversal and re-payment must not restyle history.
    if (reachedZeroNow && !data.brandingSnapshot && brandingSnapshot) {
      updates.brandingSnapshot = brandingSnapshot;
    }

    tx.update(invoiceRef, updates);
  });
}

/**
 * recordPayment — writes money received.
 *
 * Idempotent: the same key returns the existing row and reports success, so a
 * client that retried after a dropped connection is not told it failed.
 */
export const recordPayment = https.onCall(async (request) => {
  checkAppCheck(request, "recordPayment");

  if (!request.auth) {
    throw new https.HttpsError("unauthenticated", "Sign in to record a payment.");
  }

  await enforceRateLimit(request.auth.uid, "recordPayment", 30);

  const data = (request.data ?? {}) as Record<string, unknown>;
  const invoiceId = (data.invoiceId as string | undefined) ?? null;
  const orderId = (data.orderId as string | undefined) ?? null;
  const amountMinorUnits = data.amountMinorUnits as number;
  const method = (data.method as PaymentMethod) ?? "other";
  const idempotencyKey = data.idempotencyKey as string | undefined;

  if (!invoiceId && !orderId) {
    throw new https.HttpsError("invalid-argument", "A payment must reference an invoice or an order.");
  }
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new https.HttpsError(
      "invalid-argument",
      "amountMinorUnits must be a positive whole number of minor units."
    );
  }
  if (!VALID_METHODS.includes(method)) {
    throw new https.HttpsError("invalid-argument", `method must be one of ${VALID_METHODS.join(", ")}.`);
  }
  if (!idempotencyKey) {
    throw new https.HttpsError("invalid-argument", "idempotencyKey is required.");
  }

  // The vendor is resolved from whatever the payment is against, never taken
  // from the request: a caller must not be able to write a payment into
  // somebody else's ledger.
  let vendorId: string | null = null;
  let customerId: string | null = null;
  let resolvedOrderId = orderId;
  let currency = "NGN";

  if (invoiceId) {
    const invoiceSnap = await db.collection("invoices").doc(invoiceId).get();
    if (!invoiceSnap.exists) throw new https.HttpsError("not-found", "Invoice not found.");
    const invoice = invoiceSnap.data() ?? {};
    vendorId = invoice.vendorId as string;
    customerId = (invoice.customerId as string | undefined) ?? null;
    currency = (invoice.currency as string) ?? "NGN";
    // An invoice raised from an order carries that order, and the payment
    // inherits it. This is what makes the same money count once however it was
    // recorded.
    resolvedOrderId = (invoice.orderId as string | undefined) ?? orderId;
  } else if (orderId) {
    const orderSnap = await db.collection("orders").doc(orderId).get();
    if (!orderSnap.exists) throw new https.HttpsError("not-found", "Order not found.");
    const order = orderSnap.data() ?? {};
    vendorId = order.vendorId as string;
    customerId = (order.customerId as string | undefined) ?? null;
    currency = (order.orderSnapshot?.currency as string) ?? "NGN";
  }

  if (!vendorId) {
    throw new https.HttpsError("failed-precondition", "Could not resolve the vendor for this payment.");
  }

  // Only the vendor who owns it, or an admin, may record against it.
  const callerRole = request.auth.token.role as string | undefined;
  const callerVendorId = request.auth.token.vendorId as string | undefined;
  const isOwner = callerRole === "vendor" && callerVendorId === vendorId;
  const isAdmin = callerRole === "admin";
  if (!isOwner && !isAdmin) {
    throw new https.HttpsError("permission-denied", "This is not your invoice.");
  }

  const paymentId = paymentIdFor(vendorId, idempotencyKey);
  const paymentRef = db.collection("payments").doc(paymentId);
  const orderRef = resolvedOrderId ? db.collection("orders").doc(resolvedOrderId) : null;

  /**
   * The row, the vendor's running total, and (for an External Order) its
   * ledger projection all move together, in one transaction.
   *
   * The row id is derived from the caller's idempotency key, so a retry writes
   * the same document — harmless on its own. An increment applied outside a
   * transaction would not be: it would apply again on every retry and inflate
   * revenue. Creating the row and moving the totals atomically makes a retry a
   * no-op for all of them.
   *
   * The order is re-read here via tx.get, not reused from the vendor/currency
   * resolution above — that earlier read happens before the transaction and
   * is not safe to build a financial write from under concurrency. Status
   * eligibility, the ledger baseline, and orderSnapshot.total all come from
   * this transaction-fresh read.
   */
  const alreadyRecorded = await db.runTransaction(async (tx) => {
    const existing = await tx.get(paymentRef);
    if (existing.exists) {
      // A retry, not a duplicate. Reporting failure here would push a client
      // into recording the same money twice by hand.
      return true;
    }

    let orderData: FirebaseFirestore.DocumentData | null = null;
    let nextLedgerAmount: number | null = null;
    let nextLedgerStatus: LedgerPaymentStatus | null = null;

    if (orderRef) {
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) throw new https.HttpsError("not-found", "Order not found.");
      orderData = orderSnap.data()!;

      // External Orders only: internal orders keep today's behavior exactly
      // — no status gate, no ledger projection — since recordPayment is
      // shared code and this feature is scoped to External Orders.
      if (orderData.orderSource === "external") {
        if (!RECORDABLE_EXTERNAL_ORDER_STATUSES.includes(orderData.status as string)) {
          throw new https.HttpsError(
            "failed-precondition",
            `Cannot record a payment while the order is "${orderData.status}".`
          );
        }

        const currentAmount = await readOrderLedgerBaselineInTx(tx, vendorId as string, resolvedOrderId as string, orderData);
        nextLedgerAmount = currentAmount + amountMinorUnits;
        const requiredMinorUnits = toMinorUnits(
          (orderData.orderSnapshot?.total as number) ?? 0,
          (orderData.orderSnapshot?.currency as string) ?? currency
        );
        nextLedgerStatus = deriveLedgerPaymentStatus(nextLedgerAmount, requiredMinorUnits);
      }
    }

    // ---- all reads are done; writes only from here ----

    tx.set(paymentRef, {
      paymentId,
      vendorId,
      customerId,
      amountMinorUnits,
      currency,
      orderId: resolvedOrderId,
      invoiceId,
      method,
      reference: (data.reference as string | undefined) ?? null,
      recordedBy: request.auth!.uid,
      recordedByRole: isAdmin ? "admin" : "vendor",
      type: "payment" as PaymentType,
      reversesPaymentId: null,
      reversalReason: null,
      status: "recorded",
      idempotencyKey,
      paidAt: data.paidAt ? Timestamp.fromMillis(Number(data.paidAt)) : Timestamp.now(),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // A payment adds to what the vendor has taken.
    applyRevenueDelta(tx, vendorId as string, amountMinorUnits);

    if (orderRef && orderData?.orderSource === "external" && nextLedgerAmount !== null) {
      tx.set(
        orderRef,
        {
          ledgerAmountPaidMinorUnits: nextLedgerAmount,
          ledgerPaymentStatus: nextLedgerStatus,
          lastLedgerActivityAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    return false;
  });

  if (alreadyRecorded) {
    return { success: true, paymentId, alreadyRecorded: true };
  }

  if (invoiceId) await recomputeInvoiceFromLedger(invoiceId);

  await writeAuditLog({
    requestId: newRequestId(),
    functionName: "recordPayment",
    actorUid: request.auth.uid,
    actorRole: isAdmin ? "admin" : "vendor",
    actorType: isAdmin ? "admin" : "vendor",
    targetType: "payment",
    targetId: paymentId,
    eventType: "payment.recorded",
    message: `Recorded ${amountMinorUnits} ${currency} against ${invoiceId ? `invoice ${invoiceId}` : `order ${resolvedOrderId}`}.`,
    appCheck: { present: false, verified: null },
  });

  return { success: true, paymentId, alreadyRecorded: false };
});
