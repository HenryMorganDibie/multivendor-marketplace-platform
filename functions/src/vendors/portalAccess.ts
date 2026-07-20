import { https } from "firebase-functions/v2";
import { db } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { VendorDoc, UserDoc } from "../types";

/**
 * getVendorPortalAccess — LANDING_PAGE_CMS_VENDOR_PORTAL_MAPPING.md
 * Section 4.1. Account access authorization enforced server-side, not by
 * hiding UI in the frontend: every portal screen calls this first and
 * respects the returned accessState, but the *actual* enforcement for
 * billing/invoice actions still lives in each of those callables'
 * own role/status checks — this endpoint exists so the portal can render
 * the correct state up front instead of discovering it from a failed
 * action.
 */
export type VendorPortalAccessState = "full" | "read_only" | "denied" | "incomplete_registration";

export const getVendorPortalAccess = https.onCall(async (request) => {
  checkAppCheck(request, "getVendorPortalAccess");

  if (!request.auth) {
    throw new https.HttpsError("unauthenticated", "Sign in required.");
  }

  const role = request.auth.token.role as string | undefined;
  if (role !== "vendor") {
    return { success: true, accessState: "denied" as VendorPortalAccessState, reason: "not_a_vendor_account" };
  }

  const vendorId = request.auth.token.vendorId as string | undefined;
  if (!vendorId) {
    return { success: true, accessState: "incomplete_registration" as VendorPortalAccessState, reason: "no_vendor_record" };
  }

  const [vendorSnap, userSnap] = await Promise.all([
    db.collection("vendors").doc(vendorId).get(),
    db.collection("users").doc(request.auth.uid).get(),
  ]);

  if (!vendorSnap.exists) {
    return { success: true, accessState: "incomplete_registration" as VendorPortalAccessState, reason: "no_vendor_record" };
  }

  const user = userSnap.exists ? (userSnap.data() as UserDoc) : null;
  if (!user || ["banned", "deactivated", "pending_deletion", "frozen"].includes(user.accountStatus)) {
    return { success: true, accessState: "denied" as VendorPortalAccessState, reason: "user_account_inactive" };
  }

  const vendor = vendorSnap.data() as VendorDoc;
  let accessState: VendorPortalAccessState;
  if (vendor.vendorStatus === "active") {
    accessState = "full";
  } else if (vendor.vendorStatus === "suspended") {
    accessState = "read_only";
  } else {
    // "deactivated" | "frozen" — no self-service portal access.
    accessState = "denied";
  }

  return {
    success: true,
    accessState,
    vendorId,
    businessName: vendor.businessName ?? null,
    verificationStatus: vendor.verificationStatus,
    vendorStatus: vendor.vendorStatus,
    logoImage: vendor.logoImage ?? null,
    username: vendor.username ?? null,
    categoryName: vendor.categoryName ?? null,
    area: vendor.area ?? null,
    country: vendor.country ?? null,
    email: vendor.email ?? user.email ?? null,
    phone: vendor.phone ?? null,
  };
});
