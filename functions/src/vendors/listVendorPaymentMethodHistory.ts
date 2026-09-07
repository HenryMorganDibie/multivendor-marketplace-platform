import { https } from "firebase-functions/v2";
import { db } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { VendorPaymentMethodHistoryDoc } from "../types2";

/**
 * listVendorPaymentMethodHistory.
 *
 * Read-side of the Payment Method change-history requirement: every
 * replacement recorded by updateVendorPaymentMethod.ts, newest first. Low
 * expected volume (a vendor doesn't replace their payout destination often),
 * so no pagination — same call shape as other small vendor-scoped lists.
 */
export const listVendorPaymentMethodHistory = https.onCall(async (request) => {
  checkAppCheck(request, "listVendorPaymentMethodHistory");

  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string;

  const snap = await db
    .collection("vendors")
    .doc(vendorId)
    .collection("paymentMethodHistory")
    .orderBy("replacedAt", "desc")
    .get();

  const history = snap.docs.map((d) => d.data() as VendorPaymentMethodHistoryDoc);
  return { success: true, history };
});
