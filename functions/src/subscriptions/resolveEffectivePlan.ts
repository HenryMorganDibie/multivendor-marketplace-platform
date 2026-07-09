import { db } from "../admin";
import { PlanLimits, SubscriptionPlanId, SubscriptionPlanDoc, VendorSubscriptionDoc } from "../types4";
import { DEFAULT_PLAN_LIMITS } from "./planLimitsSeedData";

/**
 * resolveEffectivePlan — the single source of truth for what a vendor is
 * currently entitled to. Every gated Cloud Function calls this and reads
 * PlanLimits from its output; nothing gates off a hardcoded constant or the
 * legacy vendors/{vendorId}.plan field directly (PHASE_4_COLLECTION_MAPPING
 * v10, Section 11).
 *
 * Deliberately uncached, same reasoning as the moderation engine: a plan
 * change or admin override is a rare action, not a hot path, and a
 * per-process cache here would reintroduce the exact cross-instance
 * staleness bug already found and fixed in moderationEngine.ts.
 */

export interface EffectivePlanResult {
  plan: SubscriptionPlanId;
  limits: PlanLimits;
  subscription: VendorSubscriptionDoc | null;
  reason:
    | "vendor_suspended"
    | "admin_override"
    | "active"
    | "trialing"
    | "grace_period"
    | "cancelled_before_period_end"
    | "no_subscription"
    | "expired_or_other";
}

async function loadPlanLimits(planId: SubscriptionPlanId): Promise<PlanLimits> {
  const snap = await db.collection("subscriptionPlans").doc(planId).get();
  if (snap.exists) {
    const doc = snap.data() as SubscriptionPlanDoc;
    // Destructure to just the PlanLimits shape, in case display fields
    // (displayName, pricing, features) are present on the same document.
    const { planLimitsVersion, catalogItemLimit, photosPerItemLimit, canAccessExternalOrders,
      canSetMinimumOrderAmount, canSetBusinessPolicies, canAutoSendPickupDetails, canAutoAcceptOrders,
      canShowAIButton, aiRepliesPerMonth, aiInsightsLimit, activePromotionsLimit, dashboardFilterRange,
      canViewBestSellerWidget, canViewRevenueCard, canViewAdvancedAnalytics, invoicesPerMonth,
      invoiceHistoryDays, canDownloadInvoicePdf, canDuplicateInvoice, canUploadLogo, canSetBrandColor,
      canSetThankYouMessage, canSetFooterText, canUsePremiumTemplates, canUseSeasonalThemes,
      canAddQrCode, canUsePrintLayout } = doc;
    return { planLimitsVersion, catalogItemLimit, photosPerItemLimit, canAccessExternalOrders,
      canSetMinimumOrderAmount, canSetBusinessPolicies, canAutoSendPickupDetails, canAutoAcceptOrders,
      canShowAIButton, aiRepliesPerMonth, aiInsightsLimit, activePromotionsLimit, dashboardFilterRange,
      canViewBestSellerWidget, canViewRevenueCard, canViewAdvancedAnalytics, invoicesPerMonth,
      invoiceHistoryDays, canDownloadInvoicePdf, canDuplicateInvoice, canUploadLogo, canSetBrandColor,
      canSetThankYouMessage, canSetFooterText, canUsePremiumTemplates, canUseSeasonalThemes,
      canAddQrCode, canUsePrintLayout };
  }
  // Fallback to hardcoded defaults only if subscriptionPlans was never
  // seeded — this keeps the platform functional (fail-safe to Basic-shaped
  // limits per plan) rather than throwing on every gated call in a fresh
  // environment, while still preferring Firestore as the live source once
  // seedSubscriptionPlans has run.
  return DEFAULT_PLAN_LIMITS[planId];
}

export async function resolveEffectivePlan(vendorId: string): Promise<EffectivePlanResult> {
  const vendorSnap = await db.collection("vendors").doc(vendorId).get();
  const vendorData = vendorSnap.data();

  // 1. Vendor suspended (Phase 1 vendorStatus, not a duplicate field here — see types4.ts header note).
  if (vendorData?.vendorStatus === "suspended") {
    return { plan: "basic", limits: await loadPlanLimits("basic"), subscription: null, reason: "vendor_suspended" };
  }

  const subSnap = await db.collection("vendorSubscriptions").doc(vendorId).get();
  if (!subSnap.exists) {
    return { plan: "basic", limits: await loadPlanLimits("basic"), subscription: null, reason: "no_subscription" };
  }
  const sub = subSnap.data() as VendorSubscriptionDoc;

  // 2. Admin override active.
  const overrideExpiresAt = sub.adminOverrideExpiresAt;
  if (overrideExpiresAt && "toMillis" in overrideExpiresAt && overrideExpiresAt.toMillis() > Date.now()) {
    return { plan: sub.plan, limits: await loadPlanLimits(sub.plan), subscription: sub, reason: "admin_override" };
  }

  // 3. Status active or trialing.
  if (sub.status === "active") {
    return { plan: sub.plan, limits: await loadPlanLimits(sub.plan), subscription: sub, reason: "active" };
  }
  if (sub.status === "trialing") {
    return { plan: sub.plan, limits: await loadPlanLimits(sub.plan), subscription: sub, reason: "trialing" };
  }

  // 4. Status past_due and before gracePeriodEnd.
  if (sub.status === "past_due" && sub.gracePeriodEnd && "toMillis" in sub.gracePeriodEnd && sub.gracePeriodEnd.toMillis() > Date.now()) {
    return { plan: sub.plan, limits: await loadPlanLimits(sub.plan), subscription: sub, reason: "grace_period" };
  }

  // 5. Status cancelled and before currentPeriodEnd.
  if (sub.status === "cancelled" && "toMillis" in sub.currentPeriodEnd && sub.currentPeriodEnd.toMillis() > Date.now()) {
    return { plan: sub.plan, limits: await loadPlanLimits(sub.plan), subscription: sub, reason: "cancelled_before_period_end" };
  }

  // 6. All other cases.
  return { plan: "basic", limits: await loadPlanLimits("basic"), subscription: sub, reason: "expired_or_other" };
}
