import { auth as functionsAuth } from "firebase-functions/v1";
import { db } from "../admin";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";

/**
 * Triggered when a Firebase Auth user is deleted.
 *
 * PII handling (P1-FB-009 fix): the audit log `before` snapshot is reduced
 * to non-PII fields only (role, accountStatus, vendorId, account age) —
 * the full user document (email, names, location) is NOT written to
 * auditLogs.
 *
 * Full data-retention/redaction for orders/chats/etc. is handled in later
 * milestones once those collections exist.
 */
export const onUserDelete = functionsAuth.user().onDelete(async (user) => {
  const uid = user.uid;
  const requestId = newRequestId();

  const userSnap = await db.collection("users").doc(uid).get();
  const userData = userSnap.exists ? userSnap.data() : null;

  await db.collection("users").doc(uid).delete();

  const safeSnapshot = userData
    ? {
        role: userData.role,
        accountStatus: userData.accountStatus,
        vendorId: userData.vendorId,
        createdAt: userData.createdAt,
      }
    : null;

  await writeAuditLog({
    requestId,
    functionName: "onUserDelete",
    actorUid: uid,
    actorRole: "system",
    actorType: "system",
    targetType: "user",
    targetId: uid,
    eventType: "user.deleted",
    before: safeSnapshot,
    message: "Firebase Auth user deleted; user document removed.",
    appCheck: { present: false, verified: null },
  });
});
