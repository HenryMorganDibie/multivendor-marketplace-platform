import { https } from "firebase-functions/v2";
import { db } from "../admin";
import { isOrderTerminal } from "./orderStatus";

/**
 * getOrderDetails — the vendor-facing "safe" way to read an order.
 *
 * Per the client's contact-card edge cases: "Vendor can view the contact
 * snapshot only while the related order is active. When the order reaches
 * a terminal status, vendor can no longer read/display the contact
 * details."
 *
 * Raw Firestore reads on orders/{orderId} still return the full document
 * (documented limitation — see README/frontend integration notes), but
 * this callable is the intended integration point for the vendor order
 * detail screen and strips deliveryContact once the order is terminal.
 * The frontend should call this rather than reading the document directly
 * when displaying delivery/pickup contact information to a vendor.
 */
export const getOrderDetails = https.onCall(async (request) => {
  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");

  const { orderId } = request.data ?? {};
  if (!orderId) throw new https.HttpsError("invalid-argument", "orderId is required.");

  const orderSnap = await db.collection("orders").doc(orderId).get();
  if (!orderSnap.exists) throw new https.HttpsError("not-found", "Order not found.");
  const order = orderSnap.data()!;

  const uid = request.auth.uid;
  const role = request.auth.token.role as string;
  const vendorId = request.auth.token.vendorId as string | undefined;

  const isCustomerOwner = order.customerId === uid;
  const isVendorOwner = role === "vendor" && order.vendorId === vendorId;
  const isAdmin = role === "admin";

  if (!isCustomerOwner && !isVendorOwner && !isAdmin) {
    throw new https.HttpsError("permission-denied", "You do not have access to this order.");
  }

  const result = { ...order };

  // Vendor contact-snapshot expiry: once terminal, strip deliveryContact
  // entirely from the vendor-facing response. Customers always retain
  // access to their own submitted contact info; admins always retain
  // access for support/dispute purposes.
  if (isVendorOwner && !isCustomerOwner && !isAdmin) {
    if (isOrderTerminal(order.status) && result.deliveryContact) {
      delete result.deliveryContact;
      result.deliveryContactExpired = true;
    }
  }

  return { success: true, order: result };
});
