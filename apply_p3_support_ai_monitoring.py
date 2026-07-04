#!/usr/bin/env python3
"""
apply_p3_support_ai_monitoring.py

Applies P3-FB-015 (Support Chat Foundation), P3-FB-016 (AI Help Placeholder
Foundation), and P3-FB-019 (Monitoring, Logging & Alerting) to the the platform
backend repository.

Run this from the repository root, i.e. the directory containing
'functions', 'firestore', 'scripts', and 'docs'.

    python apply_p3_support_ai_monitoring.py

The script is idempotent for the three new files it creates: rerunning it
will overwrite them with identical content rather than duplicate anything.
The three modified files (paymentProofs.ts, sendPickupDetails.ts, index.ts,
firestore.rules) are patched via exact string replacement. If a target
string is not found, indicating the file has since diverged from the state
this script expects, the script stops and reports exactly which patch
failed rather than applying partial changes silently.
"""

import sys
from pathlib import Path

ROOT = Path.cwd()
FUNCTIONS_SRC = ROOT / "functions" / "src"
FIRESTORE_RULES = ROOT / "firestore" / "firestore.rules"

errors = []
applied = []


def require_exists(path: Path, label: str) -> bool:
    if not path.exists():
        errors.append(f"Expected {label} at {path}, but it does not exist. "
                       f"Are you running this from the repository root?")
        return False
    return True


def write_new_file(path: Path, content: str, label: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", newline="\n")
    applied.append(f"Wrote {label} -> {path.relative_to(ROOT)}")


def patch_file(path: Path, old: str, new: str, label: str) -> None:
    if not require_exists(path, label):
        return
    text = path.read_text(encoding="utf-8")
    if old not in text:
        errors.append(
            f"Patch target not found in {path.relative_to(ROOT)} for '{label}'. "
            f"This file may have changed since this script was written. "
            f"No changes were made to this file."
        )
        return
    count = text.count(old)
    if count > 1:
        errors.append(
            f"Patch target for '{label}' appears {count} times in "
            f"{path.relative_to(ROOT)}, expected exactly once. Skipping to "
            f"avoid an ambiguous replacement. No changes were made to this file."
        )
        return
    text = text.replace(old, new)
    path.write_text(text, encoding="utf-8", newline="\n")
    applied.append(f"Patched {label} -> {path.relative_to(ROOT)}")


# ─────────────────────────────────────────────────────────────────────────
# 1. types3.ts — insert SupportTicket types before the Pickup settings divider
# ─────────────────────────────────────────────────────────────────────────

TYPES3_OLD = '''// ─── Pickup settings ────────────────────────────────────────────────────────'''

TYPES3_NEW = '''// ─── Support tickets (P3-FB-015) ────────────────────────────────────────────────

/**
 * A support ticket wraps exactly one chatThreads document with
 * chatType: "support". The chatThreads document remains the source of
 * truth for participants, messages, and read state, following the same
 * generic mechanics already built for commerce threads. This document
 * carries the ticket-lifecycle fields that a commerce thread has no
 * concept of: status, priority, and admin assignment.
 *
 * One open ticket per requester at a time is enforced at creation time,
 * mirroring the "one canonical thread" discipline already established
 * for commerce conversations, so a requester cannot flood the queue with
 * duplicate open tickets for the same underlying issue.
 */
export type SupportTicketStatus = "open" | "assigned" | "resolved" | "closed";
export type SupportTicketPriority = "low" | "normal" | "high" | "urgent";

export interface SupportTicketDoc {
  ticketId: string;       // same value as the underlying chatId
  chatId: string;
  requesterUid: string;
  requesterRole: "customer" | "vendor";
  subject: string;

  status: SupportTicketStatus;
  priority: SupportTicketPriority;

  assignedAdminUid?: string | null;
  assignedAt?: firestore.Timestamp | firestore.FieldValue | null;

  resolvedAt?: firestore.Timestamp | firestore.FieldValue | null;
  resolvedByAdminUid?: string | null;
  closedAt?: firestore.Timestamp | firestore.FieldValue | null;

  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

export const SUPPORT_TICKET_LIMITS = {
  maxSubjectLength: 150,
} as const;

// ─── Pickup settings ────────────────────────────────────────────────────────'''


# ─────────────────────────────────────────────────────────────────────────
# 2. support/supportTicketFunctions.ts — new file, full content
# ─────────────────────────────────────────────────────────────────────────

SUPPORT_TICKET_FUNCTIONS = '''import { https } from "firebase-functions/v2";
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
'''


# ─────────────────────────────────────────────────────────────────────────
# 3. ai/aiHelpFunctions.ts — new file, full content
# ─────────────────────────────────────────────────────────────────────────

AI_HELP_FUNCTIONS = '''import { https } from "firebase-functions/v2";
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
'''


# ─────────────────────────────────────────────────────────────────────────
# 4. utils/operationalLogging.ts — new file, full content
# ─────────────────────────────────────────────────────────────────────────

OPERATIONAL_LOGGING = '''import { logger } from "firebase-functions/v2";

/**
 * Structured operational logging (P3-FB-019).
 *
 * This is deliberately separate from writeAuditLog in utils/auditLog.ts.
 * The audit log is a durable, queryable business record of who did what,
 * stored in Firestore, and is the correct source for compliance and
 * dispute review. This module is for operational signals, elevated error
 * rates, slow execution, abuse patterns, that need to reach Cloud
 * Logging in a structured, severity-tagged format so Cloud Monitoring
 * log-based alerting policies can filter and page on them in real time.
 * Writing operational alerts as Firestore documents would mean nobody
 * sees them during an actual incident unless they happen to be looking.
 *
 * This module does not create Cloud Monitoring alerting policies itself.
 * Alerting policies are Google Cloud console configuration, not
 * application code, and must be created by whoever holds console access
 * to the Firebase/GCP project. What this module provides is the
 * structured, filterable log output those policies would match against.
 * See the ALERT CONDITIONS block at the bottom of this file for the
 * exact filters to configure.
 */

interface OperationalLogParams {
  functionName: string;
  event: string;
  severity: "WARNING" | "ERROR" | "CRITICAL";
  metadata?: Record<string, unknown>;
}

/**
 * logOperationalEvent — call this for conditions that represent a
 * potential operational problem rather than routine business activity:
 * a function call that failed unexpectedly, a rate limit being hit
 * repeatedly by the same actor, a transaction that had to retry due to
 * contention, or a downstream dependency (Storage, Auth, an external
 * push provider) returning an error.
 *
 * Every entry is tagged with `component: "the platform-backend"` and the
 * calling function's name, which is the minimum structure a Cloud
 * Monitoring log-based metric needs to filter on this application's
 * output specifically, distinct from Firebase's own platform logs.
 */
export function logOperationalEvent(params: OperationalLogParams): void {
  const payload = {
    component: "the platform-backend",
    functionName: params.functionName,
    event: params.event,
    ...params.metadata,
  };

  switch (params.severity) {
    case "CRITICAL":
      logger.error(payload);
      break;
    case "ERROR":
      logger.error(payload);
      break;
    case "WARNING":
    default:
      logger.warn(payload);
      break;
  }
}

/**
 * withOperationalLogging — wraps an async operation, logging duration and
 * outcome. Use this around any Cloud Function body where execution time
 * matters (transaction-heavy functions, functions calling external
 * services) so slow executions become visible in structured logs without
 * every function needing to hand-roll its own timing code.
 */
export async function withOperationalLogging<T>(
  functionName: string,
  operation: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    const durationMs = Date.now() - startedAt;
    if (durationMs > 5000) {
      logOperationalEvent({
        functionName,
        event: "slow_execution",
        severity: "WARNING",
        metadata: { durationMs },
      });
    }
    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    logOperationalEvent({
      functionName,
      event: "unhandled_error",
      severity: "ERROR",
      metadata: {
        durationMs,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

/**
 * ALERT CONDITIONS — configure these as Cloud Monitoring log-based
 * alerting policies in the Google Cloud console under Monitoring >
 * Alerting, using the Logs Explorer filter syntax shown. This is
 * documentation for manual console setup, not code this repository can
 * provision on its own, since alerting policies are project-level
 * infrastructure configuration outside a Cloud Functions deployment.
 *
 * 1. Elevated error rate
 *    Filter: resource.type="cloud_function" AND jsonPayload.component="the platform-backend" AND severity="ERROR"
 *    Condition: count > 10 within 5 minutes
 *    Rationale: a burst of unhandled errors across any function usually
 *    indicates a bad deploy, a Firestore outage, or a downstream
 *    dependency failure, and should page whoever owns production.
 *
 * 2. Repeated slow execution on a single function
 *    Filter: jsonPayload.component="the platform-backend" AND jsonPayload.event="slow_execution"
 *    Condition: count > 5 within 10 minutes, grouped by jsonPayload.functionName
 *    Rationale: isolates a specific function degrading rather than a
 *    general platform issue, which usually points at an unindexed query
 *    or a transaction contention hotspot in that function specifically.
 *
 * 3. Payment proof abuse lock triggered repeatedly
 *    Filter: jsonPayload.component="the platform-backend" AND jsonPayload.event="PAYMENT_PROOF_LIMIT_REACHED"
 *    Condition: count > 20 within 1 hour, project-wide
 *    Rationale: a spike here across many distinct orders, rather than
 *    isolated to one customer, may indicate a coordinated abuse attempt
 *    rather than ordinary customer confusion during checkout.
 *
 * 4. App Check monitor-mode rejection rate
 *    Filter: jsonPayload.message="[AppCheck] Missing/invalid App Check token"
 *    Condition: ratio of App Check failures to total requests exceeds a
 *    threshold you set once real mobile traffic is flowing, as the
 *    concrete signal for when it is safe to flip APP_CHECK_ENFORCE to true.
 */
'''


# ─────────────────────────────────────────────────────────────────────────
# 5. paymentProofs.ts — two patches
# ─────────────────────────────────────────────────────────────────────────

PAYMENT_PROOFS_PATH = FUNCTIONS_SRC / "orders" / "paymentProofs.ts"

PAYMENT_PROOFS_IMPORT_OLD = 'import { sendPickupDetailsIfEligible } from "../chat/sendPickupDetails";'
PAYMENT_PROOFS_IMPORT_NEW = ('import { sendPickupDetailsIfEligible } from "../chat/sendPickupDetails";\n'
                             'import { logOperationalEvent } from "../utils/operationalLogging";')

PAYMENT_PROOFS_LOG_OLD = ('    await writeOrderEvent({ orderId, vendorId: order.vendorId, '
                           'eventType: "PAYMENT_PROOF_LIMIT_REACHED", actorUid: customerId, '
                           'actorRole: "customer", metadata: { submissionCount: totalSubmissions } });')
PAYMENT_PROOFS_LOG_NEW = ('    await writeOrderEvent({ orderId, vendorId: order.vendorId, '
                           'eventType: "PAYMENT_PROOF_LIMIT_REACHED", actorUid: customerId, '
                           'actorRole: "customer", metadata: { submissionCount: totalSubmissions } });\n'
                           '    logOperationalEvent({\n'
                           '      functionName: "submitPaymentProof",\n'
                           '      event: "PAYMENT_PROOF_LIMIT_REACHED",\n'
                           '      severity: "WARNING",\n'
                           '      metadata: { orderId, vendorId: order.vendorId, customerId, submissionCount: totalSubmissions },\n'
                           '    });')


# ─────────────────────────────────────────────────────────────────────────
# 6. sendPickupDetails.ts — two patches
# ─────────────────────────────────────────────────────────────────────────

SEND_PICKUP_PATH = FUNCTIONS_SRC / "chat" / "sendPickupDetails.ts"

SEND_PICKUP_IMPORT_OLD = 'import { createNotificationInternal } from "../notifications/notificationFunctions";'
SEND_PICKUP_IMPORT_NEW = ('import { createNotificationInternal } from "../notifications/notificationFunctions";\n'
                           'import { logOperationalEvent } from "../utils/operationalLogging";')

SEND_PICKUP_CATCH_OLD = ('''  } catch (err) {
    logger.error(`sendPickupDetailsIfEligible transaction failed for order ${orderId}`, err);
    return;
  }''')
SEND_PICKUP_CATCH_NEW = ('''  } catch (err) {
    logOperationalEvent({
      functionName: "sendPickupDetailsIfEligible",
      event: "unhandled_error",
      severity: "ERROR",
      metadata: {
        orderId,
        vendorId,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    return;
  }''')


# ─────────────────────────────────────────────────────────────────────────
# 7. index.ts — append new exports
# ─────────────────────────────────────────────────────────────────────────

INDEX_PATH = FUNCTIONS_SRC / "index.ts"

INDEX_OLD = '''// ── Phase 3: Notifications ────────────────────────────────────────────────────
export { markNotificationRead, registerPushToken } from "./notifications/notificationFunctions";
export { updateVendorNotificationPreferences,
         updateCustomerNotificationPreferences } from "./notifications/notificationPreferences";'''

INDEX_NEW = '''// ── Phase 3: Notifications ────────────────────────────────────────────────────
export { markNotificationRead, registerPushToken } from "./notifications/notificationFunctions";
export { updateVendorNotificationPreferences,
         updateCustomerNotificationPreferences } from "./notifications/notificationPreferences";

// ── Phase 3: Support tickets ──────────────────────────────────────────────────
export { createSupportTicket, assignSupportTicket, resolveSupportTicket } from "./support/supportTicketFunctions";

// ── Phase 3: AI help placeholder ──────────────────────────────────────────────
export { createAiHelpThread } from "./ai/aiHelpFunctions";'''


# ─────────────────────────────────────────────────────────────────────────
# 8. firestore.rules — insert supportTickets block after chatThreads block
# ─────────────────────────────────────────────────────────────────────────

RULES_OLD = '''    match /chatThreads/{chatId} {
      allow read: if isSignedIn() && request.auth.uid in resource.data.participants;
      allow create, update, delete: if false;

      match /messages/{messageId} {
        allow read: if isSignedIn() &&
          request.auth.uid in get(/databases/$(database)/documents/chatThreads/$(chatId)).data.participants;
        allow create, update, delete: if false;
      }

      match /readReceipts/{uid} {
        allow read: if isSignedIn() &&
          request.auth.uid in get(/databases/$(database)/documents/chatThreads/$(chatId)).data.participants;
        // Direct write allowed only by the receipt's own owner — matches
        // markChatRead's intended caller, kept as a rule (not function-only)
        // since blast radius is limited to the user's own read state.
        allow write: if isSignedIn() && request.auth.uid == uid;
      }
    }'''

RULES_NEW = '''    match /chatThreads/{chatId} {
      allow read: if isSignedIn() && request.auth.uid in resource.data.participants;
      allow create, update, delete: if false;

      match /messages/{messageId} {
        allow read: if isSignedIn() &&
          request.auth.uid in get(/databases/$(database)/documents/chatThreads/$(chatId)).data.participants;
        allow create, update, delete: if false;
      }

      match /readReceipts/{uid} {
        allow read: if isSignedIn() &&
          request.auth.uid in get(/databases/$(database)/documents/chatThreads/$(chatId)).data.participants;
        // Direct write allowed only by the receipt's own owner — matches
        // markChatRead's intended caller, kept as a rule (not function-only)
        // since blast radius is limited to the user's own read state.
        allow write: if isSignedIn() && request.auth.uid == uid;
      }
    }

    // -----------------------------------------------------------------------
    // Phase 3: Support tickets (P3-FB-015)
    // Readable by the requester who opened the ticket, by the currently
    // assigned admin, and by any admin generally for queue visibility.
    // All writes go through createSupportTicket, assignSupportTicket, and
    // resolveSupportTicket, never direct client writes, since ticket
    // status transitions carry business rules (only the assigned agent or
    // a super_admin may resolve) that a Firestore rule cannot express as
    // cleanly as the Cloud Functions that already enforce it.
    // -----------------------------------------------------------------------
    match /supportTickets/{ticketId} {
      allow read: if isSignedIn() && (
        request.auth.uid == resource.data.requesterUid
        || isAdmin()
      );
      allow create, update, delete: if false;
    }'''


def main() -> int:
    print(f"Applying P3-FB-015, P3-FB-016, P3-FB-019 from: {ROOT}\\n")

    if not require_exists(FUNCTIONS_SRC, "functions/src directory"):
        print("\\n".join(errors))
        return 1

    types3_path = FUNCTIONS_SRC / "types3.ts"
    patch_file(types3_path, TYPES3_OLD, TYPES3_NEW, "types3.ts support ticket types insertion")

    write_new_file(
        FUNCTIONS_SRC / "support" / "supportTicketFunctions.ts",
        SUPPORT_TICKET_FUNCTIONS,
        "support/supportTicketFunctions.ts",
    )

    write_new_file(
        FUNCTIONS_SRC / "ai" / "aiHelpFunctions.ts",
        AI_HELP_FUNCTIONS,
        "ai/aiHelpFunctions.ts",
    )

    write_new_file(
        FUNCTIONS_SRC / "utils" / "operationalLogging.ts",
        OPERATIONAL_LOGGING,
        "utils/operationalLogging.ts",
    )

    patch_file(PAYMENT_PROOFS_PATH, PAYMENT_PROOFS_IMPORT_OLD, PAYMENT_PROOFS_IMPORT_NEW,
               "paymentProofs.ts import addition")
    patch_file(PAYMENT_PROOFS_PATH, PAYMENT_PROOFS_LOG_OLD, PAYMENT_PROOFS_LOG_NEW,
               "paymentProofs.ts operational log call")

    patch_file(SEND_PICKUP_PATH, SEND_PICKUP_IMPORT_OLD, SEND_PICKUP_IMPORT_NEW,
               "sendPickupDetails.ts import addition")
    patch_file(SEND_PICKUP_PATH, SEND_PICKUP_CATCH_OLD, SEND_PICKUP_CATCH_NEW,
               "sendPickupDetails.ts structured error logging")

    patch_file(INDEX_PATH, INDEX_OLD, INDEX_NEW, "index.ts new exports")

    patch_file(FIRESTORE_RULES, RULES_OLD, RULES_NEW, "firestore.rules supportTickets block")

    print("\\n--- Applied ---")
    for line in applied:
        print(f"  {line}")

    if errors:
        print("\\n--- Errors ---")
        for line in errors:
            print(f"  {line}")
        print(f"\\n{len(errors)} patch(es) failed. Review the messages above. "
              f"Files not listed under 'Applied' were not modified.")
        return 1

    print(f"\\nAll {len(applied)} changes applied successfully.")
    print("\\nNext steps:")
    print("  cd functions")
    print("  npx tsc --noEmit")
    print("  cd ..")
    print("  # then run your Milestone 3 acceptance test suite to confirm no regression")
    return 0


if __name__ == "__main__":
    sys.exit(main())