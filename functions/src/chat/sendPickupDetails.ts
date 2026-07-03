import { logger } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { MessageDoc, PickupDetailsPayload, VendorPickupSettingsDoc } from "../types3";
import { commerceThreadId } from "../chat/createCommerceConversation";
import { createNotificationInternal } from "../notifications/notificationFunctions";

/**
 * sendPickupDetailsIfEligible — NOT client-callable. Invoked internally
 * from the Phase 2 payment-confirmation path (reviewPaymentProof accept).
 *
 * Eligibility (ALL must be true):
 *  - order.fulfillmentType == "pickup"
 *  - order.paymentStatus == "PROOF_ACCEPTED" (Phase 2's equivalent of Paid)
 *  - vendor pickup settings autoSendPickupDetailsEnabled == true
 *  - pickupAddress exists
 *  - pickupInstructions exists
 *  - order has a resolvable commerce thread
 *  - a pickup-details message does not already exist for this order
 *    (idempotency — duplicate payment-status webhooks must not duplicate)
 *
 * There is no client-callable equivalent. This is the ONLY path that can
 * produce a pickup-details typed message.
 */
export async function sendPickupDetailsIfEligible(orderId: string): Promise<void> {
  const orderRef = db.collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) {
    logger.warn(`sendPickupDetailsIfEligible: order ${orderId} not found`);
    return;
  }
  const order = orderSnap.data()!;

  if (order.fulfillmentType !== "pickup") return;
  if (order.paymentStatus !== "PROOF_ACCEPTED") return;

  const vendorId = order.vendorId;
  const pickupSnap = await db.collection("vendors").doc(vendorId)
    .collection("settings").doc("pickup").get();

  if (!pickupSnap.exists) return;
  const pickup = pickupSnap.data() as VendorPickupSettingsDoc;

  if (!pickup.autoSendPickupDetailsEnabled) return;
  if (!pickup.pickupAddress || !pickup.pickupInstructions?.trim()) return;

  const customerId = order.customerId;
  if (!customerId || typeof customerId !== "string") return;

  const chatId = order.conversationId ?? commerceThreadId(customerId, vendorId);
  const threadRef = db.collection("chatThreads").doc(chatId);
  const threadSnap = await threadRef.get();
  if (!threadSnap.exists) {
    logger.warn(`sendPickupDetailsIfEligible: no commerce thread found for order ${orderId}`);
    return;
  }

  // Idempotency check — never send twice for the same order.
  const existingSnap = await threadRef.collection("messages")
    .where("type", "==", "pickup-details")
    .where("orderId", "==", orderId)
    .limit(1)
    .get();

  if (!existingSnap.empty) {
    return; // already sent — silently no-op
  }

  const vendorSnap = await db.collection("vendors").doc(vendorId).get();
  const vendor = vendorSnap.data();
  const businessName = vendor?.name ?? "the vendor";
  const vendorOwnerUid = vendor?.ownerUid;

  const now = FieldValue.serverTimestamp();
  const msgRef = threadRef.collection("messages").doc();

  const pickupDetailsData: PickupDetailsPayload = {
    businessName,
    orderId,
    pickupAddress: pickup.pickupAddress,
    pickupInstructions: pickup.pickupInstructions,
    // Contact phone only shared through this structured message, post-payment
    pickupContactPhone: pickup.pickupContactPhone ?? null,
    pickupVerificationCode: pickup.pickupVerificationCode ?? null,
  };

  const message: MessageDoc = {
    messageId: msgRef.id,
    chatId,
    senderUid: vendorOwnerUid ?? "system",
    senderRole: "system",
    type: "pickup-details",
    orderId,
    content: "Pickup details sent",
    pickupDetailsData,
    status: "sent",
    visibleToUser: true,
    attachments: [],
    createdAt: now,
    updatedAt: now,
  };

  // Use a transaction with the idempotency re-check to close the race
  // window between the query above and this write under concurrent
  // duplicate payment-status webhooks.
  try {
    await db.runTransaction(async (tx) => {
      const recheckSnap = await tx.get(
        threadRef.collection("messages")
          .where("type", "==", "pickup-details")
          .where("orderId", "==", orderId)
          .limit(1)
      );
      if (!recheckSnap.empty) return; // lost the race — already sent
      tx.set(msgRef, message);
      tx.update(threadRef, {
        lastMessage: "Pickup details sent",
        lastMessageType: "pickup-details",
        lastMessageAt: now,
        lastSenderUid: vendorOwnerUid ?? "system",
        updatedAt: now,
      });
    });
  } catch (err) {
    logger.error(`sendPickupDetailsIfEligible transaction failed for order ${orderId}`, err);
    return;
  }

  if (customerId) {
    await createNotificationInternal({
      recipientUid: customerId,
      recipientRole: "customer",
      vendorId,
      customerId,
      type: "pickup_details_sent",
      domain: "order",
      title: "Pickup details ready",
      body: `Pickup instructions for your order from ${businessName} are ready.`,
      deepLink: `the platform://chat/${chatId}`,
      isCritical: true, // pickup readiness is time-sensitive — bypasses quiet hours per the client's "critical customer examples"
    });
  }
}
