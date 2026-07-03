import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { PICKUP_LIMITS, VendorPickupSettingsDoc } from "../types3";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";

export const updateVendorPickupSettings = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "updateVendorPickupSettings");

  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string;
  const { pickupAddress, pickupInstructions, pickupContactPhone,
          pickupVerificationCode, autoSendPickupDetailsEnabled } = request.data ?? {};

  if (pickupInstructions !== undefined && pickupInstructions.length > PICKUP_LIMITS.maxInstructionsLength) {
    throw new https.HttpsError(
      "invalid-argument",
      `Pickup instructions must be ${PICKUP_LIMITS.maxInstructionsLength} characters or fewer.`
    );
  }

  const settingsRef = db.collection("vendors").doc(vendorId).collection("settings").doc("pickup");
  const existingSnap = await settingsRef.get();
  const existing = existingSnap.exists ? (existingSnap.data() as VendorPickupSettingsDoc) : null;

  const now = FieldValue.serverTimestamp();
  const updates: Record<string, unknown> = {
    updatedAt: now,
    updatedByUid: request.auth.uid,
  };
  if (pickupAddress !== undefined) updates.pickupAddress = pickupAddress;
  if (pickupInstructions !== undefined) updates.pickupInstructions = String(pickupInstructions).trim();
  if (pickupContactPhone !== undefined) updates.pickupContactPhone = pickupContactPhone;
  if (pickupVerificationCode !== undefined) updates.pickupVerificationCode = pickupVerificationCode;

  // Enable-guard: vendor cannot enable auto-send without a saved address
  // AND instructions AND an active vendor status. This is enforced
  // server-side even though the frontend also disables the toggle.
  if (autoSendPickupDetailsEnabled === true) {
    const resolvedAddress = pickupAddress ?? existing?.pickupAddress;
    const resolvedInstructions = (pickupInstructions ?? existing?.pickupInstructions)?.trim?.();

    if (!resolvedAddress?.streetAddress) {
      throw new https.HttpsError(
        "failed-precondition",
        "A pickup street address is required before enabling auto-send."
      );
    }
    if (!resolvedInstructions) {
      throw new https.HttpsError(
        "failed-precondition",
        "Pickup instructions are required before enabling auto-send."
      );
    }

    const vendorSnap = await db.collection("vendors").doc(vendorId).get();
    if (vendorSnap.data()?.vendorStatus !== "active") {
      throw new https.HttpsError(
        "failed-precondition",
        "Vendor account must be active to enable pickup auto-send."
      );
    }
  }

  if (autoSendPickupDetailsEnabled !== undefined) {
    updates.autoSendPickupDetailsEnabled = autoSendPickupDetailsEnabled === true;
  }

  await settingsRef.set(updates, { merge: true });

  await writeAuditLog({
    requestId,
    functionName: "updateVendorPickupSettings",
    actorUid: request.auth.uid,
    actorRole: "vendor",
    actorType: "vendor",
    targetType: "vendorPickupSettings",
    targetId: vendorId,
    eventType: "vendor.pickup_settings_updated",
    appCheck,
  });

  return { success: true };
});
