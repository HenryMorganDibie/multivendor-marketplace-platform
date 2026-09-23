import { createHash } from "crypto";
import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { enforceRateLimit } from "../subscriptions/rateLimit";
import { OrderDoc, PaymentRequestDoc, PaymentRequestStatus } from "../types2";
import { PaymentDestination, PaymentInstructionsCurrentDoc } from "../types5";

const MAX_MESSAGE_LENGTH = 200;

// Order states a vendor may still ask to be paid against. Matches the
// "unpaid/active order" gate already used by the mobile app's own
// unpaidOrders filter (send-payment-request/[orderId].tsx) and the pinned
// payment card logic in vendor/chats/[orderId].tsx (shouldShowPinnedCard):
// requested orders haven't been accepted yet, and completed/rejected/
// cancelled/expired orders are all terminal.
const PAYABLE_ORDER_STATUSES = ["accepted", "confirmed", "in_progress"];

function normalizeCurrencyCode(raw: unknown): string | null {
  const trimmed = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return trimmed ? trimmed : null;
}

interface CanonicalSendPaymentRequestPayload {
  orderId: string;
  chatId: string;
  amount: number;
  message: string | null;
}

function hashPayload(payload: CanonicalSendPaymentRequestPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Reads and validates vendors/{vendorId}/paymentInstructionsCurrent/current
 * itself -- this callable never accepts destination data from the client.
 * Mirrors setVendorPaymentInstructions's own valid-state invariant (a
 * destination or Cash, never neither) rather than re-trusting that a
 * document merely existing implies it is well-formed: the rules deny direct
 * client writes to this collection, but a payment-request path is exactly
 * the wrong place to assume that invariant blindly if it were ever violated
 * by some future code path.
 */
function validateCanonicalPaymentInstructions(
  doc: PaymentInstructionsCurrentDoc | undefined,
): { paymentDestination: PaymentDestination | null; acceptCash: boolean } {
  if (!doc) {
    throw new https.HttpsError(
      "failed-precondition",
      "Set up your payment instructions before sending a payment request.",
    );
  }
  // Defensive: paymentInstructionsVersion/paymentInstructionsRecordId below
  // are snapshotted straight from these two fields with no coercion or
  // fallback -- a malformed value here must fail closed before any write,
  // not silently become undefined on the request document.
  if (typeof doc.currentVersion !== "number" || !Number.isFinite(doc.currentVersion) || !Number.isInteger(doc.currentVersion) || doc.currentVersion <= 0) {
    throw new https.HttpsError(
      "failed-precondition",
      "Your payment instructions are missing required information. Please review them in Settings.",
    );
  }
  if (typeof doc.currentRecordId !== "string" || !doc.currentRecordId.trim()) {
    throw new https.HttpsError(
      "failed-precondition",
      "Your payment instructions are missing required information. Please review them in Settings.",
    );
  }
  const acceptCash = doc.acceptCash === true;
  const paymentDestination = doc.paymentDestination ?? null;
  if (paymentDestination === null && !acceptCash) {
    throw new https.HttpsError(
      "failed-precondition",
      "Your payment instructions are not in a valid state. Please review them in Settings.",
    );
  }
  if (paymentDestination !== null) {
    if (paymentDestination.type !== "bank_transfer" && paymentDestination.type !== "contact_transfer") {
      throw new https.HttpsError(
        "failed-precondition",
        "Your payment instructions are not in a valid state. Please review them in Settings.",
      );
    }
    if (typeof paymentDestination.currencyCode !== "string" || !paymentDestination.currencyCode.trim()) {
      throw new https.HttpsError(
        "failed-precondition",
        "Your payment instructions are missing required information. Please review them in Settings.",
      );
    }
  }
  return { paymentDestination, acceptCash };
}

type TransactionResult =
  | { requestId: string; messageId: string; changed: false }
  | {
      requestId: string;
      messageId: string;
      changed: true;
      currency: string;
      paymentInstructionsVersion: number;
    };

/**
 * sendPaymentRequestInChat.
 *
 * Reads the vendor's canonical structured Payment Instructions
 * (vendors/{vendorId}/paymentInstructionsCurrent/current, Batch 2B/2C.2)
 * itself, server-side, and snapshots the exact destination/cash
 * configuration that applied at send time onto the immutable
 * paymentRequests/{requestId} document -- never re-read live afterward, so
 * a later Payment Instructions edit cannot silently rewrite what a customer
 * was already shown. The raw structured destination (account number, IBAN,
 * routing, SWIFT/BIC, contact email/phone) lives ONLY on that document; the
 * chat message's paymentRequestData carries just enough metadata (amount,
 * currency, requestId, the vendor's note) to render the collapsed chat
 * shell and look up the canonical document -- never a duplicate copy of the
 * destination itself.
 *
 * Idempotency: one logical "send" operation is identified by a
 * client-generated idempotencyKey, recorded at
 * vendors/{vendorId}/paymentRequestIdempotency/{idempotencyKey} (fully
 * internal -- Firestore rules deny all client access). A retry with the
 * same key and the same canonical payload (orderId/chatId/amount/message)
 * replays the original result with zero additional writes; a retry with
 * the same key but a different payload is rejected outright.
 *
 * Order-level serialization: order.activePaymentRequestId is the
 * deterministic pointer to whichever paymentRequests document is currently
 * "active"/"resent" for that order. Reading and writing this field inside
 * the same transaction as request creation is what makes two concurrent,
 * genuinely different Send Payment Request attempts for the same order
 * (two different idempotency keys) serialize correctly through Firestore's
 * transaction conflict detection on that one shared document, rather than
 * relying solely on query-based transaction semantics. Orders created
 * before this field existed simply have no pointer yet; the first
 * structured request for such an order falls back to the legacy
 * status-based query (orderId == X, status in [active, resent]) to find
 * and supersede whatever was active before, then populates the pointer
 * going forward.
 */
export const sendPaymentRequestInChat = https.onCall(async (request) => {
  await enforceRateLimit(
    request.auth?.uid ?? `ip:${request.rawRequest?.ip ?? "unknown"}`,
    "sendPaymentRequestInChat",
    30,
  );
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "sendPaymentRequestInChat");

  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string | undefined;
  if (!vendorId) {
    throw new https.HttpsError("failed-precondition", "Vendor ID could not be determined.");
  }

  const { orderId, chatId, amount, message, idempotencyKey } = (request.data ?? {}) as {
    orderId?: string;
    chatId?: string;
    amount?: number;
    message?: string;
    idempotencyKey?: string;
  };
  if (!orderId) throw new https.HttpsError("invalid-argument", "orderId is required.");
  if (!chatId) throw new https.HttpsError("invalid-argument", "chatId is required.");
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    throw new https.HttpsError("invalid-argument", "amount must be a positive number.");
  }
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    throw new https.HttpsError("invalid-argument", "idempotencyKey is required.");
  }
  const trimmedMessage = typeof message === "string" ? message.trim() : "";
  if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
    throw new https.HttpsError("invalid-argument", `message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`);
  }
  const normalizedMessage = trimmedMessage || null;

  // Fingerprints the canonical, already-validated mutation -- the exact
  // numeric amount that passed validation above and the same
  // trim-then-null-coalesce message value that will actually be stored,
  // not raw pre-validation client text. No new normalization is invented
  // here beyond what the validation above already computes.
  const canonicalPayload: CanonicalSendPaymentRequestPayload = {
    orderId,
    chatId,
    amount,
    message: normalizedMessage,
  };
  const payloadHash = hashPayload(canonicalPayload);

  const orderRef = db.collection("orders").doc(orderId);
  const threadRef = db.collection("chatThreads").doc(chatId);
  const currentInstructionsRef = db
    .collection("vendors")
    .doc(vendorId)
    .collection("paymentInstructionsCurrent")
    .doc("current");
  const idemRef = db
    .collection("vendors")
    .doc(vendorId)
    .collection("paymentRequestIdempotency")
    .doc(idempotencyKey);

  const result = await db.runTransaction<TransactionResult>(async (tx) => {
    // ---- all reads first ----
    const idemSnap = await tx.get(idemRef);
    if (idemSnap.exists) {
      const cached = idemSnap.data()!;
      if (cached.payloadHash !== payloadHash) {
        throw new https.HttpsError(
          "invalid-argument",
          "This idempotency key was already used for a different payment request. Use a new key.",
        );
      }
      // A retry, not a duplicate -- zero mutation, and critically does not
      // re-run (or re-trigger) the supersede-prior-request logic a second
      // time for what is the SAME logical request.
      return { requestId: cached.requestId as string, messageId: cached.messageId as string, changed: false };
    }

    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new https.HttpsError("not-found", "Order not found.");
    const order = orderSnap.data() as OrderDoc;

    if (order.vendorId !== vendorId) {
      throw new https.HttpsError("permission-denied", "You do not own this order.");
    }
    if (!PAYABLE_ORDER_STATUSES.includes(order.status)) {
      throw new https.HttpsError(
        "failed-precondition",
        `A payment request cannot be sent for an order in status "${order.status}".`,
      );
    }
    if (order.paymentStatus === "PROOF_ACCEPTED") {
      throw new https.HttpsError("failed-precondition", "This order has already been paid in full.");
    }

    // No partial-payment ledger exists on the live order schema (OrderDoc
    // has no amountPaid/balance field -- only orderSnapshot.total and the
    // binary-ish paymentStatus enum) so the order's full total is the only
    // real "outstanding balance" figure there is to validate against.
    const orderTotal = order.orderSnapshot?.total ?? 0;
    if (amount > orderTotal) {
      throw new https.HttpsError(
        "invalid-argument",
        `amount cannot exceed the order total of ${orderTotal}.`,
      );
    }

    const threadSnap = await tx.get(threadRef);
    if (!threadSnap.exists) throw new https.HttpsError("not-found", "Conversation not found.");
    const thread = threadSnap.data() ?? {};

    if (thread.vendorId !== vendorId) {
      throw new https.HttpsError("permission-denied", "You are not a participant in this conversation.");
    }
    // ChatThreadDoc has no singular `orderId` field -- a commerce thread is
    // per (customerId, vendorId), not per order, and accumulates every
    // order ever placed in it under relatedOrderIds. That array is the
    // real cross-check.
    const relatedOrderIds = Array.isArray(thread.relatedOrderIds) ? (thread.relatedOrderIds as string[]) : [];
    if (relatedOrderIds.length > 0 && !relatedOrderIds.includes(orderId)) {
      throw new https.HttpsError("permission-denied", "This order does not belong to this conversation.");
    }

    const currentSnap = await tx.get(currentInstructionsRef);
    const currentDoc = currentSnap.exists ? (currentSnap.data() as PaymentInstructionsCurrentDoc) : undefined;
    const { paymentDestination, acceptCash } = validateCanonicalPaymentInstructions(currentDoc);

    // Cross-currency structured Payment Requests are out of v1: the
    // destination's own currency (server-derived at Payment Instructions
    // save time) must match the order's authoritative currency exactly, or
    // the request is rejected outright rather than silently converting or
    // showing two currencies. Cash-only destinations skip this comparison
    // entirely -- the request currency is simply the order's currency.
    const orderCurrency = normalizeCurrencyCode(order.orderSnapshot?.currency);
    if (!orderCurrency) {
      throw new https.HttpsError(
        "failed-precondition",
        "This order has no valid currency and cannot be used for a structured payment request.",
      );
    }
    if (paymentDestination !== null) {
      const destinationCurrency = normalizeCurrencyCode(paymentDestination.currencyCode);
      if (destinationCurrency !== orderCurrency) {
        throw new https.HttpsError(
          "failed-precondition",
          "Your payment destination currency does not match this order's currency. Update your payment instructions before sending this request.",
        );
      }
    }
    const requestCurrency = orderCurrency;

    const customerId = order.customerId ?? thread.customerId ?? null;
    if (!customerId) {
      throw new https.HttpsError("failed-precondition", "This order has no customer to send a payment request to.");
    }

    // Prior-active-request discovery: prefer the order's own pointer when
    // present (the deterministic serialization point for concurrent
    // different-key attempts on this order); fall back to the legacy
    // status-based query only for an order that has never had a structured
    // request created against it yet.
    let priorActiveRefs: FirebaseFirestore.DocumentReference[] = [];
    if (order.activePaymentRequestId) {
      const pointerRef = db.collection("paymentRequests").doc(order.activePaymentRequestId);
      const pointerSnap = await tx.get(pointerRef);
      if (pointerSnap.exists) {
        const pointerData = pointerSnap.data() as PaymentRequestDoc;
        if (pointerData.status === "active" || pointerData.status === "resent") {
          priorActiveRefs = [pointerRef];
        }
      }
    } else {
      const legacyQuery = db
        .collection("paymentRequests")
        .where("orderId", "==", orderId)
        .where("status", "in", ["active", "resent"] as PaymentRequestStatus[]);
      const legacySnap = await tx.get(legacyQuery);
      priorActiveRefs = legacySnap.docs.map((doc) => doc.ref);
    }

    // ---- writes from here ----
    const now = FieldValue.serverTimestamp();
    const newRequestRef = db.collection("paymentRequests").doc();
    const msgRef = threadRef.collection("messages").doc();

    for (const ref of priorActiveRefs) {
      tx.update(ref, {
        status: "replaced" as PaymentRequestStatus,
        replacedAt: now,
        replacedByRequestId: newRequestRef.id,
        updatedAt: now,
      });
    }

    const requestDoc: PaymentRequestDoc = {
      requestId: newRequestRef.id,
      orderId,
      vendorId,
      customerId,
      amount,
      currency: requestCurrency,
      paymentDestinationSnapshot: { paymentDestination, acceptCash },
      paymentInstructionsVersion: currentDoc!.currentVersion,
      paymentInstructionsRecordId: currentDoc!.currentRecordId,
      message: normalizedMessage,
      status: "active",
      chatId,
      messageId: msgRef.id,
      sentAt: now,
      createdAt: now,
      updatedAt: now,
    };
    tx.set(newRequestRef, requestDoc);

    // schemaVersion 2: only the metadata the collapsed chat shell needs and
    // the identity to look up the canonical document -- never a duplicate
    // copy of account/IBAN/routing/SWIFT/contact-email/contact-phone.
    const paymentRequestData = {
      schemaVersion: 2 as const,
      requestId: newRequestRef.id,
      amount,
      currency: requestCurrency,
      message: normalizedMessage,
      status: "requested" as const,
    };

    const content = "Payment request sent";

    tx.set(msgRef, {
      messageId: msgRef.id,
      chatId,
      senderUid: request.auth!.uid,
      senderRole: "vendor",
      type: "payment-request",
      content,
      paymentRequestData,
      orderId,
      createdAt: now,
      updatedAt: now,
    });

    tx.update(orderRef, { activePaymentRequestId: newRequestRef.id, updatedAt: now });

    tx.update(threadRef, {
      lastMessageAt: now,
      lastMessagePreview: content,
      updatedAt: now,
    });

    tx.set(idemRef, {
      idempotencyKey,
      requestId: newRequestRef.id,
      messageId: msgRef.id,
      payloadHash,
      createdAt: now,
    });

    return {
      requestId: newRequestRef.id,
      messageId: msgRef.id,
      changed: true,
      currency: requestCurrency,
      paymentInstructionsVersion: currentDoc!.currentVersion,
    };
  });

  // No raw identifier in the generic audit log -- only the non-sensitive
  // outcome shape, matching every other sensitive callable's convention.
  // Never logged/audited on a replay -- a replay performs no mutation.
  if (result.changed) {
    await writeAuditLog({
      requestId,
      functionName: "sendPaymentRequestInChat",
      actorUid: request.auth.uid,
      actorRole: "vendor",
      actorType: "vendor",
      targetType: "paymentRequest",
      targetId: result.requestId,
      eventType: "payment_request.sent",
      after: {
        orderId,
        chatId,
        amount,
        currency: result.currency,
        paymentInstructionsVersion: result.paymentInstructionsVersion,
      },
      appCheck,
    });
  }

  return { success: true, requestId: result.requestId, chatId, messageId: result.messageId };
});
