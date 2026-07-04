import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { ChatThreadDoc, SupportTicketDoc, SupportTicketPriority, SUPPORT_TICKET_LIMITS } from "../types3";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { assertAdmin } from "../utils/adminAuth";
import { createNotificationInternal } from "../notifications/notificationFunctions";

/**
 * Support ticket lifecycle (P3-FB-015).
 *
 * A support ticket is implemented as a chatThreads document with
 * chatType: "support", paired one-to-one with a supportTickets document
 * carrying the lifecycle fields a commerce thread has no concept of.
 * Message sending, read receipts, and drafts all reuse the existing
 * generic chat mechanics in sendChatMessage.ts, markChatRead, and
 * saveChatDraft without modification, since those functions already
 * branch on chatType and skip commerce-specific checks for support
 * threads.
 */

// ─── createSupportTicket ──────────────────────────────────────────────────────

export const createSupportTicket = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "createSupportTicket");

  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");

  const requesterUid = request.auth.uid;
  const requesterRole = request.auth.token.role as "customer" | "vendor" | undefined;
  const { subject, initialMessage } = request.data ?? {};

  if (requesterRole !== "customer" && requesterRole !== "vendor") {
    throw new https.HttpsError("failed-precondition", "Requester role could not be determined.");
  }
  if (!subject?.trim() || subject.length > SUPPORT_TICKET_LIMITS.maxSubjectLength) {
    throw new https.HttpsError(
      "invalid-argument",
      `subject is required, maximum ${SUPPORT_TICKET_LIMITS.maxSubjectLength} characters.`
    );
  }
  if (!initialMessage?.trim()) {
    throw new https.HttpsError("invalid-argument", "initialMessage is required.");
  }

  // Enforce one open ticket per requester at a time, mirroring the
  // canonical-thread discipline already applied to commerce conversations.
  const existingOpenSnap = await db.collection("supportTickets")
    .where("requesterUid", "==", requesterUid)
    .where("status", "in", ["open", "assigned"])
    .limit(1)
    .get();

  if (!existingOpenSnap.empty) {
    const existing = existingOpenSnap.docs[0].data() as SupportTicketDoc;
    return { success: true, ticketId: existing.ticketId, chatId: existing.chatId, created: false };
  }

  const chatRef = db.collection("chatThreads").doc();
  const chatId = chatRef.id;
  const now = FieldValue.serverTimestamp();

  const threadDoc: ChatThreadDoc = {
    chatId,
    chatType: "support",
    participants: [requesterUid],
    participantRoles: { [requesterUid]: requesterRole },
    relatedOrderIds: [],
    title: subject.trim(),
    lastMessage: initialMessage.trim().slice(0, 200),
    lastMessageType: "text",
    lastMessageAt: now,
    lastSenderUid: requesterUid,
    archivedBy: [],
    blockedState: "none",
    isSupportEscalated: false,
    greetingSentAt: null,
    createdAt: now,
    updatedAt: now,
  };

  const ticketDoc: SupportTicketDoc = {
    ticketId: chatId,
    chatId,
    requesterUid,
    requesterRole,
    subject: subject.trim(),
    status: "open",
    priority: "normal",
    assignedAdminUid: null,
    assignedAt: null,
    resolvedAt: null,
    resolvedByAdminUid: null,
    closedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  const batch = db.batch();
  batch.set(chatRef, threadDoc);
  batch.set(db.collection("supportTickets").doc(chatId), ticketDoc);

  const msgRef = chatRef.collection("messages").doc();
  batch.set(msgRef, {
    messageId: msgRef.id,
    chatId,
    senderUid: requesterUid,
    senderRole: requesterRole,
    type: "text",
    content: initialMessage.trim(),
    status: "sent",
    visibleToUser: true,
    attachments: [],
    createdAt: now,
    updatedAt: now,
  });

  await batch.commit();

  await writeAuditLog({
    requestId,
    functionName: "createSupportTicket",
    actorUid: requesterUid,
    actorRole: requesterRole,
    actorType: requesterRole,
    targetType: "supportTicket",
    targetId: chatId,
    eventType: "support.ticket_created",
    after: { subject: subject.trim() },
    appCheck,
  });

  return { success: true, ticketId: chatId, chatId, created: true };
});

// ─── assignSupportTicket ───────────────────────────────────────────────────────

export const assignSupportTicket = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "assignSupportTicket");

  const admin = await assertAdmin(request, ["super_admin", "support_admin"]);

  const { ticketId, priority } = request.data ?? {};
  if (!ticketId) throw new https.HttpsError("invalid-argument", "ticketId is required.");

  const ticketRef = db.collection("supportTickets").doc(ticketId);
  const ticketSnap = await ticketRef.get();
  if (!ticketSnap.exists) throw new https.HttpsError("not-found", "Support ticket not found.");

  const ticket = ticketSnap.data() as SupportTicketDoc;
  if (ticket.status === "resolved" || ticket.status === "closed") {
    throw new https.HttpsError("failed-precondition", "Cannot assign a resolved or closed ticket.");
  }

  const validPriorities: SupportTicketPriority[] = ["low", "normal", "high", "urgent"];
  if (priority !== undefined && !validPriorities.includes(priority)) {
    throw new https.HttpsError("invalid-argument", `priority must be one of: ${validPriorities.join(", ")}.`);
  }

  const now = FieldValue.serverTimestamp();
  const updates: Record<string, unknown> = {
    status: "assigned",
    assignedAdminUid: admin.uid,
    assignedAt: now,
    updatedAt: now,
  };
  if (priority !== undefined) updates.priority = priority;

  const batch = db.batch();
  batch.update(ticketRef, updates);
  batch.update(db.collection("chatThreads").doc(ticket.chatId), {
    participants: FieldValue.arrayUnion(admin.uid),
    [`participantRoles.${admin.uid}`]: "admin",
    updatedAt: now,
  });
  await batch.commit();

  await createNotificationInternal({
    recipientUid: ticket.requesterUid,
    recipientRole: ticket.requesterRole,
    type: "support_ticket_assigned",
    domain: "support",
    title: "Your support request has been picked up",
    body: `An agent is now reviewing: ${ticket.subject}`,
    deepLink: `the platform://chat/${ticket.chatId}`,
    isCritical: false,
  });

  await writeAuditLog({
    requestId,
    functionName: "assignSupportTicket",
    actorUid: admin.uid,
    actorRole: "admin",
    actorType: "admin",
    targetType: "supportTicket",
    targetId: ticketId,
    eventType: "support.ticket_assigned",
    appCheck,
  });

  return { success: true };
});

// ─── resolveSupportTicket ──────────────────────────────────────────────────────

export const resolveSupportTicket = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "resolveSupportTicket");

  const admin = await assertAdmin(request, ["super_admin", "support_admin"]);

  const { ticketId } = request.data ?? {};
  if (!ticketId) throw new https.HttpsError("invalid-argument", "ticketId is required.");

  const ticketRef = db.collection("supportTickets").doc(ticketId);
  const ticketSnap = await ticketRef.get();
  if (!ticketSnap.exists) throw new https.HttpsError("not-found", "Support ticket not found.");

  const ticket = ticketSnap.data() as SupportTicketDoc;
  if (ticket.status !== "assigned") {
    throw new https.HttpsError("failed-precondition", "Only an assigned ticket can be resolved.");
  }
  if (ticket.assignedAdminUid !== admin.uid && !admin.roleIds.includes("super_admin")) {
    throw new https.HttpsError("permission-denied", "Only the assigned agent or a super admin can resolve this ticket.");
  }

  const now = FieldValue.serverTimestamp();
  await ticketRef.update({
    status: "resolved",
    resolvedAt: now,
    resolvedByAdminUid: admin.uid,
    updatedAt: now,
  });

  await createNotificationInternal({
    recipientUid: ticket.requesterUid,
    recipientRole: ticket.requesterRole,
    type: "support_ticket_resolved",
    domain: "support",
    title: "Your support request has been resolved",
    body: ticket.subject,
    deepLink: `the platform://chat/${ticket.chatId}`,
    isCritical: false,
  });

  await writeAuditLog({
    requestId,
    functionName: "resolveSupportTicket",
    actorUid: admin.uid,
    actorRole: "admin",
    actorType: "admin",
    targetType: "supportTicket",
    targetId: ticketId,
    eventType: "support.ticket_resolved",
    appCheck,
  });

  return { success: true };
});
