import { https, logger } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { ChatThreadDoc, MessageDoc, VendorChatSettingsDoc, VENDOR_CHAT_SETTINGS_DEFAULTS } from "../types3";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { canStartNewCommerce } from "../blocks/blockUtils";
import { isCountryActive } from "../utils/countryAvailability";
import { createNotificationInternal } from "../notifications/notificationFunctions";

/**
 * Deterministic thread ID for a customer/vendor pair. This is the
 * mechanism that guarantees "one canonical commerce thread" even under
 * concurrent creation attempts — two simultaneous first-messages from the
 * same customer to the same vendor resolve to the SAME document ID, so a
 * Firestore transaction naturally prevents duplicates without needing a
 * separate lock collection.
 */
export function commerceThreadId(customerId: string, vendorId: string): string {
  return `commerce_${customerId}_${vendorId}`;
}

/**
 * createCommerceConversation — creates (or returns the existing) canonical
 * commerce thread between a customer and a vendor.
 *
 * Eligibility (per the client's spec):
 *  - customer account ACTIVE
 *  - vendor account ACTIVE
 *  - vendor's countryAvailability status ACTIVE
 *  - customer can access the storefront via discovery OR valid direct link
 *  - neither party has blocked the other (new-conversation block rule —
 *    no active-order exception here, since by definition a NEW conversation
 *    has no prior order)
 *
 * Idempotent: if the thread already exists, returns it rather than erroring.
 */
export const createCommerceConversation = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "createCommerceConversation");

  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");

  const customerId = request.auth.uid;
  const callerRole = request.auth.token.role as string;
  const { vendorId } = request.data ?? {};

  if (!vendorId) throw new https.HttpsError("invalid-argument", "vendorId is required.");
  if (callerRole !== "customer") {
    throw new https.HttpsError("permission-denied", "Only customers can start a commerce conversation.");
  }

  const [customerSnap, vendorSnap] = await Promise.all([
    db.collection("users").doc(customerId).get(),
    db.collection("vendors").doc(vendorId).get(),
  ]);

  if (!customerSnap.exists) throw new https.HttpsError("not-found", "Customer profile not found.");
  if (!vendorSnap.exists) throw new https.HttpsError("not-found", "Vendor not found.");

  const customer = customerSnap.data()!;
  const vendor = vendorSnap.data()!;

  if (customer.accountStatus && customer.accountStatus !== "active") {
    throw new https.HttpsError("failed-precondition", "Your account is not active.");
  }
  if (vendor.vendorStatus !== "active") {
    throw new https.HttpsError("failed-precondition", "This vendor is not currently accepting messages.");
  }

  // Storefront accessibility: discovery OR direct link (the client's dual-path rule)
  const accessibleViaDiscovery =
    vendor.verificationStatus === "approved" &&
    vendor.vendorStatus === "active" &&
    vendor.isDiscoverable === true;

  const accessibleViaDirectLink =
    vendor.vendorStatus === "active" &&
    vendor.storefrontPublished === true;

  if (!accessibleViaDiscovery && !accessibleViaDirectLink) {
    throw new https.HttpsError(
      "failed-precondition",
      "This vendor's storefront is not currently accessible."
    );
  }

  // Country availability — required for BOTH access paths per the client's spec
  const countryCode = vendor.countryCode;
  const countryOk = await isCountryActive(countryCode);
  if (!countryOk) {
    throw new https.HttpsError(
      "failed-precondition",
      "the platform is not currently available in this vendor's region."
    );
  }

  const vendorOwnerUid = vendor.ownerUid;

  // Block check — starting new commerce is ALWAYS denied if blocked
  const blockCheck = await canStartNewCommerce(customerId, vendorOwnerUid);
  if (!blockCheck.allowed) {
    throw new https.HttpsError(
      "failed-precondition",
      "You are unable to message this vendor."
    );
  }

  const chatId = commerceThreadId(customerId, vendorId);
  const threadRef = db.collection("chatThreads").doc(chatId);

  const existingSnap = await threadRef.get();
  if (existingSnap.exists) {
    // Idempotent return — do not error, do not duplicate.
    return { success: true, chatId, created: false };
  }

  const fullName: string = customer.profile?.fullName ?? customer.displayName ?? "Customer";
  const now = FieldValue.serverTimestamp();

  const threadDoc: ChatThreadDoc = {
    chatId,
    chatType: "commerce",
    vendorId,
    vendorName: vendor.name,
    customerId,
    customerName: fullName,
    relatedOrderIds: [],
    participants: [customerId, vendorOwnerUid],
    participantRoles: {
      [customerId]: "customer",
      [vendorOwnerUid]: "vendor",
    },
    title: vendor.name,
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

  // Transaction guards against the race where two near-simultaneous calls
  // both pass the existence check above before either writes.
  let created = false;
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(threadRef);
      if (snap.exists) return; // lost the race — someone else created it first
      tx.set(threadRef, threadDoc);
      created = true;
    });
  } catch (err) {
    logger.error(`Failed to create commerce thread ${chatId}`, err);
    throw new https.HttpsError("internal", "Could not start conversation. Please try again.");
  }

  // Greeting message — sent exactly once, only on actual creation
  if (created) {
    const chatSettingsSnap = await db
      .collection("vendors").doc(vendorId)
      .collection("settings").doc("chat")
      .get();

    const chatSettings: VendorChatSettingsDoc = chatSettingsSnap.exists
      ? (chatSettingsSnap.data() as VendorChatSettingsDoc)
      : { ...VENDOR_CHAT_SETTINGS_DEFAULTS, updatedAt: now };

    if (chatSettings.greetingEnabled && chatSettings.greetingMessage?.trim()) {
      const msgRef = threadRef.collection("messages").doc();
      const greetingMsg: MessageDoc = {
        messageId: msgRef.id,
        chatId,
        senderUid: vendorOwnerUid,
        senderRole: "system",
        type: "system",
        systemSubtype: "greeting_message",
        content: chatSettings.greetingMessage.trim(),
        status: "sent",
        visibleToUser: true,
        attachments: [],
        createdAt: now,
        updatedAt: now,
      };
      await msgRef.set(greetingMsg);
      await threadRef.update({
        greetingSentAt: now,
        lastMessage: chatSettings.greetingMessage.trim(),
        lastMessageType: "system",
        lastMessageAt: now,
        lastSenderUid: vendorOwnerUid,
        updatedAt: now,
      });
    }

    // Notify vendor of new inquiry thread
    await createNotificationInternal({
      recipientUid: vendorOwnerUid,
      recipientRole: "vendor",
      vendorId,
      customerId,
      type: "new_inquiry",
      domain: "vendor_chat",
      title: "New customer inquiry",
      body: `${fullName} started a conversation with you.`,
      deepLink: `the platform://chat/${chatId}`,
      isCritical: false,
    });
  }

  await writeAuditLog({
    requestId,
    functionName: "createCommerceConversation",
    actorUid: customerId,
    actorRole: "customer",
    actorType: "customer",
    targetType: "chatThread",
    targetId: chatId,
    eventType: created ? "chat.thread_created" : "chat.thread_reused",
    appCheck,
  });

  return { success: true, chatId, created };
});
