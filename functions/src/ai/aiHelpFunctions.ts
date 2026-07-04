import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { ChatThreadDoc, MessageDoc } from "../types3";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";

/**
 * AI help placeholder (P3-FB-016).
 *
 * Per the architecture document, Section 10, EVA/AI is explicitly
 * post-MVP. This function creates a chatType: "ai_help" thread and posts
 * a single canned response. It does not call any language model, does
 * not maintain conversation state beyond the generic chatThreads
 * mechanics, and must not be extended to do so without a separate,
 * deliberate architectural decision, since the reserved evaKnowledgeBases,
 * evaConversations, evaEscalations, and aiAuditLogs namespaces exist
 * precisely to hold that future design rather than have it grafted onto
 * this placeholder ad hoc.
 *
 * One thread per user, matching the deterministic-ID discipline already
 * used for commerce threads, so repeated calls are idempotent rather than
 * spawning duplicate placeholder conversations.
 */

const CANNED_RESPONSE =
  "Thanks for reaching out. AI assistance is not yet available in the platform. " +
  "For help right now, please use Contact Support from your settings menu.";

function aiHelpThreadId(uid: string): string {
  return `ai_help_${uid}`;
}

export const createAiHelpThread = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "createAiHelpThread");

  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");

  const uid = request.auth.uid;
  const role = request.auth.token.role as "customer" | "vendor" | undefined;
  if (role !== "customer" && role !== "vendor") {
    throw new https.HttpsError("failed-precondition", "Role could not be determined.");
  }

  const chatId = aiHelpThreadId(uid);
  const threadRef = db.collection("chatThreads").doc(chatId);
  const now = FieldValue.serverTimestamp();

  const existingSnap = await threadRef.get();
  if (existingSnap.exists) {
    return { success: true, chatId, created: false };
  }

  let created = false;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(threadRef);
    if (snap.exists) return;

    const threadDoc: ChatThreadDoc = {
      chatId,
      chatType: "ai_help",
      participants: [uid],
      participantRoles: { [uid]: role },
      relatedOrderIds: [],
      title: "the platform Help",
      lastMessage: CANNED_RESPONSE,
      lastMessageType: "ai",
      lastMessageAt: now,
      lastSenderUid: "system",
      archivedBy: [],
      blockedState: "none",
      isSupportEscalated: false,
      greetingSentAt: null,
      createdAt: now,
      updatedAt: now,
    };
    tx.set(threadRef, threadDoc);

    const msgRef = threadRef.collection("messages").doc();
    const message: MessageDoc = {
      messageId: msgRef.id,
      chatId,
      senderUid: "system",
      senderRole: "ai",
      type: "ai",
      content: CANNED_RESPONSE,
      status: "sent",
      visibleToUser: true,
      attachments: [],
      createdAt: now,
      updatedAt: now,
    };
    tx.set(msgRef, message);

    created = true;
  });

  await writeAuditLog({
    requestId,
    functionName: "createAiHelpThread",
    actorUid: uid,
    actorRole: role,
    actorType: role,
    targetType: "chatThread",
    targetId: chatId,
    eventType: created ? "ai_help.thread_created" : "ai_help.thread_reused",
    appCheck,
  });

  return { success: true, chatId, created };
});
