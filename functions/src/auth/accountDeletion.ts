import { https } from "firebase-functions/v2";
import { db, auth, FieldValue } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { UserRole } from "../types";

const DELETION_GRACE_PERIOD_DAYS = 90;

/**
 * requestAccountDeletion — soft delete only.
 *
 * Marks users/{uid}.accountStatus = "pending_deletion" and revokes existing
 * sessions everywhere, matching what both the vendor and customer deletion
 * screens already promise the user ("logged out immediately", "90 days to
 * undo"). Nothing else is touched: vendors/{vendorId}, orders, chats,
 * catalog items, invoices all remain exactly as they were. There is no purge
 * job — going from "pending_deletion" back to "active" is the only other
 * state this status ever moves to (see restoreAccountIfEligible below).
 */
export const requestAccountDeletion = https.onCall(
  async (request): Promise<{ success: true }> => {
    const requestId = newRequestId();
    const appCheck = checkAppCheck(request, "requestAccountDeletion");

    if (!request.auth) {
      throw new https.HttpsError("unauthenticated", "You must be signed in to request account deletion.");
    }

    const uid = request.auth.uid;
    const role = (request.auth.token.role as UserRole | undefined) ?? "customer";
    const reason = typeof request.data?.reason === "string" ? request.data.reason.slice(0, 120) : null;
    const feedback = typeof request.data?.feedback === "string" ? request.data.feedback.slice(0, 300) : null;

    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throw new https.HttpsError("not-found", "Account not found.");
    }

    const before = userSnap.data()?.accountStatus ?? "active";

    await userRef.update({
      accountStatus: "pending_deletion",
      deletionRequestedAt: FieldValue.serverTimestamp(),
      deletionReason: reason,
      deletionFeedback: feedback,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // "You will be logged out immediately" — true on every device, not just
    // the one that made this request.
    await auth.revokeRefreshTokens(uid);

    await writeAuditLog({
      requestId,
      functionName: "requestAccountDeletion",
      actorUid: uid,
      actorRole: role,
      actorType: role,
      targetType: "user",
      targetId: uid,
      eventType: "user.deletion_requested",
      before: { accountStatus: before },
      after: { accountStatus: "pending_deletion" },
      metadata: reason ? { reason } : undefined,
      appCheck,
    });

    return { success: true };
  }
);

/**
 * restoreAccountIfEligible — the self-service undo both deletion screens
 * describe ("log back in within 90 days"). Called from the client's login
 * flow the moment it sees accountStatus === "pending_deletion", before that
 * status gets treated as a hard block.
 *
 * Only ever restores its own caller's account, and only within the grace
 * period — outside that window (or for any other blocked status) this is a
 * no-op and the normal block stands.
 */
export const restoreAccountIfEligible = https.onCall(
  async (request): Promise<{ restored: boolean }> => {
    const requestId = newRequestId();
    const appCheck = checkAppCheck(request, "restoreAccountIfEligible");

    if (!request.auth) {
      throw new https.HttpsError("unauthenticated", "You must be signed in.");
    }

    const uid = request.auth.uid;
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return { restored: false };
    }

    const data = userSnap.data() ?? {};
    if (data.accountStatus !== "pending_deletion") {
      return { restored: false };
    }

    const requestedAt = data.deletionRequestedAt?.toDate?.() as Date | undefined;
    if (!requestedAt) {
      return { restored: false };
    }

    const daysSince = (Date.now() - requestedAt.getTime()) / (24 * 60 * 60 * 1000);
    if (daysSince > DELETION_GRACE_PERIOD_DAYS) {
      return { restored: false };
    }

    await userRef.update({
      accountStatus: "active",
      deletionRequestedAt: null,
      deletionReason: null,
      deletionFeedback: null,
      updatedAt: FieldValue.serverTimestamp(),
    });

    await writeAuditLog({
      requestId,
      functionName: "restoreAccountIfEligible",
      actorUid: uid,
      actorRole: (request.auth.token.role as UserRole | undefined) ?? "customer",
      actorType: (request.auth.token.role as UserRole | undefined) ?? "customer",
      targetType: "user",
      targetId: uid,
      eventType: "user.deletion_undone",
      before: { accountStatus: "pending_deletion" },
      after: { accountStatus: "active" },
      appCheck,
    });

    return { restored: true };
  }
);
