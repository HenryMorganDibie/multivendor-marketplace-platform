import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { enforceRateLimit } from "../subscriptions/rateLimit";
import { VendorPaymentMethodDoc, VendorPaymentMethodHistoryDoc, VendorPaymentMethodType } from "../types2";

const MAX_FIELD_LENGTH = 120;
const MAX_CASH_INSTRUCTIONS_LENGTH = 200;

function requireNonEmptyString(value: unknown, field: string, maxLength = MAX_FIELD_LENGTH): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new https.HttpsError("invalid-argument", `${field} is required.`);
  if (trimmed.length > maxLength) {
    throw new https.HttpsError("invalid-argument", `${field} must be ${maxLength} characters or fewer.`);
  }
  return trimmed;
}

/**
 * updateVendorPaymentMethod.
 *
 * The real, structured replacement for the vendor's payout destination —
 * distinct from updateVendorPaymentInstructions.ts's free-text field. That
 * field stays as-is for vendors who already set it; this is a separate,
 * newer path a vendor sets up independently. Saved to
 * vendors/{vendorId}/paymentMethod/active (a locked-down subcollection, not
 * a field on the vendor document — see firestore.rules for why) and takes
 * effect immediately, no admin approval step. Every replacement is recorded
 * to paymentMethodHistory before being overwritten.
 */
export const updateVendorPaymentMethod = https.onCall(async (request) => {
  await enforceRateLimit(request.auth?.uid ?? `ip:${request.rawRequest?.ip ?? "unknown"}`, "updateVendorPaymentMethod", 20);
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "updateVendorPaymentMethod");

  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string;

  const { type } = (request.data ?? {}) as { type?: VendorPaymentMethodType };
  if (type !== "bank_transfer" && type !== "cash") {
    throw new https.HttpsError("invalid-argument", 'type must be "bank_transfer" or "cash".');
  }

  const methodRef = db.collection("vendors").doc(vendorId).collection("paymentMethod").doc("active");
  const historyRef = db.collection("vendors").doc(vendorId).collection("paymentMethodHistory").doc();

  const existingSnap = await methodRef.get();
  const existing = existingSnap.exists ? (existingSnap.data() as VendorPaymentMethodDoc) : null;
  const now = FieldValue.serverTimestamp();

  const next: VendorPaymentMethodDoc = {
    type,
    ownershipConfirmed: existing?.ownershipConfirmed === true,
    activeSince: now,
    updatedAt: now,
    updatedBy: request.auth.uid,
  };

  if (type === "bank_transfer") {
    next.bankName = requireNonEmptyString(request.data?.bankName, "bankName");
    next.accountNumber = requireNonEmptyString(request.data?.accountNumber, "accountNumber", 34);
    next.accountName = requireNonEmptyString(request.data?.accountName, "accountName");

    if (!next.ownershipConfirmed) {
      // First time a bank_transfer method is ever set: the client-side
      // checkbox ("I confirm this payment account belongs to my business")
      // must have been checked — matches updateVendorPaymentInstructions.ts's
      // ownershipConfirmed convention, carried forward across later edits
      // rather than re-asked every time.
      if (request.data?.confirmOwnership !== true) {
        throw new https.HttpsError(
          "failed-precondition",
          "You must confirm you own this payment account before saving it."
        );
      }
      next.ownershipConfirmed = true;
      next.ownershipConfirmedAt = now;
      next.ownershipConfirmedBy = request.auth.uid;
    } else {
      next.ownershipConfirmedAt = existing?.ownershipConfirmedAt;
      next.ownershipConfirmedBy = existing?.ownershipConfirmedBy;
    }
  } else {
    next.cashInstructions = requireNonEmptyString(
      request.data?.cashInstructions,
      "cashInstructions",
      MAX_CASH_INSTRUCTIONS_LENGTH
    );
  }

  const batch = db.batch();
  if (existing) {
    const historyDoc: VendorPaymentMethodHistoryDoc = {
      historyId: historyRef.id,
      previousMethod: existing,
      replacedAt: now,
      replacedBy: request.auth.uid,
    };
    batch.set(historyRef, historyDoc);
  }
  batch.set(methodRef, next);
  await batch.commit();

  await writeAuditLog({
    requestId,
    functionName: "updateVendorPaymentMethod",
    actorUid: request.auth.uid,
    actorRole: "vendor",
    actorType: "vendor",
    targetType: "vendor",
    targetId: vendorId,
    eventType: "vendor.payment_method_updated",
    after: { type },
    appCheck,
  });

  return { success: true };
});
