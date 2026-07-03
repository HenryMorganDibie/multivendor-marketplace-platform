import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { ChatThreadDoc, MessageDoc, VendorChatSettingsDoc, VENDOR_CHAT_SETTINGS_DEFAULTS } from "../types3";
import { checkAppCheck } from "../utils/appCheck";
import { newRequestId } from "../utils/requestContext";

/**
 * sendAwayMessageIfEligible — internal helper invoked from sendChatMessage
 * AFTER a message has been successfully sent (so it inherits whatever
 * block/suspension/country checks the primary send already passed — it
 * never runs an independent check that could bypass those rules).
 *
 * Only fires on messages sent by a CUSTOMER (i.e. the vendor is the one
 * potentially "away"). Cooldown is per-thread to avoid spamming a customer
 * who sends multiple messages while the vendor is away.
 */
export async function sendAwayMessageIfEligible(
  chatId: string,
  vendorId: string,
  vendorOwnerUid: string
): Promise<void> {
  const settingsRef = db.collection("vendors").doc(vendorId).collection("settings").doc("chat");
  const settingsSnap = await settingsRef.get();
  if (!settingsSnap.exists) return;

  const settings = settingsSnap.data() as VendorChatSettingsDoc;
  if (!settings.awayMessageEnabled || !settings.awayMessage?.trim()) return;

  const cooldownHours = settings.awayCooldownHours ?? 12;
  const lastSentMap = settings.lastAwayMessageSentAtByThread ?? {};
  const lastSentForThread = lastSentMap[chatId];

  if (lastSentForThread) {
    const lastSentMs = lastSentForThread.toMillis?.() ?? 0;
    const cooldownMs = cooldownHours * 60 * 60 * 1000;
    if (Date.now() - lastSentMs < cooldownMs) return; // still in cooldown
  }

  const threadRef = db.collection("chatThreads").doc(chatId);
  const now = FieldValue.serverTimestamp();
  const msgRef = threadRef.collection("messages").doc();

  const message: MessageDoc = {
    messageId: msgRef.id,
    chatId,
    senderUid: vendorOwnerUid,
    senderRole: "system",
    type: "system",
    systemSubtype: "away_message",
    content: settings.awayMessage.trim(),
    status: "sent",
    visibleToUser: true,
    attachments: [],
    createdAt: now,
    updatedAt: now,
  };

  await msgRef.set(message);
  await threadRef.update({
    lastMessage: settings.awayMessage.trim(),
    lastMessageType: "system",
    lastMessageAt: now,
    lastSenderUid: vendorOwnerUid,
    updatedAt: now,
  });

  await settingsRef.update({
    [`lastAwayMessageSentAtByThread.${chatId}`]: now,
    updatedAt: now,
  });
}

// ─── updateVendorChatSettings (greeting + away message config) ───────────────

export const updateVendorChatSettings = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "updateVendorChatSettings");

  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string;
  const { greetingEnabled, greetingMessage, awayMessageEnabled, awayMessage,
          awaySchedule, quietHours, awayCooldownHours } = request.data ?? {};

  if (greetingMessage && greetingMessage.length > 300) {
    throw new https.HttpsError("invalid-argument", "Greeting message must be 300 characters or fewer.");
  }
  if (awayMessage && awayMessage.length > 300) {
    throw new https.HttpsError("invalid-argument", "Away message must be 300 characters or fewer.");
  }

  const settingsRef = db.collection("vendors").doc(vendorId).collection("settings").doc("chat");
  const now = FieldValue.serverTimestamp();

  const updates: Record<string, unknown> = { updatedAt: now };
  if (greetingEnabled !== undefined) updates.greetingEnabled = greetingEnabled === true;
  if (greetingMessage !== undefined) {
    updates.greetingMessage = String(greetingMessage).trim();
    updates.greetingUpdatedAt = now;
    updates.greetingLastEditedByUid = request.auth.uid;
  }
  if (awayMessageEnabled !== undefined) updates.awayMessageEnabled = awayMessageEnabled === true;
  if (awayMessage !== undefined) updates.awayMessage = String(awayMessage).trim();
  if (awaySchedule !== undefined) updates.awaySchedule = awaySchedule;
  if (quietHours !== undefined) updates.quietHours = quietHours;
  if (awayCooldownHours !== undefined) updates.awayCooldownHours = Number(awayCooldownHours);

  const existingSnap = await settingsRef.get();
  if (!existingSnap.exists) {
    await settingsRef.set({ ...VENDOR_CHAT_SETTINGS_DEFAULTS, ...updates });
  } else {
    await settingsRef.set(updates, { merge: true });
  }

  return { success: true };
});
