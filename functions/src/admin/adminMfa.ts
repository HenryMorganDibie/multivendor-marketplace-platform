import { https } from "firebase-functions/v2";
import { authenticator } from "otplib";
import { db, FieldValue } from "../admin";
import { assertAdmin } from "../utils/adminAuth";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { enforceRateLimit } from "../subscriptions/rateLimit";

/**
 * MFA enforcement for admins — named explicitly in the accepted Milestone 1
 * scope text ("Firebase Auth setup, custom claims..., MFA enforcement for
 * admins, dev/staging/production environment setup"), already paid for.
 * adminUsers/{uid}.mfaRequired/mfaEnrolled/lastMfaAt and
 * adminSessions/{id}.mfaVerifiedAt have existed on the schema since
 * acceptAdminInvite/recordAdminSession were built (adminInvites.ts), but
 * nothing ever generated a secret, verified a code, or checked either field
 * before granting access — assertAdmin() only ever checked role + active
 * status. This file is the missing enrollment/verification half; the check
 * itself lives in utils/adminAuth.ts.
 *
 * The TOTP secret is never stored on adminUsers/{uid} — that document is
 * readable by ANY admin (firestore.rules: `allow read: if isAdmin()`, not
 * scoped to the caller's own uid), so a secret living there would leak to
 * every other admin. adminMfaSecrets/{uid} is a separate, Cloud-Function-
 * only collection (`allow read, write: if false`, same pattern as
 * subscriptionLocks/providerPlanCodes) for exactly this reason.
 */

interface AdminMfaSecretDoc {
  uid: string;
  secret: string;
  verified: boolean;
  createdAt: FirebaseFirestore.FieldValue | FirebaseFirestore.Timestamp;
  verifiedAt?: FirebaseFirestore.FieldValue | FirebaseFirestore.Timestamp | null;
}

function verifyCode(secret: string, code: string): boolean {
  const trimmed = String(code ?? "").trim();
  if (!/^\d{6}$/.test(trimmed)) return false;
  try {
    return authenticator.verify({ token: trimmed, secret });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// beginAdminMfaEnrollment — any active admin, once (re-enrolling replaces
// the pending secret; does not touch mfaEnrolled until confirmed)
// ---------------------------------------------------------------------------
export const beginAdminMfaEnrollment = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "beginAdminMfaEnrollment");
  await enforceRateLimit(
    request.auth?.uid ?? `ip:${request.rawRequest?.ip ?? "unknown"}`,
    "beginAdminMfaEnrollment",
    5,
  );
  // skipMfaCheck: this is the bootstrap step before a secret exists at all —
  // it can't itself require MFA verification.
  const { uid, roleIds } = await assertAdmin(request, undefined, { skipMfaCheck: true });

  const adminSnap = await db.collection("adminUsers").doc(uid).get();
  const email = (adminSnap.data()?.email as string | undefined) ?? uid;

  const secret = authenticator.generateSecret();
  const now = FieldValue.serverTimestamp();

  const secretDoc: AdminMfaSecretDoc = {
    uid,
    secret,
    verified: false,
    createdAt: now,
  };
  await db.collection("adminMfaSecrets").doc(uid).set(secretDoc);

  const otpauthUrl = authenticator.keyuri(email, "the platform Admin", secret);

  await writeAuditLog({
    requestId,
    functionName: "beginAdminMfaEnrollment",
    actorUid: uid,
    actorRole: "admin",
    actorType: "admin",
    actorAdminRoleIds: roleIds,
    targetType: "adminUser",
    targetId: uid,
    eventType: "admin.mfa_enrollment_started",
    appCheck,
  });

  // secret is returned once here so the client can render/copy it as a
  // manual-entry fallback alongside the QR code — never persisted anywhere
  // the client can read it back from afterward.
  return { success: true, secret, otpauthUrl };
});

// ---------------------------------------------------------------------------
// confirmAdminMfaEnrollment — verifies the first code, flips mfaEnrolled
// ---------------------------------------------------------------------------
export const confirmAdminMfaEnrollment = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "confirmAdminMfaEnrollment");
  await enforceRateLimit(
    request.auth?.uid ?? `ip:${request.rawRequest?.ip ?? "unknown"}`,
    "confirmAdminMfaEnrollment",
    10,
  );
  const { uid, roleIds } = await assertAdmin(request, undefined, { skipMfaCheck: true });

  const code = String(request.data?.code ?? "");
  const secretSnap = await db.collection("adminMfaSecrets").doc(uid).get();
  if (!secretSnap.exists) {
    throw new https.HttpsError("failed-precondition", "Call beginAdminMfaEnrollment first.");
  }
  const { secret } = secretSnap.data() as AdminMfaSecretDoc;

  if (!verifyCode(secret, code)) {
    throw new https.HttpsError("invalid-argument", "Incorrect or expired code.");
  }

  const now = FieldValue.serverTimestamp();
  const batch = db.batch();
  batch.update(secretSnap.ref, { verified: true, verifiedAt: now });
  batch.update(db.collection("adminUsers").doc(uid), {
    mfaEnrolled: true,
    lastMfaAt: now,
    updatedAt: now,
  });
  await batch.commit();

  await writeAuditLog({
    requestId,
    functionName: "confirmAdminMfaEnrollment",
    actorUid: uid,
    actorRole: "admin",
    actorType: "admin",
    actorAdminRoleIds: roleIds,
    targetType: "adminUser",
    targetId: uid,
    eventType: "admin.mfa_enrolled",
    appCheck,
  });

  return { success: true };
});

// ---------------------------------------------------------------------------
// verifyAdminMfaCode — re-verification once already enrolled (the
// freshness window in assertAdmin.ts expires, or the Ops Console prompts
// for a code before a specifically sensitive action)
// ---------------------------------------------------------------------------
export const verifyAdminMfaCode = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "verifyAdminMfaCode");
  await enforceRateLimit(
    request.auth?.uid ?? `ip:${request.rawRequest?.ip ?? "unknown"}`,
    "verifyAdminMfaCode",
    10,
  );
  const { uid, roleIds } = await assertAdmin(request, undefined, { skipMfaCheck: true });

  const code = String(request.data?.code ?? "");
  const sessionId = request.data?.sessionId ? String(request.data.sessionId) : null;

  const secretSnap = await db.collection("adminMfaSecrets").doc(uid).get();
  if (!secretSnap.exists || !(secretSnap.data() as AdminMfaSecretDoc).verified) {
    throw new https.HttpsError("failed-precondition", "MFA is not enrolled for this account.");
  }
  const { secret } = secretSnap.data() as AdminMfaSecretDoc;

  if (!verifyCode(secret, code)) {
    throw new https.HttpsError("invalid-argument", "Incorrect or expired code.");
  }

  const now = FieldValue.serverTimestamp();
  await db.collection("adminUsers").doc(uid).update({ lastMfaAt: now, updatedAt: now });

  if (sessionId) {
    // Best-effort: the session doc may belong to a different admin's
    // request shape than expected if a stale/foreign id is passed, so this
    // is deliberately not load-bearing for the actual security check above
    // (which already succeeded) — it only enriches adminSessions for audit
    // visibility.
    await db.collection("adminSessions").doc(sessionId).update({ mfaVerifiedAt: now })
      .catch(() => undefined);
  }

  await writeAuditLog({
    requestId,
    functionName: "verifyAdminMfaCode",
    actorUid: uid,
    actorRole: "admin",
    actorType: "admin",
    actorAdminRoleIds: roleIds,
    targetType: "adminUser",
    targetId: uid,
    eventType: "admin.mfa_verified",
    appCheck,
  });

  return { success: true };
});
