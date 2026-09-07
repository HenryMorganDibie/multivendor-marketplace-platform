import { https } from "firebase-functions/v2";
import { db, FieldValue, Timestamp } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { enforceRateLimit } from "../subscriptions/rateLimit";

/**
 * sendInvoiceInChat — deliver an invoice into a Laetiva conversation.
 *
 * The missing half of internal invoice delivery. The message schema has carried
 * an "invoice" type and an invoiceData field since the chat model was written,
 * the Create Invoice screen has always had a "Laetiva customer" mode that picks
 * a real conversation, and the invoice detail screen shows an "Open chat"
 * action when chatId is set. Nothing ever wrote any of it, so the action could
 * never fire and the type was never used.
 *
 * The card is assembled here from the stored invoice, never from the request.
 * A client that could name its own amount, invoice number or vendor could post
 * a convincing demand for money into someone's chat; the only thing taken from
 * the caller is which invoice and which conversation.
 *
 * Posting also stamps chatId and sentInChatAt on the invoice, which is what
 * makes its delivery status derive as sent rather than draft, and what makes it
 * no longer deletable — an invoice a customer has seen is cancelled, not
 * removed.
 */
export const sendInvoiceInChat = https.onCall(async (request) => {
  await enforceRateLimit(
    request.auth?.uid ?? `ip:${request.rawRequest?.ip ?? "unknown"}`,
    "sendInvoiceInChat",
    30,
  );
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "sendInvoiceInChat");

  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string | undefined;
  if (!vendorId) {
    throw new https.HttpsError("failed-precondition", "Vendor ID could not be determined.");
  }

  const { invoiceId, chatId } = (request.data ?? {}) as {
    invoiceId?: string;
    chatId?: string;
  };
  if (!invoiceId) throw new https.HttpsError("invalid-argument", "invoiceId is required.");
  if (!chatId) throw new https.HttpsError("invalid-argument", "chatId is required.");

  const invoiceRef = db.collection("invoices").doc(invoiceId);
  const invoiceSnap = await invoiceRef.get();
  if (!invoiceSnap.exists) throw new https.HttpsError("not-found", "Invoice not found.");
  const invoice = invoiceSnap.data() ?? {};

  if (invoice.vendorId !== vendorId) {
    throw new https.HttpsError("permission-denied", "You do not own this invoice.");
  }
  if (invoice.status === "cancelled") {
    throw new https.HttpsError("failed-precondition", "A cancelled invoice cannot be sent.");
  }

  const threadRef = db.collection("chatThreads").doc(chatId);
  const threadSnap = await threadRef.get();
  if (!threadSnap.exists) throw new https.HttpsError("not-found", "Conversation not found.");
  const thread = threadSnap.data() ?? {};

  // Ownership of the conversation, checked here rather than trusted, so a
  // vendor cannot post into a thread that is not theirs.
  if (thread.vendorId !== vendorId) {
    throw new https.HttpsError("permission-denied", "You are not a participant in this conversation.");
  }

  // Already delivered to this same conversation: return the existing state
  // rather than posting a second identical card. A vendor tapping Send twice on
  // a slow connection should not put two demands for the same money in a chat.
  if (invoice.chatId === chatId && invoice.sentInChatAt) {
    return { success: true, alreadySent: true, invoiceId, chatId };
  }

  const msgRef = threadRef.collection("messages").doc();
  const now = FieldValue.serverTimestamp();

  // Assembled from the stored invoice. The share token is deliberately included
  // so the customer's card can open the public view, and it is the only place
  // it is exposed — to the customer the invoice is actually for.
  //
  // Field names here are deliberately NOT the InvoiceDoc's own (subtotal,
  // shareToken, ...) — both InvoiceChatCard.tsx (vendor) and
  // CustomerInvoiceChatCard.tsx (customer) are written against the
  // InvoiceData contract in mocks/chatData.ts (amountDue, shareCode,
  // itemCount, paymentStatus), which this used to send under different
  // names entirely. The amount showed blank and "View Invoice" was
  // permanently disabled for every real invoice as a result.
  const invoiceData = {
    invoiceId,
    invoiceNumber: invoice.invoiceNumber ?? null,
    amountDue: invoice.subtotal ?? 0,
    currency: invoice.currency ?? "NGN",
    amountPaidMinorUnits: invoice.amountPaidMinorUnits ?? 0,
    balanceMinorUnits: invoice.balanceMinorUnits ?? invoice.subtotal ?? 0,
    paymentStatus: invoice.status ?? "unpaid",
    dueDate: invoice.dueDate ?? null,
    shareCode: invoice.shareToken ?? null,
    itemCount: Array.isArray(invoice.lineItems) ? invoice.lineItems.length : 0,
    customerName: invoice.customerName ?? null,
  };

  const batch = db.batch();

  batch.set(msgRef, {
    messageId: msgRef.id,
    chatId,
    senderUid: request.auth.uid,
    senderRole: "vendor",
    type: "invoice",
    content: `Invoice ${invoice.invoiceNumber ?? ""}`.trim(),
    invoiceData,
    orderId: invoice.orderId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  batch.update(threadRef, {
    lastMessageAt: now,
    lastMessagePreview: `Invoice ${invoice.invoiceNumber ?? ""}`.trim(),
    updatedAt: now,
  });

  // Binding the invoice to the thread is what makes "Open chat" work, and what
  // makes its delivery status read as sent rather than draft.
  batch.update(invoiceRef, {
    chatId,
    customerId: invoice.customerId ?? thread.customerId ?? null,
    conversationId: chatId,
    sentInChatAt: Timestamp.now(),
    updatedAt: now,
  });

  await batch.commit();

  await writeAuditLog({
    requestId,
    functionName: "sendInvoiceInChat",
    actorUid: request.auth.uid,
    actorRole: "vendor",
    actorType: "vendor",
    targetType: "invoice",
    targetId: invoiceId,
    eventType: "invoice.sent_in_chat",
    after: { chatId, invoiceNumber: invoice.invoiceNumber },
    appCheck,
  });

  return { success: true, alreadySent: false, invoiceId, chatId, messageId: msgRef.id };
});
