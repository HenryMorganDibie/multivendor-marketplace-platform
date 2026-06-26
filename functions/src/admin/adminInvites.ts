import { https } from "firebase-functions/v2";
import { db, FieldValue, auth } from "../admin";
import { AdminInviteDoc, AdminRoleId, AdminSessionDoc, AdminUserDoc } from "../types";
import { writeAuditLog } from "../utils/auditLog";
import { checkAppCheck } from "../utils/appCheck";
import { assertAdmin } from "../utils/adminAuth";
import { newRequestId } from "../utils/requestContext";
import * as crypto from "crypto";

const VALID_ROLE_IDS: AdminRoleId[] = [
  "super_admin",
  "verification_admin",
  "support_admin",
  "safety_admin",
  "read_only_admin",
];

function validateRoleIds(roleIds: unknown[]): AdminRoleId[] {
  const invalid = roleIds.filter((r) => !VALID_ROLE_IDS.includes(r as AdminRoleId));
  if (invalid.length > 0) {
    throw new https.HttpsError(
      "invalid-argument",
      `Invalid role IDs: ${invalid.join(", ")}. Allowed: ${VALID_ROLE_IDS.join(", ")}.`
    );
  }
  return roleIds as AdminRoleId[];
}

// ---------------------------------------------------------------------------
// createAdminInvite — super_admin only
// ---------------------------------------------------------------------------
export const createAdminInvite = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "createAdminInvite");
  const { uid: adminUid, roleIds } = await assertAdmin(request, ["super_admin"]);

  const email = String(request.data?.email ?? "").trim().toLowerCase();
  const inviteRoleIds = Array.isArray(request.data?.roleIds)
    ? validateRoleIds(request.data.roleIds)
    : [];

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new https.HttpsError("invalid-argument", "A valid email is required.");
  }
  if (inviteRoleIds.length === 0) {
    throw new https.HttpsError("invalid-argument", "At least one roleId is required.");
  }

  const inviteRef = db.collection("adminInvites").doc();
  const expiresAt = FieldValue.serverTimestamp();
  const now = FieldValue.serverTimestamp();

  const invite: AdminInviteDoc = {
    inviteId: inviteRef.id,
    email,
    roleIds: inviteRoleIds,
    status: "pending",
    invitedByAdminUid: adminUid,
    acceptedByUid: null,
    expiresAt: FieldValue.serverTimestamp(), // extended below via update
    createdAt: now,
    acceptedAt: null,
    revokedAt: null,
  };

  await inviteRef.set(invite);

  // Set actual expiry 72 hours from now via a separate update
  // (cannot do Date math with serverTimestamp directly).
  await inviteRef.update({
    expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
  });

  await writeAuditLog({
    requestId,
    functionName: "createAdminInvite",
    actorUid: adminUid,
    actorRole: "admin",
    actorType: "admin",
    actorAdminRoleIds: roleIds,
    targetType: "adminInvite",
    targetId: inviteRef.id,
    eventType: "admin.invite_created",
    after: { email, roleIds: inviteRoleIds },
    appCheck,
  });

  return { success: true, inviteId: inviteRef.id };
});

// ---------------------------------------------------------------------------
// acceptAdminInvite — called by the invited user after signing up
// ---------------------------------------------------------------------------
export const acceptAdminInvite = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "acceptAdminInvite");

  if (!request.auth) {
    throw new https.HttpsError("unauthenticated", "Sign in required.");
  }

  const uid = request.auth.uid;
  const inviteId = String(request.data?.inviteId ?? "").trim();

  if (!inviteId) {
    throw new https.HttpsError("invalid-argument", "inviteId is required.");
  }

  const inviteRef = db.collection("adminInvites").doc(inviteId);
  const inviteSnap = await inviteRef.get();

  if (!inviteSnap.exists) {
    throw new https.HttpsError("not-found", "Invite not found.");
  }

  const invite = inviteSnap.data() as AdminInviteDoc;

  if (invite.status !== "pending") {
    throw new https.HttpsError("failed-precondition", `Invite is ${invite.status}.`);
  }

  const expiresAtValue = invite.expiresAt as any;
  const expiresAtDate = expiresAtValue?.toDate ? expiresAtValue.toDate() : new Date(expiresAtValue);
  if (invite.expiresAt && expiresAtDate < new Date()) {
    await inviteRef.update({ status: "expired" });
    throw new https.HttpsError("deadline-exceeded", "Invite has expired.");
  }

  const userRecord = await auth.getUser(uid).catch(() => null);
  if (!userRecord?.email || userRecord.email.toLowerCase() !== invite.email) {
    throw new https.HttpsError(
      "permission-denied",
      "This invite was sent to a different email address."
    );
  }

  const now = FieldValue.serverTimestamp();
  const adminUserDoc: AdminUserDoc = {
    uid,
    email: userRecord.email,
    displayName: userRecord.displayName ?? null,
    roleIds: invite.roleIds,
    status: "active",
    mfaRequired: true,
    mfaEnrolled: false,
    allowedEnvironments: ["dev", "staging", "prod"],
    createdByAdminUid: invite.invitedByAdminUid,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    revokedAt: null,
    lastMfaAt: null,
  };

  const batch = db.batch();
  batch.set(db.collection("adminUsers").doc(uid), adminUserDoc);
  batch.update(inviteRef, {
    status: "accepted",
    acceptedByUid: uid,
    acceptedAt: now,
  });
  batch.update(db.collection("users").doc(uid), {
    role: "admin",
    updatedAt: now,
  });
  await batch.commit();

  await auth.setCustomUserClaims(uid, {
    role: "admin",
    adminRoleIds: invite.roleIds,
    claimsVersion: 1,
  });

  await writeAuditLog({
    requestId,
    functionName: "acceptAdminInvite",
    actorUid: uid,
    actorRole: "admin",
    actorType: "admin",
    actorAdminRoleIds: invite.roleIds,
    targetType: "adminUser",
    targetId: uid,
    eventType: "admin.invite_accepted",
    after: { roleIds: invite.roleIds },
    appCheck,
  });

  return { success: true, roleIds: invite.roleIds };
});

// ---------------------------------------------------------------------------
// revokeAdminAccess — super_admin only
// ---------------------------------------------------------------------------
export const revokeAdminAccess = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "revokeAdminAccess");
  const { uid: actorUid, roleIds } = await assertAdmin(request, ["super_admin"]);

  const targetUid = String(request.data?.uid ?? "").trim();
  if (!targetUid) {
    throw new https.HttpsError("invalid-argument", "uid is required.");
  }
  if (targetUid === actorUid) {
    throw new https.HttpsError("invalid-argument", "You cannot revoke your own admin access.");
  }

  const adminRef = db.collection("adminUsers").doc(targetUid);
  const adminSnap = await adminRef.get();
  if (!adminSnap.exists) {
    throw new https.HttpsError("not-found", "Admin user not found.");
  }

  const now = FieldValue.serverTimestamp();

  await adminRef.update({
    status: "revoked",
    revokedAt: now,
    updatedAt: now,
  });

  // Remove all admin custom claims from the Auth token.
  await auth.setCustomUserClaims(targetUid, { role: "customer", claimsVersion: 99 });

  await writeAuditLog({
    requestId,
    functionName: "revokeAdminAccess",
    actorUid,
    actorRole: "admin",
    actorType: "admin",
    actorAdminRoleIds: roleIds,
    targetType: "adminUser",
    targetId: targetUid,
    eventType: "admin.access_revoked",
    before: { status: adminSnap.data()?.status },
    after: { status: "revoked" },
    appCheck,
  });

  return { success: true };
});

// ---------------------------------------------------------------------------
// recordAdminSession — called by Admin Web Portal on login
// ---------------------------------------------------------------------------
export const recordAdminSession = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "recordAdminSession");
  const { uid: adminUid, roleIds } = await assertAdmin(request);

  const userAgent = String(request.data?.userAgent ?? "").slice(0, 512);
  const deviceLabel = String(request.data?.deviceLabel ?? "").slice(0, 128);
  const environment = process.env.GCLOUD_PROJECT ?? "unknown";

  const ipHash = request.rawRequest?.ip
    ? crypto.createHash("sha256").update(request.rawRequest.ip).digest("hex")
    : null;

  const now = FieldValue.serverTimestamp();
  const sessionRef = db.collection("adminSessions").doc();

  const sessionDoc: AdminSessionDoc = {
    sessionId: sessionRef.id,
    adminUid,
    environment,
    ipHash,
    userAgent: userAgent || null,
    deviceLabel: deviceLabel || null,
    mfaVerifiedAt: null,
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
    riskFlags: [],
  };

  await sessionRef.set(sessionDoc);

  await db.collection("adminUsers").doc(adminUid).update({
    lastLoginAt: now,
    updatedAt: now,
  });

  await writeAuditLog({
    requestId,
    functionName: "recordAdminSession",
    actorUid: adminUid,
    actorRole: "admin",
    actorType: "admin",
    actorAdminRoleIds: roleIds,
    targetType: "adminSession",
    targetId: sessionRef.id,
    eventType: "admin.session_created",
    appCheck,
  });

  return { success: true, sessionId: sessionRef.id };
});
