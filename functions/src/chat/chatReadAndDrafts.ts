import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { ChatThreadDoc, ReadReceiptDoc, ChatDraftDoc } from "../types3";
import { checkAppCheck } from "../utils/appCheck";
import { newRequestId } from "../utils/requestContext";

// ─── markChatRead ─────────────────────────────────────────────────────────────

export const markChatRead = https.onCall(async (request) => {
  checkAppCheck(request, "markChatRead");
  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");

  const uid = request.auth.uid;
  const { chatId, lastReadMessageId } = request.data ?? {};
  if (!chatId) throw new https.HttpsError("invalid-argument", "chatId is required.");

  const threadRef = db.collection("chatThreads").doc(chatId);
  const threadSnap = await threadRef.get();
  if (!threadSnap.exists) throw new https.HttpsError("not-found", "Chat thread not found.");

  const thread = threadSnap.data() as ChatThreadDoc;
  if (!thread.participants.includes(uid)) {
    throw new https.HttpsError("permission-denied", "You are not a participant in this conversation.");
  }

  const now = FieldValue.serverTimestamp();
  const receiptRef = threadRef.collection("readReceipts").doc(uid);

  const receipt: ReadReceiptDoc = {
    uid,
    lastReadMessageId: lastReadMessageId ?? null,
    lastReadAt: now,
    unreadCount: 0,
    updatedAt: now,
  };

  await receiptRef.set(receipt, { merge: true });

  // Mark recent unread messages from OTHER senders as read, bounded batch
  // to avoid unbounded writes on very long-idle threads.
  const unreadSnap = await threadRef.collection("messages")
    .where("status", "in", ["sent", "delivered"])
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();

  const batch = db.batch();
  let anyUpdated = false;
  for (const doc of unreadSnap.docs) {
    if (doc.data().senderUid !== uid) {
      batch.update(doc.ref, { status: "read", updatedAt: now });
      anyUpdated = true;
    }
  }
  if (anyUpdated) await batch.commit();

  return { success: true };
});

// ─── saveChatDraft / clearChatDraft ───────────────────────────────────────────

export const saveChatDraft = https.onCall(async (request) => {
  checkAppCheck(request, "saveChatDraft");
  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");

  const uid = request.auth.uid;
  const { chatId, content } = request.data ?? {};
  if (!chatId) throw new https.HttpsError("invalid-argument", "chatId is required.");

  const draftRef = db.collection("users").doc(uid).collection("chatDrafts").doc(chatId);
  const now = FieldValue.serverTimestamp();

  if (!content || !content.trim()) {
    await draftRef.delete().catch(() => null);
    return { success: true, cleared: true };
  }

  const draft: ChatDraftDoc = {
    chatId,
    uid,
    content: content.slice(0, 4000),
    updatedAt: now,
  };
  await draftRef.set(draft);

  return { success: true, cleared: false };
});

export const clearChatDraft = https.onCall(async (request) => {
  checkAppCheck(request, "clearChatDraft");
  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");

  const uid = request.auth.uid;
  const { chatId } = request.data ?? {};
  if (!chatId) throw new https.HttpsError("invalid-argument", "chatId is required.");

  await db.collection("users").doc(uid).collection("chatDrafts").doc(chatId)
    .delete().catch(() => null);

  return { success: true };
});
