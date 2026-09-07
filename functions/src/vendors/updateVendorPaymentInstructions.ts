import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";

const MAX_INSTRUCTIONS_LENGTH = 200;

/**
 * updateVendorPaymentInstructions.
 *
 * The vendor-settings screen for this (free-text instructions shown to a
 * customer alongside a payment request — bank name, account details,
 * reference format, etc.) previously only wrote to local device state via
 * VendorContext.updateVendor, which is not this document: the vendor
 * profile is also driven by a live onSnapshot listener, so any local-only
 * edit here was silently overwritten by the next real snapshot. This is the
 * first write path for these fields.
 */
export const updateVendorPaymentInstructions = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "updateVendorPaymentInstructions");

  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string;

  const enabled = Boolean(request.data?.enabled);
  const vendorRef = db.collection("vendors").doc(vendorId);

  const updates: Record<string, unknown> = {
    paymentInstructionsEnabled: enabled,
    paymentInstructionsUpdatedAt: FieldValue.serverTimestamp(),
    paymentInstructionsUpdatedBy: request.auth.uid,
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (enabled) {
    const instructions = String(request.data?.paymentInstructions ?? "").trim();
    if (!instructions) {
      throw new https.HttpsError("invalid-argument", "Payment instructions cannot be empty.");
    }
    if (instructions.length > MAX_INSTRUCTIONS_LENGTH) {
      throw new https.HttpsError(
        "invalid-argument",
        `Payment instructions must be ${MAX_INSTRUCTIONS_LENGTH} characters or fewer.`
      );
    }
    updates.paymentInstructions = instructions;

    const vendorSnap = await vendorRef.get();
    if (!vendorSnap.exists) {
      throw new https.HttpsError("not-found", "Vendor profile not found.");
    }
    const alreadyConfirmed = vendorSnap.data()?.ownershipConfirmed === true;

    if (!alreadyConfirmed) {
      // First time enabling: the client-side checkbox ("I confirm this
      // payment account belongs to my business") must have been checked —
      // confirmOwnership carries that attestation across.
      if (request.data?.confirmOwnership !== true) {
        throw new https.HttpsError(
          "failed-precondition",
          "You must confirm you own this payment account before enabling payment instructions."
        );
      }
      updates.ownershipConfirmed = true;
      updates.ownershipConfirmedAt = FieldValue.serverTimestamp();
      updates.ownershipConfirmedBy = request.auth.uid;
    }
  }

  await vendorRef.update(updates);

  await writeAuditLog({
    requestId,
    functionName: "updateVendorPaymentInstructions",
    actorUid: request.auth.uid,
    actorRole: "vendor",
    actorType: "vendor",
    targetType: "vendor",
    targetId: vendorId,
    eventType: "vendor.payment_instructions_updated",
    after: { paymentInstructionsEnabled: enabled },
    appCheck,
  });

  return { success: true };
});
