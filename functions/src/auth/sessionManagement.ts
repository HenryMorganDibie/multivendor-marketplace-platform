import { https } from "firebase-functions/v2";
import { auth, db, FieldValue } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { UserRole } from "../types";
import { createNotificationInternal } from "../notifications/notificationFunctions";

/**
 * signOutAllDevices — real session revocation.
 *
 * The Active Sessions screen listed three hardcoded devices ("iPhone 14 Pro",
 * "Chrome on Windows", "Samsung Galaxy S23", all in Canadian cities) and its
 * log-out buttons only removed the row from local component state. Nothing was
 * ever revoked, so a vendor who spotted a device they did not recognise could
 * tap "log out", watch it disappear, and believe they had secured their
 * account while the other session stayed fully active. That is worse than
 * having no feature at all.
 *
 * Firebase Auth cannot enumerate a user's devices — there is no per-device
 * session list to revoke selectively without maintaining a session registry
 * of our own, which does not exist. What it does support is invalidating every
 * refresh token at once, which is the action that actually matters when
 * someone believes their account is compromised or has left themselves signed
 * in on a computer they no longer control.
 *
 * This revokes the caller's own sessions everywhere, the current device
 * included. Saying so plainly is the point: a partial promise here is the
 * thing that was wrong before.
 */
export const signOutAllDevices = https.onCall(async (request): Promise<{ success: true }> => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "signOutAllDevices");

  if (!request.auth) {
    throw new https.HttpsError("unauthenticated", "You must be signed in.");
  }

  const uid = request.auth.uid;
  const role = (request.auth.token.role as UserRole | undefined) ?? "customer";

  await auth.revokeRefreshTokens(uid);

  // Recorded so a vendor asking "when did I last sign everything out?" has an
  // answer, and so support can distinguish a user-initiated revocation from
  // an admin one.
  await db.collection("users").doc(uid).update({
    sessionsRevokedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }).catch(() => undefined);

  await writeAuditLog({
    requestId,
    functionName: "signOutAllDevices",
    actorUid: uid,
    actorRole: role,
    actorType: role,
    targetType: "user",
    targetId: uid,
    eventType: "user.sessions_revoked",
    appCheck,
  });

  // The security settings screen claims "password changes and account
  // activity" always notify and can't be turned off — dispatchPush already
  // has a bypass rule ready for type: "security_alert", but nothing ever
  // created one. This is the real password-change flow
  // (security.tsx -> updatePassword -> signOutAllDevices), so it's also the
  // real place to raise the alert the settings copy already promises.
  await createNotificationInternal({
    recipientUid: uid,
    recipientRole: role === "vendor" ? "vendor" : role === "admin" ? "admin" : "customer",
    type: "security_alert",
    domain: "system",
    title: "Security alert",
    body: "Your password was changed and you were signed out of all other devices.",
    isCritical: true,
  }).catch((err) => console.error(`createNotificationInternal (security_alert) failed for ${uid}`, err));

  return { success: true };
});
