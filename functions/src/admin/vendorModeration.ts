import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { writeAuditLog } from "../utils/auditLog";
import { checkAppCheck } from "../utils/appCheck";
import { assertAdmin } from "../utils/adminAuth";
import { newRequestId } from "../utils/requestContext";

/**
 * Admin-only vendor moderation functions — full multi-role model.
 *
 * Each function specifies which AdminRoleIds may call it, per the
 * architecture document's role definitions (section 3.2):
 *  - super_admin: all actions
 *  - verification_admin: verification approve/reject/retry
 *  - safety_admin: suspend/deactivate/reactivate
 */

// ---------------------------------------------------------------------------
// approveVendorVerification
// ---------------------------------------------------------------------------
export const approveVendorVerification = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "approveVendorVerification");
  const { uid: adminUid, roleIds } = await assertAdmin(request, ["verification_admin"]);

  const vendorId = String(request.data?.vendorId ?? "");
  if (!vendorId) {
    throw new https.HttpsError("invalid-argument", "vendorId is required.");
  }

  const verificationRef = db.collection("vendorVerification").doc(vendorId);
  const vendorRef = db.collection("vendors").doc(vendorId);

  const verificationSnap = await verificationRef.get();
  if (!verificationSnap.exists) {
    throw new https.HttpsError("not-found", "Vendor verification record not found.");
  }

  if (verificationSnap.data()?.verificationStatus !== "pending_review") {
    throw new https.HttpsError(
      "failed-precondition",
      "Vendor verification is not pending review."
    );
  }

  const before = verificationSnap.data();
  const now = FieldValue.serverTimestamp();

  const batch = db.batch();
  batch.update(verificationRef, {
    verificationStatus: "approved",
    reviewedAt: now,
    reviewerAdminUid: adminUid,
    manualReviewStatus: "completed",
    rejectionReason: null,
    retryReason: null,
    updatedAt: now,
  });
  batch.update(vendorRef, {
    verificationStatus: "approved",
    approvedAt: now,
    updatedAt: now,
  });

  await batch.commit();

  await writeAuditLog({
    requestId,
    functionName: "approveVendorVerification",
    actorUid: adminUid,
    actorRole: "admin",
    actorType: "admin",
    actorAdminRoleIds: roleIds,
    targetType: "vendorVerification",
    targetId: vendorId,
    eventType: "vendor.verification_approved",
    before: { verificationStatus: before?.verificationStatus },
    after: { verificationStatus: "approved" },
    appCheck,
  });

  return { success: true };
});

// ---------------------------------------------------------------------------
// rejectVendorVerification
// ---------------------------------------------------------------------------
export const rejectVendorVerification = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "rejectVendorVerification");
  const { uid: adminUid, roleIds } = await assertAdmin(request, ["verification_admin"]);

  const vendorId = String(request.data?.vendorId ?? "");
  const reason = String(request.data?.reason ?? "").trim();

  if (!vendorId) {
    throw new https.HttpsError("invalid-argument", "vendorId is required.");
  }
  if (!reason) {
    throw new https.HttpsError("invalid-argument", "A rejection reason is required.");
  }

  const verificationRef = db.collection("vendorVerification").doc(vendorId);
  const vendorRef = db.collection("vendors").doc(vendorId);

  const verificationSnap = await verificationRef.get();
  if (!verificationSnap.exists) {
    throw new https.HttpsError("not-found", "Vendor verification record not found.");
  }

  if (verificationSnap.data()?.verificationStatus !== "pending_review") {
    throw new https.HttpsError(
      "failed-precondition",
      "Vendor verification is not pending review."
    );
  }

  const before = verificationSnap.data();
  const now = FieldValue.serverTimestamp();

  const batch = db.batch();
  batch.update(verificationRef, {
    verificationStatus: "rejected",
    reviewedAt: now,
    reviewerAdminUid: adminUid,
    manualReviewStatus: "completed",
    rejectionReason: reason,
    updatedAt: now,
  });
  batch.update(vendorRef, {
    verificationStatus: "rejected",
    updatedAt: now,
  });

  await batch.commit();

  await writeAuditLog({
    requestId,
    functionName: "rejectVendorVerification",
    actorUid: adminUid,
    actorRole: "admin",
    actorType: "admin",
    actorAdminRoleIds: roleIds,
    targetType: "vendorVerification",
    targetId: vendorId,
    eventType: "vendor.verification_rejected",
    before: { verificationStatus: before?.verificationStatus },
    after: { verificationStatus: "rejected" }, // reason stored on the doc, not duplicated to audit log
    metadata: { hasReason: true },
    appCheck,
  });

  return { success: true };
});

// ---------------------------------------------------------------------------
// requestVerificationRetry
// ---------------------------------------------------------------------------
const ALLOWED_RETRY_STEPS = ["business_info", "identity_document", "proof_of_address"] as const;

export const requestVerificationRetry = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "requestVerificationRetry");
  const { uid: adminUid, roleIds } = await assertAdmin(request, ["verification_admin"]);

  const vendorId = String(request.data?.vendorId ?? "");
  const retryReason = String(request.data?.retryReason ?? "").trim();
  const requiredSteps = Array.isArray(request.data?.requiredSteps)
    ? (request.data.requiredSteps as string[])
    : undefined;

  if (!vendorId) {
    throw new https.HttpsError("invalid-argument", "vendorId is required.");
  }

  if (requiredSteps) {
    const invalid = requiredSteps.filter((s) => !ALLOWED_RETRY_STEPS.includes(s as typeof ALLOWED_RETRY_STEPS[number]));
    if (invalid.length > 0) {
      throw new https.HttpsError(
        "invalid-argument",
        `Invalid requiredSteps: ${invalid.join(", ")}. Allowed: ${ALLOWED_RETRY_STEPS.join(", ")}.`
      );
    }
  }

  const verificationRef = db.collection("vendorVerification").doc(vendorId);
  const vendorRef = db.collection("vendors").doc(vendorId);

  const verificationSnap = await verificationRef.get();
  if (!verificationSnap.exists) {
    throw new https.HttpsError("not-found", "Vendor verification record not found.");
  }

  if (verificationSnap.data()?.verificationStatus !== "pending_review") {
    throw new https.HttpsError(
      "failed-precondition",
      "Vendor verification is not pending review."
    );
  }

  const now = FieldValue.serverTimestamp();

  const update: Record<string, unknown> = {
    verificationStatus: "retry_required",
    reviewedAt: now,
    reviewerAdminUid: adminUid,
    manualReviewStatus: "completed",
    retryReason: retryReason || "Additional information required.",
    retryAllowed: true,
    updatedAt: now,
  };
  if (requiredSteps) {
    update.requiredSteps = requiredSteps;
  }

  const batch = db.batch();
  batch.update(verificationRef, update);
  batch.update(vendorRef, {
    verificationStatus: "retry_required",
    updatedAt: now,
  });
  await batch.commit();

  await writeAuditLog({
    requestId,
    functionName: "requestVerificationRetry",
    actorUid: adminUid,
    actorRole: "admin",
    actorType: "admin",
    actorAdminRoleIds: roleIds,
    targetType: "vendorVerification",
    targetId: vendorId,
    eventType: "vendor.verification_retry_requested",
    after: { verificationStatus: "retry_required" },
    metadata: { requiredSteps },
    appCheck,
  });

  return { success: true };
});

// ---------------------------------------------------------------------------
// suspendVendor
// ---------------------------------------------------------------------------
export const suspendVendor = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "suspendVendor");
  const { uid: adminUid, roleIds } = await assertAdmin(request, ["safety_admin"]);

  const vendorId = String(request.data?.vendorId ?? "");
  const reason = String(request.data?.reason ?? "").trim();

  if (!vendorId) {
    throw new https.HttpsError("invalid-argument", "vendorId is required.");
  }

  const vendorRef = db.collection("vendors").doc(vendorId);
  const vendorSnap = await vendorRef.get();
  if (!vendorSnap.exists) {
    throw new https.HttpsError("not-found", "Vendor not found.");
  }

  const before = vendorSnap.data();
  const now = FieldValue.serverTimestamp();

  await vendorRef.update({
    vendorStatus: "suspended",
    suspendedAt: now,
    updatedAt: now,
  });

  await writeAuditLog({
    requestId,
    functionName: "suspendVendor",
    actorUid: adminUid,
    actorRole: "admin",
    actorType: "admin",
    actorAdminRoleIds: roleIds,
    targetType: "vendor",
    targetId: vendorId,
    eventType: "vendor.suspended",
    before: { vendorStatus: before?.vendorStatus },
    after: { vendorStatus: "suspended" },
    metadata: reason ? { reason } : undefined,
    appCheck,
  });

  return { success: true };
});

// ---------------------------------------------------------------------------
// deactivateVendor
// ---------------------------------------------------------------------------
export const deactivateVendor = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "deactivateVendor");
  const { uid: adminUid, roleIds } = await assertAdmin(request, ["safety_admin"]);

  const vendorId = String(request.data?.vendorId ?? "");
  const reason = String(request.data?.reason ?? "").trim();

  if (!vendorId) {
    throw new https.HttpsError("invalid-argument", "vendorId is required.");
  }

  const vendorRef = db.collection("vendors").doc(vendorId);
  const vendorSnap = await vendorRef.get();
  if (!vendorSnap.exists) {
    throw new https.HttpsError("not-found", "Vendor not found.");
  }

  const before = vendorSnap.data();
  const now = FieldValue.serverTimestamp();

  await vendorRef.update({
    vendorStatus: "deactivated",
    deactivatedAt: now,
    updatedAt: now,
  });

  await writeAuditLog({
    requestId,
    functionName: "deactivateVendor",
    actorUid: adminUid,
    actorRole: "admin",
    actorType: "admin",
    actorAdminRoleIds: roleIds,
    targetType: "vendor",
    targetId: vendorId,
    eventType: "vendor.deactivated",
    before: { vendorStatus: before?.vendorStatus },
    after: { vendorStatus: "deactivated" },
    metadata: reason ? { reason } : undefined,
    appCheck,
  });

  return { success: true };
});

// ---------------------------------------------------------------------------
// reactivateVendor
// ---------------------------------------------------------------------------
export const reactivateVendor = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "reactivateVendor");
  const { uid: adminUid, roleIds } = await assertAdmin(request, ["safety_admin"]);

  const vendorId = String(request.data?.vendorId ?? "");

  if (!vendorId) {
    throw new https.HttpsError("invalid-argument", "vendorId is required.");
  }

  const vendorRef = db.collection("vendors").doc(vendorId);
  const vendorSnap = await vendorRef.get();
  if (!vendorSnap.exists) {
    throw new https.HttpsError("not-found", "Vendor not found.");
  }

  const before = vendorSnap.data();

  if (before?.verificationStatus === "rejected") {
    throw new https.HttpsError(
      "failed-precondition",
      "Cannot reactivate a vendor whose verification was rejected. Verification status must be resolved first."
    );
  }

  const now = FieldValue.serverTimestamp();

  await vendorRef.update({
    vendorStatus: "active",
    suspendedAt: null,
    deactivatedAt: null,
    updatedAt: now,
  });

  await writeAuditLog({
    requestId,
    functionName: "reactivateVendor",
    actorUid: adminUid,
    actorRole: "admin",
    actorType: "admin",
    actorAdminRoleIds: roleIds,
    targetType: "vendor",
    targetId: vendorId,
    eventType: "vendor.reactivated",
    before: { vendorStatus: before?.vendorStatus },
    after: { vendorStatus: "active" },
    appCheck,
  });

  return { success: true };
});
