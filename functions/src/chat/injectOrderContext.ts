import { db, FieldValue } from "../admin";
import { ChatThreadDoc, MessageDoc, OrderContextPayload } from "../types3";
import { commerceThreadId } from "./createCommerceConversation";

/**
 * injectOrderContext — called internally whenever an order is created.
 *
 * Per the client: a new order NEVER creates a new chat thread. It reuses the
 * canonical commerce thread for the (customerId, vendorId) pair, creating
 * that thread first ONLY if it does not already exist (e.g. a vendor
 * created an external order for a customer who never messaged first).
 *
 * This is NOT a client-callable function — it is invoked from
 * createOrderFromCart / createExternalOrder (Phase 2, extended) as a
 * side effect of order creation.
 */
export async function injectOrderContext(params: {
  orderId: string;
  publicOrderId: string;
  vendorId: string;
  vendorOwnerUid: string;
  vendorName: string;
  customerId: string;
  customerName: string;
  status: string;
  total: number;
  currency: string;
}): Promise<string> {
  const chatId = commerceThreadId(params.customerId, params.vendorId);
  const threadRef = db.collection("chatThreads").doc(chatId);
  const now = FieldValue.serverTimestamp();

  // Transaction guards the same race createCommerceConversation guards
  // against: two concurrent orders for a customer/vendor pair that has
  // never messaged before must not race on thread creation, and the
  // arrayUnion on an existing thread must be atomic with the existence
  // check (read before write, matching Firestore's transaction rules).
  await db.runTransaction(async (tx) => {
    const threadSnap = await tx.get(threadRef);

    if (!threadSnap.exists) {
      // Thread doesn't exist yet (e.g. vendor-created external order for a
      // customer who never messaged first). Create it bare — no greeting,
      // since greeting is customer-inquiry-initiated only.
      const bareThread: ChatThreadDoc = {
        chatId,
        chatType: "commerce",
        vendorId: params.vendorId,
        vendorName: params.vendorName,
        customerId: params.customerId,
        customerName: params.customerName,
        relatedOrderIds: [params.orderId],
        participants: [params.customerId, params.vendorOwnerUid],
        participantRoles: {
          [params.customerId]: "customer",
          [params.vendorOwnerUid]: "vendor",
        },
        title: params.vendorName,
        lastMessage: "",
        lastMessageType: "",
        lastMessageAt: now,
        lastSenderUid: "",
        archivedBy: [],
        blockedState: "none",
        isSupportEscalated: false,
        greetingSentAt: null,
        createdAt: now,
        updatedAt: now,
      };
      tx.set(threadRef, bareThread);
    } else {
      // Thread exists — just append this order to relatedOrderIds.
      tx.update(threadRef, {
        relatedOrderIds: FieldValue.arrayUnion(params.orderId),
        updatedAt: now,
      });
    }
  });


  const orderContextData: OrderContextPayload = {
    orderId: params.orderId,
    publicOrderId: params.publicOrderId,
    status: params.status,
    total: params.total,
    currency: params.currency,
  };

  const msgRef = threadRef.collection("messages").doc();
  const contentText = `Order ${params.publicOrderId} placed — ${params.currency} ${params.total.toLocaleString()}`;

  const message: MessageDoc = {
    messageId: msgRef.id,
    chatId,
    senderUid: params.vendorOwnerUid, // attributed to the thread's system context
    senderRole: "system",
    type: "order_context",
    systemSubtype: "order_context",
    content: contentText,
    orderId: params.orderId,
    orderContextData,
    status: "sent",
    visibleToUser: true,
    attachments: [],
    createdAt: now,
    updatedAt: now,
  };

  await msgRef.set(message);

  await threadRef.update({
    lastMessage: contentText,
    lastMessageType: "order_context",
    lastMessageAt: now,
    lastSenderUid: params.vendorOwnerUid,
    updatedAt: now,
  });

  return chatId;
}
