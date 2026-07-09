import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { resolveEffectivePlan } from "../subscriptions/resolveEffectivePlan";

const MAX_POLICY_LENGTH = 2000;

/**
 * updateVendorSettings (Phase 4, Section 6).
 *
 * Both fields it manages are gated by plan: minimumOrderAmount requires
 * canSetMinimumOrderAmount, policy (business policies free text — refund/
 * cancellation terms shown on the storefront) requires
 * canSetBusinessPolicies. Neither field existed with a setter before Phase
 * 4 — VendorDoc reserved the schema, this is the first Cloud Function that
 * writes to it.
 */
export const updateVendorSettings = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "updateVendorSettings");

  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string;
  const { minimumOrderAmount, policy } = request.data ?? {};

  if (minimumOrderAmount === undefined && policy === undefined) {
    throw new https.HttpsError("invalid-argument", "At least one of minimumOrderAmount or policy is required.");
  }

  const { limits: planLimits } = await resolveEffectivePlan(vendorId);
  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };

  if (minimumOrderAmount !== undefined) {
    if (!planLimits.canSetMinimumOrderAmount) {
      throw new https.HttpsError("permission-denied", "Setting a minimum order amount is not available on your current plan.");
    }
    if (typeof minimumOrderAmount !== "number" || minimumOrderAmount < 0) {
      throw new https.HttpsError("invalid-argument", "minimumOrderAmount must be a non-negative number.");
    }
    updates.minimumOrderAmount = minimumOrderAmount;
  }

  if (policy !== undefined) {
    if (!planLimits.canSetBusinessPolicies) {
      throw new https.HttpsError("permission-denied", "Setting business policies is not available on your current plan.");
    }
    const trimmed = String(policy).trim();
    if (trimmed.length > MAX_POLICY_LENGTH) {
      throw new https.HttpsError("invalid-argument", `policy must be ${MAX_POLICY_LENGTH} characters or fewer.`);
    }
    updates.policy = trimmed;
  }

  await db.collection("vendors").doc(vendorId).update(updates);

  await writeAuditLog({
    requestId,
    functionName: "updateVendorSettings",
    actorUid: request.auth.uid,
    actorRole: "vendor",
    actorType: "vendor",
    targetType: "vendor",
    targetId: vendorId,
    eventType: "vendor.settings_updated",
    after: updates,
    appCheck,
  });

  return { success: true };
});
