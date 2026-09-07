import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";

const MAX_BUSINESS_NAME_LENGTH = 100;

/**
 * updateVendorBusinessDetails.
 *
 * business_details is one of only two onboarding steps that actually block
 * publishing (resolveOnboardingStatus.ts: hasBusinessName + hasCategory).
 * The checklist step routed to /vendor/settings/business-profile, but that
 * screen never existed, and completeRegistration's progressive-onboarding
 * payload deliberately leaves businessName/categoryId blank at signup — so
 * there was no path, anywhere in the app, for a vendor to ever set the two
 * fields required to publish. This is that path.
 *
 * A verified vendor's business identity is locked (matches the Lock icon
 * already shown in manage-account.tsx, which had no edit action behind it) —
 * changing a verified business's name/category without re-review would
 * undermine what verification is supposed to mean.
 */
export const updateVendorBusinessDetails = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "updateVendorBusinessDetails");

  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string;

  const businessName = String(request.data?.businessName ?? "").trim();
  const categoryName = String(request.data?.categoryName ?? "").trim();

  if (!businessName) {
    throw new https.HttpsError("invalid-argument", "Business name is required.");
  }
  if (businessName.length > MAX_BUSINESS_NAME_LENGTH) {
    throw new https.HttpsError("invalid-argument", `Business name must be ${MAX_BUSINESS_NAME_LENGTH} characters or fewer.`);
  }
  if (!categoryName) {
    throw new https.HttpsError("invalid-argument", "Business category is required.");
  }

  const vendorRef = db.collection("vendors").doc(vendorId);
  const vendorSnap = await vendorRef.get();
  if (!vendorSnap.exists) {
    throw new https.HttpsError("not-found", "Vendor profile not found.");
  }
  const vendorData = vendorSnap.data();

  if (vendorData?.verificationStatus === "approved") {
    throw new https.HttpsError(
      "failed-precondition",
      "Business name and category can't be changed after verification. Contact support if this needs to change."
    );
  }

  const categoryId = categoryName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

  const updates = {
    businessName,
    name: businessName,
    categoryId,
    category: categoryName,
    categoryName,
    updatedAt: FieldValue.serverTimestamp(),
  };

  await vendorRef.update(updates);

  await writeAuditLog({
    requestId,
    functionName: "updateVendorBusinessDetails",
    actorUid: request.auth.uid,
    actorRole: "vendor",
    actorType: "vendor",
    targetType: "vendor",
    targetId: vendorId,
    eventType: "vendor.business_details_updated",
    before: { businessName: vendorData?.businessName, categoryId: vendorData?.categoryId },
    after: { businessName, categoryId },
    appCheck,
  });

  return { success: true };
});
