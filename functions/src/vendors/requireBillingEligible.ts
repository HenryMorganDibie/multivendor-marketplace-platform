import { https } from "firebase-functions/v2";
import { db } from "../admin";
import { VendorDoc } from "../types";

/**
 * Section 4.1 of LANDING_PAGE_CMS_VENDOR_PORTAL_MAPPING.md: a suspended
 * vendor gets read-only portal access with billing actions restricted, and
 * a deactivated vendor gets no portal access at all. getVendorPortalAccess
 * reflects this in what the portal renders, but its own comment says the
 * real enforcement has to live in each billing callable - createInvoice and
 * createSubscriptionCheckout only checked role/vendorId, so a suspended
 * vendor whose session was already open (or who called the function
 * directly) could still start checkout or create invoices. Only vendorStatus
 * "active" is billing-eligible; verificationStatus never gates this.
 */
export async function requireBillingEligibleVendor(vendorId: string): Promise<void> {
  const vendorSnap = await db.collection("vendors").doc(vendorId).get();
  if (!vendorSnap.exists) throw new https.HttpsError("not-found", "Vendor not found.");
  const vendor = vendorSnap.data() as VendorDoc;
  if (vendor.vendorStatus !== "active") {
    throw new https.HttpsError(
      "permission-denied",
      vendor.vendorStatus === "suspended"
        ? "Your account is suspended. Billing actions are unavailable until it's reactivated."
        : "Your account does not currently have billing access."
    );
  }
}
