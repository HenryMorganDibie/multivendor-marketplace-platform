import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { writeAuditLog } from "../utils/auditLog";
import { checkAppCheck } from "../utils/appCheck";
import { newRequestId } from "../utils/requestContext";
import { resolveOnboardingStatus } from "./onboardingStatus";

/**
 * setVendorPublishStatus — vendor "go live" toggle.
 *
 * Review fix: `isPublished` is now strictly validated as a boolean
 * (rejects non-boolean payloads with 'invalid-argument') instead of
 * silently coercing with Boolean(...).
 */
export const setVendorPublishStatus = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "setVendorPublishStatus");

  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Only vendors can update their publish status.");
  }

  const vendorId = request.auth.token.vendorId as string | undefined;
  if (!vendorId) {
    throw new https.HttpsError("failed-precondition", "No vendorId on auth token.");
  }

  const rawValue = request.data?.isPublished;
  if (typeof rawValue !== "boolean") {
    throw new https.HttpsError("invalid-argument", "isPublished must be a boolean.");
  }
  const isPublished = rawValue;

  const vendorRef = db.collection("vendors").doc(vendorId);
  const vendorSnap = await vendorRef.get();
  if (!vendorSnap.exists) {
    throw new https.HttpsError("not-found", "Vendor not found.");
  }

  // Phase 1 publication gating. Only enforced when going live — a vendor can
  // always unpublish, even from an incomplete state, otherwise a vendor whose
  // only item was later rejected would be trapped live with no way to pull the
  // storefront down.
  if (isPublished) {
    const status = await resolveOnboardingStatus(vendorId);
    if (!status.canPublish) {
      throw new https.HttpsError("failed-precondition", status.blockedReasons.join(" "), {
        blockedReasons: status.blockedReasons,
      });
    }
  }

  const before = { isPublished: vendorSnap.data()?.isPublished };

  await vendorRef.update({
    isPublished,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeAuditLog({
    requestId,
    functionName: "setVendorPublishStatus",
    actorUid: request.auth.uid,
    actorRole: "vendor",
    actorType: "vendor",
    targetType: "vendor",
    targetId: vendorId,
    eventType: isPublished ? "vendor.published" : "vendor.unpublished",
    before,
    after: { isPublished },
    appCheck,
  });

  return { success: true, isPublished };
});
