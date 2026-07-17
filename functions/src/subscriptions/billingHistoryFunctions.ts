import { https } from "firebase-functions/v2";
import { db } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { SubscriptionEventDoc, VendorBillingHistoryEntry } from "../types4";

/**
 * getVendorBillingHistory — vendor-safe projection over subscriptionEvents
 * (LANDING_PAGE_CMS_VENDOR_PORTAL_MAPPING.md Section 4.3). The portal never
 * reads raw subscriptionEvents documents directly — those carry webhook
 * payloads, provider IDs, internal error detail, and admin override notes.
 * This returns exactly the fields Section 4.3 lists, nothing else.
 */

const PLAIN_LANGUAGE_STATUS: Record<string, string> = {
  activation: "Paid",
  renewal: "Paid",
  past_due: "Payment issue",
  cancelled: "Cancelled",
  trial_ending: "Trial ending",
  "admin.cancelled": "Cancelled",
  "admin.override_applied": "Plan adjusted by support",
  ignored: "No action taken",
};

function toPlainLanguageStatus(normalizedEventType: string): string {
  return PLAIN_LANGUAGE_STATUS[normalizedEventType] ?? "Processed";
}

function requireVendor(request: https.CallableRequest<unknown>): string {
  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string | undefined;
  if (!vendorId) throw new https.HttpsError("failed-precondition", "Vendor ID could not be determined.");
  return vendorId;
}

export const getVendorBillingHistory = https.onCall(async (request) => {
  checkAppCheck(request, "getVendorBillingHistory");
  const vendorId = requireVendor(request);

  const limitRaw = (request.data as { limit?: unknown } | undefined)?.limit;
  const limit = Math.min(Math.max(Number(limitRaw) || 20, 1), 50);

  const snap = await db
    .collection("subscriptionEvents")
    .where("vendorId", "==", vendorId)
    .orderBy("processedAt", "desc")
    .limit(limit)
    .get();

  const entries: VendorBillingHistoryEntry[] = snap.docs.map((doc) => {
    const event = doc.data() as SubscriptionEventDoc;
    const processedAt = event.processedAt;
    const paymentDate =
      processedAt && typeof processedAt === "object" && "toDate" in processedAt
        ? (processedAt.toDate() as Date).toISOString()
        : null;

    return {
      paymentDate,
      amount: typeof event.amountPaid === "number" ? event.amountPaid : null,
      currency: event.currency ?? null,
      plan: event.plan,
      paymentStatus: toPlainLanguageStatus(event.normalizedEventType),
      providerReference: event.providerEventId ?? null,
    };
  });

  return { success: true, entries };
});
