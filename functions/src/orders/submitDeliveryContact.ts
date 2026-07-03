import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";

/**
 * submitDeliveryContact — the ONLY path by which contact details reach
 * Firebase. Per the client's decision, contact cards are local-device-only;
 * this function receives an inline snapshot from the frontend (read from
 * local storage at submit time) and attaches it to exactly one order.
 *
 * Guarantees enforced here:
 *  - snapshot is immutable once set (cannot be called twice for the same
 *    order — matches "must not be reusable across orders")
 *  - snapshot belongs to the correct order/customer/vendor (ownership
 *    validated, not trusted from client)
 *  - only fields needed are stored (fullName, phoneNumber, address)
 *  - never logged in full (audit log stores only a redacted marker)
 */
export const submitDeliveryContact = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "submitDeliveryContact");

  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");
  const customerId = request.auth.uid;

  const { orderId, fullName, phoneNumber, address } = request.data ?? {};
  if (!orderId) throw new https.HttpsError("invalid-argument", "orderId is required.");
  if (!fullName?.trim() || !phoneNumber?.trim()) {
    throw new https.HttpsError("invalid-argument", "fullName and phoneNumber are required.");
  }

  const orderRef = db.collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw new https.HttpsError("not-found", "Order not found.");
  const order = orderSnap.data()!;

  if (order.customerId !== customerId) {
    throw new https.HttpsError("permission-denied", "This is not your order.");
  }
  if (order.deliveryContact) {
    throw new https.HttpsError(
      "already-exists",
      "Contact details have already been submitted for this order and cannot be changed."
    );
  }

  const now = FieldValue.serverTimestamp();
  const deliveryContact = {
    fullName: String(fullName).trim(),
    phoneNumber: String(phoneNumber).trim(),
    address: address ?? null,
    submittedAt: now,
  };

  await orderRef.update({ deliveryContact, updatedAt: now });

  // Never log full phone/address — redacted marker only.
  await writeAuditLog({
    requestId,
    functionName: "submitDeliveryContact",
    actorUid: customerId,
    actorRole: "customer",
    actorType: "customer",
    targetType: "order",
    targetId: orderId,
    eventType: "order.delivery_contact_submitted",
    metadata: { hasAddress: !!address },
    appCheck,
  });

  return { success: true };
});
