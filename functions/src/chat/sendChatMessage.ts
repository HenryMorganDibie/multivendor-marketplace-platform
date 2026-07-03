import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { ChatThreadDoc, MessageDoc, MessageType } from "../types3";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { canContinueExistingThread } from "../blocks/blockUtils";
import { isCountryActive } from "../utils/countryAvailability";
import { createNotificationInternal } from "../notifications/notificationFunctions";
import { sendAwayMessageIfEligible } from "./awayMessage";

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15MB, matches Phase 1 verification doc limit
const MAX_TEXT_LENGTH = 4000;

// Message types a CLIENT may create directly. Everything else is
// system/Cloud-Function-only (order_context, pickup-details, receipt,
// invoice, change_request are all server-assembled from real data).
const CLIENT_CREATABLE_TYPES: MessageType[] = ["text", "contact-card", "catalog_item"];

export const sendChatMessage = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "sendChatMessage");

  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");

  const senderUid = request.auth.uid;
  const senderRole = request.auth.token.role as "customer" | "vendor" | undefined;
  const { chatId, type, content, contactCardData, catalogItemData, attachments } = request.data ?? {};

  if (!chatId) throw new https.HttpsError("invalid-argument", "chatId is required.");
  if (!type) throw new https.HttpsError("invalid-argument", "type is required.");
  if (!senderRole) throw new https.HttpsError("failed-precondition", "Sender role could not be determined.");

  if (!CLIENT_CREATABLE_TYPES.includes(type)) {
    throw new https.HttpsError(
      "invalid-argument",
      `Message type "${type}" cannot be created directly by clients.`
    );
  }

  if (type === "text" && (!content?.trim() || content.length > MAX_TEXT_LENGTH)) {
    throw new https.HttpsError("invalid-argument", `Text content must be 1-${MAX_TEXT_LENGTH} characters.`);
  }

  if (Array.isArray(attachments)) {
    if (attachments.length > MAX_ATTACHMENTS) {
      throw new https.HttpsError("invalid-argument", `Maximum ${MAX_ATTACHMENTS} attachments per message.`);
    }
    for (const a of attachments) {
      if (typeof a.sizeBytes === "number" && a.sizeBytes > MAX_ATTACHMENT_BYTES) {
        throw new https.HttpsError("invalid-argument", "Attachment exceeds maximum size of 15MB.");
      }
    }
  }

  const threadRef = db.collection("chatThreads").doc(chatId);
  const threadSnap = await threadRef.get();
  if (!threadSnap.exists) throw new https.HttpsError("not-found", "Chat thread not found.");

  const thread = threadSnap.data() as ChatThreadDoc;

  if (!thread.participants.includes(senderUid)) {
    throw new https.HttpsError("permission-denied", "You are not a participant in this conversation.");
  }

  // Support and AI-help threads skip commerce-specific block/country/order checks
  if (thread.chatType === "commerce") {
    if (!thread.customerId || !thread.vendorId) {
      throw new https.HttpsError("internal", "Malformed commerce thread.");
    }

    const vendorSnap = await db.collection("vendors").doc(thread.vendorId).get();
    if (!vendorSnap.exists) throw new https.HttpsError("not-found", "Vendor not found.");
    const vendor = vendorSnap.data()!;

    if (vendor.vendorStatus !== "active") {
      throw new https.HttpsError(
        "failed-precondition",
        "This vendor's account is not currently active. Existing history remains available, but new messages cannot be sent."
      );
    }

    const countryOk = await isCountryActive(vendor.countryCode);
    if (!countryOk) {
      throw new https.HttpsError(
        "failed-precondition",
        "the platform is not currently available in this region for new messages."
      );
    }

    const blockCheck = await canContinueExistingThread(
      thread.customerId,
      thread.vendorId,
      vendor.ownerUid
    );
    if (!blockCheck.allowed) {
      throw new https.HttpsError(
        "failed-precondition",
        "You are unable to send new messages in this conversation."
      );
    }
  }

  // Determine recipient(s) for notification purposes — everyone except sender
  const recipients = thread.participants.filter((uid) => uid !== senderUid);

  const now = FieldValue.serverTimestamp();
  const msgRef = threadRef.collection("messages").doc();

  let messageDoc: MessageDoc = {
    messageId: msgRef.id,
    chatId,
    senderUid,
    senderRole,
    type,
    content: content ?? "",
    status: "sent",
    visibleToUser: true,
    attachments: Array.isArray(attachments) ? attachments : [],
    createdAt: now,
    updatedAt: now,
  };

  if (type === "contact-card") {
    if (!contactCardData?.fullName || !contactCardData?.phoneNumber) {
      throw new https.HttpsError("invalid-argument", "contactCardData requires fullName and phoneNumber.");
    }
    // Only the sender's own info may be shared — this is the customer
    // sharing THEIR OWN details, never someone else's.
    messageDoc.contactCardData = {
      fullName: String(contactCardData.fullName).trim(),
      phoneNumber: String(contactCardData.phoneNumber).trim(),
      address: contactCardData.address ?? undefined,
    };
    messageDoc.content = content?.trim() || "Contact details shared";
  }

  if (type === "catalog_item") {
    if (!catalogItemData?.itemId || !thread.vendorId) {
      throw new https.HttpsError("invalid-argument", "catalogItemData.itemId is required.");
    }
    // Never trust client-supplied price — fetch the real item.
    const itemSnap = await db
      .collection("vendors").doc(thread.vendorId)
      .collection("catalogItems").doc(catalogItemData.itemId)
      .get();
    if (!itemSnap.exists) throw new https.HttpsError("not-found", "Catalog item not found.");
    const item = itemSnap.data()!;
    messageDoc.catalogItemData = {
      itemId: item.itemId,
      name: item.name,
      basePrice: item.basePrice,
      salePrice: item.salePrice ?? null,
      currency: item.currency,
      thumbnailUrl: item.thumbnailUrl ?? null,
    };
    messageDoc.content = content?.trim() || `Shared: ${item.name}`;
  }

  await msgRef.set(messageDoc);

  await threadRef.update({
    lastMessage: messageDoc.content.slice(0, 200),
    lastMessageType: type,
    lastMessageAt: now,
    lastSenderUid: senderUid,
    updatedAt: now,
  });

  // Notify all recipients (never the sender)
  for (const recipientUid of recipients) {
    const recipientRole = thread.participantRoles[recipientUid] ?? "customer";
    await createNotificationInternal({
      recipientUid,
      recipientRole: recipientRole === "admin" ? "admin" : recipientRole === "vendor" ? "vendor" : "customer",
      vendorId: thread.vendorId,
      customerId: thread.customerId,
      type: "new_message",
      domain: thread.chatType === "support" ? "support" : recipientRole === "vendor" ? "vendor_chat" : "customer_chat",
      title: senderRole === "vendor" ? (thread.vendorName ?? "Vendor") : (thread.customerName ?? "Customer"),
      body: messageDoc.content.slice(0, 120),
      deepLink: `the platform://chat/${chatId}`,
      isCritical: false,
    });
  }

  await writeAuditLog({
    requestId,
    functionName: "sendChatMessage",
    actorUid: senderUid,
    actorRole: senderRole,
    actorType: senderRole,
    targetType: "chatMessage",
    targetId: msgRef.id,
    eventType: "chat.message_sent",
    metadata: { chatId, type },
    appCheck,
  });

  // Away-message check: only fires for customer-sent messages in commerce
  // threads, and only AFTER the send above has already passed every
  // block/suspension/country check — never an independent bypass path.
  if (thread.chatType === "commerce" && senderRole === "customer" && thread.vendorId) {
    const vendorOwnerUid = recipients[0];
    if (vendorOwnerUid) {
      await sendAwayMessageIfEligible(chatId, thread.vendorId, vendorOwnerUid)
        .catch(() => null); // away-message failure must never fail the send
    }
  }

  return { success: true, messageId: msgRef.id };
});
