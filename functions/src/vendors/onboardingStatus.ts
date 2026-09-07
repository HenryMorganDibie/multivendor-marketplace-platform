import { https } from "firebase-functions/v2";
import { db } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { VendorDoc } from "../types";
import { isCountryActive } from "../utils/countryAvailability";

/**
 * Phase 1 — progressive onboarding status.
 *
 * One place that decides what a vendor still has to do and whether they're
 * allowed to publish. Both the dashboard checklist and the publish gate read
 * from here, deliberately: if the checklist said "you're ready" while the
 * publish call disagreed, the vendor would be stuck with no way to tell why.
 *
 * Publication requires business name, category, and at least one approved
 * catalog item — nothing else. A missing payment method or pending
 * verification does NOT block publishing (verification only gates discovery,
 * and payment method only gates sending payment requests).
 */

export type OnboardingStepId =
  | "business_details"
  | "business_location"
  | "first_catalog_item"
  | "fulfillment"
  | "payment_method"
  | "publish_storefront"
  | "verification";

export interface OnboardingStep {
  id: OnboardingStepId;
  label: string;
  complete: boolean;
  /** True when this step must be done before the storefront can go live. */
  blocksPublication: boolean;
}

export interface VendorOnboardingStatus {
  steps: OnboardingStep[];
  completedCount: number;
  totalCount: number;
  canPublish: boolean;
  /** Human-readable reasons publication is blocked, empty when publishable. */
  blockedReasons: string[];
  isPublished: boolean;
  isDiscoverable: boolean;
  /** Whether the platform is open for commerce in this vendor's country right now.
   * Every other step can be complete and isDiscoverable can still be false
   * for this reason alone — surfaced separately so the checklist can tell a
   * fully set-up vendor why they're still invisible, instead of just
   * disappearing once every step it tracks is done. */
  countryOpen: boolean;
  hasSystemGeneratedUsername: boolean;
}

/** Counts catalog items the public could actually see. An item still under
 * moderation review is explicitly excluded — a storefront whose only item is
 * invisible to customers is an empty storefront. */
async function countPubliclyEligibleItems(vendorId: string): Promise<number> {
  const snap = await db
    .collection("vendors")
    .doc(vendorId)
    .collection("catalogItems")
    .where("moderationStatus", "==", "approved")
    .where("isHidden", "==", false)
    .limit(1)
    .get();
  return snap.size;
}

export async function resolveOnboardingStatus(vendorId: string): Promise<VendorOnboardingStatus> {
  const vendorSnap = await db.collection("vendors").doc(vendorId).get();
  if (!vendorSnap.exists) {
    throw new https.HttpsError("not-found", "Vendor not found.");
  }
  const vendor = vendorSnap.data() as VendorDoc;

  const hasBusinessName = Boolean(vendor.businessName?.trim() || vendor.name?.trim());
  const hasCategory = Boolean(vendor.categoryId || vendor.categoryName?.trim());
  /**
   * Location lives in one of two shapes depending on when the vendor
   * registered: the flat country/state/area fields, or the nested
   * businessLocation map that completeRegistration writes
   * ({ countryName, stateName, areaName, countryCode }). Only the flat
   * fields were checked here, so a vendor whose location is stored nested —
   * which is every vendor registered through the current signup flow — had
   * this step reported incomplete forever, with no way to satisfy it: the
   * checklist told them to choose a location they had already chosen.
   *
   * mapVendorDoc on the client already reads both shapes, newest first;
   * this mirrors that rather than inventing a third convention.
   */
  const nestedLocation = (vendor as unknown as {
    businessLocation?: { countryName?: string; stateName?: string; areaName?: string };
    location?: { countryName?: string; stateName?: string; areaName?: string };
  }).businessLocation ?? (vendor as unknown as {
    location?: { countryName?: string; stateName?: string; areaName?: string };
  }).location;

  const locationCountry = vendor.country?.trim() || nestedLocation?.countryName?.trim();
  const locationRegion =
    vendor.state?.trim() || vendor.area?.trim() ||
    nestedLocation?.stateName?.trim() || nestedLocation?.areaName?.trim();
  const hasLocation = Boolean(locationCountry && locationRegion);
  const hasFulfillment = Array.isArray(vendor.fulfillmentTypes) && vendor.fulfillmentTypes.length > 0;
  const hasEligibleItem = (await countPubliclyEligibleItems(vendorId)) > 0;
  const countryOpen = await isCountryActive(vendor.countryCode ?? "");

  // NOTE: there is no vendor payment-method model in the backend yet, so this
  // step can't be resolved from real data and is reported incomplete rather
  // than guessed at. It deliberately does not block publication, per spec.
  const hasPaymentMethod = false;

  const steps: OnboardingStep[] = [
    { id: "business_details", label: "Add business details", complete: hasBusinessName, blocksPublication: true },
    { id: "business_location", label: "Choose business location", complete: hasLocation, blocksPublication: false },
    { id: "first_catalog_item", label: "Add first product or service", complete: hasEligibleItem, blocksPublication: true },
    { id: "fulfillment", label: "Configure fulfilment", complete: hasFulfillment, blocksPublication: false },
    { id: "payment_method", label: "Add payment details", complete: hasPaymentMethod, blocksPublication: false },
    { id: "publish_storefront", label: "Publish storefront", complete: Boolean(vendor.isPublished), blocksPublication: false },
    { id: "verification", label: "Complete verification for discovery", complete: vendor.verificationStatus === "approved", blocksPublication: false },
  ];

  // Category has no checklist row of its own — it's captured as part of
  // "business details" — but it is independently required to publish.
  const blockedReasons: string[] = [];
  if (!hasBusinessName) blockedReasons.push("Add your business name before publishing.");
  if (!hasCategory) blockedReasons.push("Choose a business category before publishing.");
  if (!hasEligibleItem) {
    blockedReasons.push(
      "Add at least one approved product or service before publishing. Items still under review don't count yet."
    );
  }

  return {
    steps,
    completedCount: steps.filter((s) => s.complete).length,
    totalCount: steps.length,
    canPublish: blockedReasons.length === 0,
    blockedReasons,
    isPublished: Boolean(vendor.isPublished),
    isDiscoverable: Boolean(vendor.isDiscoverable),
    countryOpen,
    hasSystemGeneratedUsername: Boolean(vendor.isSystemGeneratedUsername),
  };
}

/** getVendorOnboardingStatus — dashboard checklist data, computed from real
 * stored values rather than a hardcoded progress number. */
export const getVendorOnboardingStatus = https.onCall(async (request) => {
  checkAppCheck(request, "getVendorOnboardingStatus");

  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string | undefined;
  if (!vendorId) {
    throw new https.HttpsError("failed-precondition", "No vendorId on auth token.");
  }

  const status = await resolveOnboardingStatus(vendorId);
  return { success: true, ...status };
});
