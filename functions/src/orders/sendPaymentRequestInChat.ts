import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { enforceRateLimit } from "../subscriptions/rateLimit";
import { OrderDoc, PaymentRequestDoc, PaymentRequestStatus, VendorPaymentMethodDoc } from "../types2";

const MAX_MESSAGE_LENGTH = 200;

// Order states a vendor may still ask to be paid against. Matches the
// "unpaid/active order" gate already used by the mobile app's own
// unpaidOrders filter (send-payment-request/[orderId].tsx) and the pinned
// payment card logic in vendor/chats/[orderId].tsx (shouldShowPinnedCard):
// requested orders haven't been accepted yet, and completed/rejected/
// cancelled/expired orders are all terminal.
const PAYABLE_ORDER_STATUSES = ["accepted", "confirmed", "in_progress"];

/**
 * sendPaymentRequestInChat.
 *
 * Mirrors sendInvoiceInChat.ts's structure and security posture exactly:
 * rate-limited, App-Check-checked, vendor-role-only, vendor-owns-the-order,
 * vendor-owns-the-thread, server-assembles the sensitive display data from
 * the stored record rather than trusting the client.
 *
 * The one thing this callable trusts the client for is the amount, because
 * unlike an invoice (a pre-existing record being shared) a payment request
 * is the vendor naming what they want paid right now for their own order —
 * that is legitimate vendor input, not a forged demand, so long as it is
 * bounded by the order's real total.
 *
 * Reads the vendor's structured Payment Method (vendors/{vendorId}/
 * paymentMethod/active — see updateVendorPaymentMethod.ts) as the real
 * destination, snapshots it onto the paymentRequests record and the chat
 * message, and rejects the call outright if no method has been set yet,
 * rather than sending a customer a payment request with no way to actually
 * pay. Superseded the free-text paymentInstructions field this callable
 * used to read; that field still exists for the settings screen that writes
 * it, but is no longer this callable's source of truth.
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

  const { orderId, chatId, amount, message } = (request.data ?? {}) as {
    orderId?: string;
    chatId?: string;
    amount?: number;
    message?: string;
  };
  if (!orderId) throw new https.HttpsError("invalid-argument", "orderId is required.");
  if (!chatId) throw new https.HttpsError("invalid-argument", "chatId is required.");
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    throw new https.HttpsError("invalid-argument", "amount must be a positive number.");
  }
  const trimmedMessage = typeof message === "string" ? message.trim() : "";
  if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
    throw new https.HttpsError("invalid-argument", `message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`);
  }

  const orderRef = db.collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();
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

  // No partial-payment ledger exists on the live order schema (OrderDoc has
  // no amountPaid/balance field — only orderSnapshot.total and the binary-ish
  // paymentStatus enum) so the order's full total is the only real
  // "outstanding balance" figure there is to validate against.
  const orderTotal = order.orderSnapshot?.total ?? 0;
  if (amount > orderTotal) {
    throw new https.HttpsError(
      "invalid-argument",
      `amount cannot exceed the order total of ${orderTotal}.`,
    );
  }

  const threadRef = db.collection("chatThreads").doc(chatId);
  const threadSnap = await threadRef.get();
  if (!threadSnap.exists) throw new https.HttpsError("not-found", "Conversation not found.");
  const thread = threadSnap.data() ?? {};

  if (thread.vendorId !== vendorId) {
    throw new https.HttpsError("permission-denied", "You are not a participant in this conversation.");
  }
  // ChatThreadDoc has no singular `orderId` field — a commerce thread is per
  // (customerId, vendorId), not per order, and accumulates every order ever
  // placed in it under relatedOrderIds. That array is the real cross-check.
  const relatedOrderIds = Array.isArray(thread.relatedOrderIds) ? (thread.relatedOrderIds as string[]) : [];
  if (relatedOrderIds.length > 0 && !relatedOrderIds.includes(orderId)) {
    throw new https.HttpsError("permission-denied", "This order does not belong to this conversation.");
  }

  const methodSnap = await db.collection("vendors").doc(vendorId).collection("paymentMethod").doc("active").get();
  if (!methodSnap.exists) {
    throw new https.HttpsError(
      "failed-precondition",
      "Set up your payment method in Settings before sending a payment request.",
    );
  }
  const method = methodSnap.data() as VendorPaymentMethodDoc;

  const customerId = order.customerId ?? thread.customerId ?? null;
  if (!customerId) {
    throw new https.HttpsError("failed-precondition", "This order has no customer to send a payment request to.");
  }

  const now = FieldValue.serverTimestamp();

  // Any prior still-outstanding request for this order is superseded by this
  // one, matching the frontend's already-designed replace lifecycle
  // (paymentRequestService.ts's replaceSnapshot) — a customer should only
  // ever see one live payment request per order.
  const priorActiveSnap = await db
    .collection("paymentRequests")
    .where("orderId", "==", orderId)
    .where("status", "in", ["active", "resent"] as PaymentRequestStatus[])
    .get();

  const batch = db.batch();
  const requestRef = db.collection("paymentRequests").doc();
  const msgRef = threadRef.collection("messages").doc();

  for (const doc of priorActiveSnap.docs) {
    if (doc.id === requestRef.id) continue;
    batch.update(doc.ref, {
      status: "replaced" as PaymentRequestStatus,
      replacedAt: now,
      replacedByRequestId: requestRef.id,
      updatedAt: now,
    });
  }

  const requestDoc: PaymentRequestDoc = {
    requestId: requestRef.id,
    orderId,
    vendorId,
    customerId,
    amount,
    currency: order.orderSnapshot?.currency ?? "NGN",
    paymentMethodType: method.type,
    ...(method.type === "bank_transfer"
      ? { bankName: method.bankName, accountNumber: method.accountNumber, accountName: method.accountName }
      : { cashInstructions: method.cashInstructions }),
    message: trimmedMessage || null,
    status: "active",
    chatId,
    messageId: msgRef.id,
    sentAt: now,
    createdAt: now,
    updatedAt: now,
  };
  batch.set(requestRef, requestDoc);

  // paymentRequestData is shaped to satisfy PaymentRequestCard's real reads
  // (mocks/chatData.ts PaymentRequestData) with the actual structured method
  // now that one exists — accountName/accountNumber/bankName carry the real
  // destination for bank_transfer instead of free text pretending to be one.
  const paymentRequestData =
    method.type === "bank_transfer"
      ? {
          amount,
          paymentMethod: "Bank Transfer",
          bankName: method.bankName,
          accountNumber: method.accountNumber,
          accountName: method.accountName,
          message: trimmedMessage || null,
          status: "requested" as const,
        }
      : {
          amount,
          paymentMethod: "Cash",
          message: trimmedMessage ? `${method.cashInstructions}\n\n${trimmedMessage}` : method.cashInstructions,
          status: "requested" as const,
        };

  const content = `Payment request sent`;

  batch.set(msgRef, {
    messageId: msgRef.id,
    chatId,
    senderUid: request.auth.uid,
    senderRole: "vendor",
    type: "payment-request",
    content,
    paymentRequestData,
    orderId,
    createdAt: now,
    updatedAt: now,
  });

  batch.update(threadRef, {
    lastMessageAt: now,
    lastMessagePreview: content,
    updatedAt: now,
  });

  await batch.commit();

  await writeAuditLog({
    requestId,
    functionName: "sendPaymentRequestInChat",
    actorUid: request.auth.uid,
    actorRole: "vendor",
    actorType: "vendor",
    targetType: "paymentRequest",
    targetId: requestRef.id,
    eventType: "payment_request.sent",
    after: { orderId, chatId, amount, currency: requestDoc.currency },
    appCheck,
  });

  return { success: true, requestId: requestRef.id, chatId, messageId: msgRef.id };
});
