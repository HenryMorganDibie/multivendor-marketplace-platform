import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { VENDOR_NOTIFICATION_DEFAULTS, CUSTOMER_NOTIFICATION_DEFAULTS } from "../types3";
import { checkAppCheck } from "../utils/appCheck";

/**
 * updateVendorNotificationPreferences — narrow, allowlisted updates only.
 * securityAlerts is intentionally never accepted from client input — it
 * is always true, hard-coded server-side, matching "never disableable."
 */
export const updateVendorNotificationPreferences = https.onCall(async (request) => {
  checkAppCheck(request, "updateVendorNotificationPreferences");
  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string;
  const data = request.data ?? {};

  const allowedKeys = [
    "pushEnabled", "newOrderRequest", "paymentConfirmed", "orderChanges",
    "actionRequired", "pendingOrderReminder", "newMessage", "unreadMessageReminder",
    "quietHours",
  ];

  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  for (const key of allowedKeys) {
    if (data[key] !== undefined) updates[key] = data[key];
  }
  // securityAlerts is never client-settable — force true regardless of input
  updates.securityAlerts = true;

  const settingsRef = db.collection("vendors").doc(vendorId).collection("settings").doc("notifications");
  const existingSnap = await settingsRef.get();

  if (!existingSnap.exists) {
    await settingsRef.set({ ...VENDOR_NOTIFICATION_DEFAULTS, ...updates });
  } else {
    await settingsRef.set(updates, { merge: true });
  }

  return { success: true };
});

export const updateCustomerNotificationPreferences = https.onCall(async (request) => {
  checkAppCheck(request, "updateCustomerNotificationPreferences");
  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");

  const uid = request.auth.uid;
  const data = request.data ?? {};

  const allowedKeys = ["pushEnabled", "orderUpdates", "chatMessages", "pickupReminders", "cartReminders", "promotions"];
  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  for (const key of allowedKeys) {
    if (data[key] !== undefined) updates[key] = data[key];
  }

  const settingsRef = db.collection("users").doc(uid).collection("settings").doc("notifications");
  const existingSnap = await settingsRef.get();

  if (!existingSnap.exists) {
    await settingsRef.set({ ...CUSTOMER_NOTIFICATION_DEFAULTS, ...updates });
  } else {
    await settingsRef.set(updates, { merge: true });
  }

  return { success: true };
});
