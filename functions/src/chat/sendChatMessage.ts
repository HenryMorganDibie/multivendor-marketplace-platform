import { https, logger } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { ChatThreadDoc, MessageDoc, MessageType, ParticipantRole } from "../types3";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { canContinueExistingThread } from "../blocks/blockUtils";
import { isCountryActive } from "../utils/countryAvailability";
import { createNotificationInternal } from "../notifications/notificationFunctions";
import { sendAwayMessageIfEligible } from "./awayMessage";
import { applyUserModerationScore, checkUserModerationRestriction, recordModerationEvent, runModerationCheck } from "../moderation/moderationEngine";
import { enforceRateLimit } from "../subscriptions/rateLimit";

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15MB, matches Phase 1 verification doc limit
const MAX_TEXT_LENGTH = 4000;

// Message types a CLIENT may create directly. Everything else is
// system/Cloud-Function-only (order_context, pickup-details, receipt,
// invoice, change_request are all server-assembled from real data).
const CLIENT_CREATABLE_TYPES: MessageType[] = ["text", "contact-card", "catalog_item"];

/**
 * Resolves a recipient's role for notification purposes, in order:
 *  1. `thread.participantRoles[recipientUid]`, if it's one of the
 *     recognized roles — the authoritative, purpose-built source, correctly
 *     populated by every current thread-creation path (commerce, support,
 *     AI-help), including "admin"/"system" roles this function cannot
 *     otherwise derive.
 *  2. A direct match against `thread.customerId` (already verified to be
 *     the customer's real uid) or `vendorOwnerUid` (already fetched for the
 *     vendor-active check on commerce threads) — defensive fallback for a
 *     thread whose `participantRoles` is missing or malformed.
 *  3. `null` if neither resolves — callers must skip notifying this
 *     recipient rather than guess a role.
 */
function resolveRecipientRole(
  thread: ChatThreadDoc,
  recipientUid: string,
  vendorOwnerUid: string | undefined,
): ParticipantRole | null {
  const fromMap = thread.participantRoles?.[recipientUid];
  if (fromMap === "customer" || fromMap === "vendor" || fromMap === "admin" || fromMap === "system") {
    return fromMap;
  }
  if (thread.customerId && recipientUid === thread.customerId) return "customer";
  if (vendorOwnerUid && recipientUid === vendorOwnerUid) return "vendor";
  return null;
}

export const sendChatMessage = https.onCall(async (request) => {
  await enforceRateLimit(
    request.auth?.uid ?? `ip:${request.rawRequest?.ip ?? "unknown"}`,
    "sendChatMessage",
    60,
  );
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

  // Rule-based moderation (P3-FB-021) — a flagging system first, not a hard
  // ban: only rules configured with action "block_message" (via the
  // Firestore-managed moderationRules set) stop the send outright. Runs on
  // whatever the sender actually typed, never on server-generated fallback
  // strings like "Contact details shared". Client-supplied moderationStatus
  // is never read from request.data anywhere in this function — the value
  // saved below is always computed here, so the client cannot set it.
  //
  // Started here rather than awaited immediately: it depends only on
  // `content`, already available with no reads, so it can run concurrently
  // with the thread/restriction/vendor/country/block checks below instead
  // of adding its own dedicated round trip after all of them finish.
  const textToModerate = typeof content === "string" ? content.trim() : "";
  const moderationPromise = textToModerate
    ? runModerationCheck(textToModerate, "chat")
    : Promise.resolve({ status: "clean" as const, score: 0, action: null, severity: null, category: null, matchedRuleIds: [], matchedRules: [], blocked: false });

  const threadRef = db.collection("chatThreads").doc(chatId);
  // Independent of each other — neither needs the other's result — so run
  // together instead of one after another.
  const [threadSnap, restriction] = await Promise.all([
    threadRef.get(),
    checkUserModerationRestriction(senderUid),
  ]);
  if (!threadSnap.exists) throw new https.HttpsError("not-found", "Chat thread not found.");

  const thread = threadSnap.data() as ChatThreadDoc;

  if (!thread.participants.includes(senderUid)) {
    throw new https.HttpsError("permission-denied", "You are not a participant in this conversation.");
  }

  // Account-level moderation restriction (P3-FB-021) — a cumulative trust
  // score crossing 50/100 escalates accountStatus to "frozen"/"banned"
  // (see moderationEngine.applyUserModerationScore). Checked before any
  // per-message content check, since a suspended account shouldn't be able
  // to send anything at all, clean or not.
  if (restriction.blocked) {
    throw new https.HttpsError("permission-denied", "Your account has been suspended pending review.");
  }
  if (restriction.restricted) {
    throw new https.HttpsError("failed-precondition", "Your account has temporary messaging restrictions pending review.");
  }

  // Support and AI-help threads skip commerce-specific block/country/order checks.
  // vendorOwnerUid is captured here (already fetched for the vendor-active
  // check below) so the notification step further down can authoritatively
  // identify the vendor-side recipient without a second read.
  let vendorOwnerUid: string | undefined;
  if (thread.chatType === "commerce") {
    if (!thread.customerId || !thread.vendorId) {
      throw new https.HttpsError("internal", "Malformed commerce thread.");
    }

    const vendorSnap = await db.collection("vendors").doc(thread.vendorId).get();
    if (!vendorSnap.exists) throw new https.HttpsError("not-found", "Vendor not found.");
    const vendor = vendorSnap.data()!;
    vendorOwnerUid = vendor.ownerUid;

    if (vendor.vendorStatus !== "active") {
      throw new https.HttpsError(
        "failed-precondition",
        "This vendor's account is not currently active. Existing history remains available, but new messages cannot be sent."
      );
    }

    // Independent of each other, both depend only on data already in hand —
    // run together rather than sequentially.
    const [countryOk, blockCheck] = await Promise.all([
      isCountryActive(vendor.countryCode),
      canContinueExistingThread(thread.customerId, thread.vendorId, vendor.ownerUid),
    ]);
    if (!countryOk) {
      throw new https.HttpsError(
        "failed-precondition",
        "Platform is not currently available in this region for new messages."
      );
    }
    if (!blockCheck.allowed) {
      throw new https.HttpsError(
        "failed-precondition",
        "You are unable to send new messages in this conversation."
      );
    }
  }

  const moderation = await moderationPromise;

  if (moderation.blocked) {
    await recordModerationEvent({
      actorUid: senderUid,
      actorRole: senderRole,
      vendorId: thread.vendorId ?? null,
      customerId: thread.customerId ?? null,
      chatId,
      messageId: null,
      rawText: textToModerate,
      result: moderation,
    });
    await applyUserModerationScore(senderUid, moderation.score);
    throw new https.HttpsError("invalid-argument", "This message contains content that is not allowed on Platform.");
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
    moderationStatus: moderation.status,
    moderationScore: moderation.score,
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

  const threadUpdate: Record<string, unknown> = {
    lastMessage: messageDoc.content.slice(0, 200),
    lastMessageType: type,
    lastMessageAt: now,
    lastSenderUid: senderUid,
    updatedAt: now,
  };
  if (moderation.score > 0) threadUpdate.riskScore = FieldValue.increment(moderation.score);

  // Primary persistence: the message document and the thread's last-message
  // metadata commit as one atomic write. If this batch rejects, neither
  // write is left partially applied, and the message is correctly reported
  // as not sent. If it resolves, the message IS sent — every operation
  // below this point is secondary/best-effort and independently isolated
  // (see each try/catch below) so a failure there can never turn an
  // already-persisted message into a reported failure.
  const primaryWrite = db.batch();
  primaryWrite.set(msgRef, messageDoc);
  primaryWrite.update(threadRef, threadUpdate);
  await primaryWrite.commit();

  if (moderation.status !== "clean") {
    try {
      await recordModerationEvent({
        actorUid: senderUid,
        actorRole: senderRole,
        vendorId: thread.vendorId ?? null,
        customerId: thread.customerId ?? null,
        chatId,
        messageId: msgRef.id,
        rawText: textToModerate,
        result: moderation,
      });
      await applyUserModerationScore(senderUid, moderation.score);
    } catch (err) {
      logger.error(`sendChatMessage: moderation bookkeeping failed for message ${msgRef.id}`, err);
    }
  }

  // Notification loop and audit-log write are independent of each other —
  // and each already isolates its own failures internally, so neither can
  // affect the already-committed message above — so run them together
  // instead of one after another. Within the loop, each recipient is
  // further isolated so one recipient's failure never blocks another.
  await Promise.all([
    Promise.all(
      recipients.map(async (recipientUid) => {
        try {
          const recipientRole = resolveRecipientRole(thread, recipientUid, vendorOwnerUid);
          if (!recipientRole) {
            logger.warn("sendChatMessage: could not resolve recipient role, skipping notification", {
              chatId,
              recipientUid,
              senderRole,
            });
            return;
          }
          await createNotificationInternal({
            recipientUid,
            recipientRole: recipientRole === "admin" ? "admin" : recipientRole === "vendor" ? "vendor" : "customer",
            vendorId: thread.vendorId,
            customerId: thread.customerId,
            type: "new_message",
            domain: thread.chatType === "support" ? "support" : recipientRole === "vendor" ? "vendor_chat" : "customer_chat",
            title: senderRole === "vendor" ? (thread.vendorName ?? "Vendor") : (thread.customerName ?? "Customer"),
            body: messageDoc.content.slice(0, 120),
            deepLink: `platform://chat/${chatId}`,
            isCritical: false,
          });
        } catch (err) {
          logger.error("sendChatMessage: notification failed for recipient", { chatId, recipientUid, err });
        }
      })
    ),
    (async () => {
      try {
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
      } catch (err) {
        logger.error(`sendChatMessage: audit log write failed for message ${msgRef.id}`, err);
      }
    })(),
  ]);

  // Away-message check: only fires for customer-sent messages in commerce
  // threads, and only AFTER the send above has already passed every
  // block/suspension/country check — never an independent bypass path.
  //
  // Deliberately still awaited despite not gating the response on its
  // outcome (errors are swallowed below): a Cloud Function's CPU is not
  // guaranteed to keep running once its response has been sent, so an
  // un-awaited call here could get cut off mid-flight and never actually
  // send. Awaiting is the only way to guarantee it runs to completion.
  if (thread.chatType === "commerce" && senderRole === "customer" && thread.vendorId) {
    const awayMessageRecipientUid = recipients[0];
    if (awayMessageRecipientUid) {
      await sendAwayMessageIfEligible(chatId, thread.vendorId, awayMessageRecipientUid)
        .catch(() => null); // away-message failure must never fail the send
    }
  }

  return { success: true, messageId: msgRef.id };
});
