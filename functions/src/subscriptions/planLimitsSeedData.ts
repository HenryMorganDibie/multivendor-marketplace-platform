import { PlanLimits, SubscriptionPlanId } from "../types4";

/**
 * Default plan limits (Phase 4 v10 feature gating matrix, Sections 2-3).
 *
 * Seeded into subscriptionPlans/{planId} by seedSubscriptionPlans rather
 * than read directly from this file at runtime — every enforcement point
 * reads resolveEffectivePlan()'s output, which comes from Firestore, so a
 * limit change is a document update, not a redeploy (Section 11 guarantee).
 *
 * Pricing does NOT live here (or anywhere in this file) — see
 * DEFAULT_PLAN_DISPLAY below and subscription-pricing/README.md for why
 * global per-plan pricing was replaced with per-country pricing.
 */
export const DEFAULT_PLAN_LIMITS: Record<SubscriptionPlanId, PlanLimits> = {
  basic: {
    // Bumped when a limit changes so a cached plan is not mistaken for the
    // current one. Basic tightened from 10 items / 2 photos / 3 invoices.
    planLimitsVersion: "v2",
    catalogItemLimit: 7,
    photosPerItemLimit: 1,
    // Recording an order taken over the phone or WhatsApp is free on every
    // plan. A vendor's own bookkeeping is not a feature to sell them, and
    // blocking it pushed the exact orders the platform wants visible back into a
    // notebook.
    //
    // The paid line sits at canViewAdvancedAnalytics below instead: Basic can
    // record external orders but cannot see platform-versus-external
    // breakdown that compares them. Recording is bookkeeping; the comparison is
    // insight.
    canAccessExternalOrders: true,
    canSetMinimumOrderAmount: false,
    canSetBusinessPolicies: false,
    canAutoSendPickupDetails: false,
    canAutoAcceptOrders: false,
    canShowAIButton: false,
    canChangeUsername: false,
    aiRepliesPerMonth: 0,
    aiInsightsLimit: 1,
    activePromotionsLimit: 0,
    dashboardFilterRange: "today",
    canViewBestSellerWidget: false,
    canViewRevenueCard: false,
    canViewAdvancedAnalytics: false,
    invoicesPerMonth: 2,
    invoiceHistoryDays: 30,
    canDownloadInvoicePdf: false,
    canDuplicateInvoice: false,
    canUploadLogo: false,
    canSetBrandColor: false,
    canSetThankYouMessage: false,
    canSetFooterText: false,
    canUsePremiumTemplates: false,
    canUseSeasonalThemes: false,
    canAddQrCode: false,
    canUsePrintLayout: false,
  },
  standard: {
    planLimitsVersion: "v1",
    catalogItemLimit: 30,
    photosPerItemLimit: 5,
    canAccessExternalOrders: true,
    canSetMinimumOrderAmount: true,
    canSetBusinessPolicies: true,
    canAutoSendPickupDetails: false,
    canAutoAcceptOrders: false,
    canShowAIButton: true,
    canChangeUsername: true,
    aiRepliesPerMonth: 100,
    aiInsightsLimit: 3,
    activePromotionsLimit: 0,
    dashboardFilterRange: "week",
    canViewBestSellerWidget: true,
    canViewRevenueCard: true,
    canViewAdvancedAnalytics: false,
    invoicesPerMonth: 25,
    invoiceHistoryDays: 180,
    canDownloadInvoicePdf: true,
    canDuplicateInvoice: false,
    canUploadLogo: true,
    canSetBrandColor: false,
    canSetThankYouMessage: false,
    canSetFooterText: false,
    canUsePremiumTemplates: false,
    canUseSeasonalThemes: false,
    canAddQrCode: false,
    canUsePrintLayout: false,
  },
  pro: {
    planLimitsVersion: "v1",
    catalogItemLimit: 100,
    photosPerItemLimit: 10,
    canAccessExternalOrders: true,
    canSetMinimumOrderAmount: true,
    canSetBusinessPolicies: true,
    canAutoSendPickupDetails: true,
    canAutoAcceptOrders: false,
    canShowAIButton: true,
    canChangeUsername: true,
    aiRepliesPerMonth: 300,
    aiInsightsLimit: 10,
    activePromotionsLimit: 10,
    dashboardFilterRange: "month",
    canViewBestSellerWidget: true,
    canViewRevenueCard: true,
    canViewAdvancedAnalytics: true,
    invoicesPerMonth: 100,
    invoiceHistoryDays: 548,
    canDownloadInvoicePdf: true,
    canDuplicateInvoice: true,
    canUploadLogo: true,
    canSetBrandColor: true,
    canSetThankYouMessage: true,
    canSetFooterText: true,
    canUsePremiumTemplates: false,
    canUseSeasonalThemes: false,
    canAddQrCode: false,
    canUsePrintLayout: false,
  },
  pro_plus: {
    planLimitsVersion: "v1",
    catalogItemLimit: 250,
    photosPerItemLimit: 15,
    canAccessExternalOrders: true,
    canSetMinimumOrderAmount: true,
    canSetBusinessPolicies: true,
    canAutoSendPickupDetails: true,
    canAutoAcceptOrders: true,
    canShowAIButton: true,
    canChangeUsername: true,
    aiRepliesPerMonth: 500,
    aiInsightsLimit: 25,
    activePromotionsLimit: 25,
    dashboardFilterRange: "year",
    canViewBestSellerWidget: true,
    canViewRevenueCard: true,
    canViewAdvancedAnalytics: true,
    invoicesPerMonth: 200,
    invoiceHistoryDays: 1095,
    canDownloadInvoicePdf: true,
    canDuplicateInvoice: true,
    canUploadLogo: true,
    canSetBrandColor: true,
    canSetThankYouMessage: true,
    canSetFooterText: true,
    canUsePremiumTemplates: true,
    canUseSeasonalThemes: true,
    canAddQrCode: true,
    canUsePrintLayout: true,
  },
};

/**
 * Deliberately NO pricing fields here (no monthlyPriceNGN/yearlyPriceNGN).
 * Global, single-currency pricing was the root problem this data model is
 * fixing — see subscription-pricing/README.md. Real, per-country pricing
 * lives in Firestore's subscriptionPricing/{countryCode}, seeded from
 * subscription-pricing/pricing.json via `npm run import:pricing`.
 * `pro_plus` stays the backend key everywhere; "Pro+" below is display
 * text only, never a code identifier.
 */
export const DEFAULT_PLAN_DISPLAY: Record<SubscriptionPlanId, { displayName: string; features: string[] }> = {
  basic: { displayName: "Basic", features: ["7 catalog items", "1 photo per item", "2 invoices/month"] },
  standard: { displayName: "Standard", features: ["30 catalog items", "External orders", "Best seller & revenue widgets", "25 invoices/month"] },
  pro: { displayName: "Pro", features: ["100 catalog items", "Auto-send pickup details", "Advanced analytics", "Invoice branding", "100 invoices/month"] },
  pro_plus: { displayName: "Pro+", features: ["250 catalog items", "Auto-accept orders", "Premium invoice templates", "200 invoices/month"] },
};

/** Provider plan codes — PLACEHOLDER values for all three providers. Real
 * plan/price codes must be created in each provider's dashboard (Paystack,
 * Flutterwave, Stripe) and substituted here — or edited directly in
 * providerPlanCodes/{planId} after seeding — before any live checkout
 * through that specific provider can succeed. Seeding with placeholders is
 * intentional: it lets createFlutterwaveCheckout/createStripeCheckout
 * exist and be wired up end-to-end (including in the emulator, which never
 * calls a real provider anyway) before real merchant accounts are
 * provisioned for either fallback provider. */
export const DEFAULT_PROVIDER_PLAN_CODES: Record<SubscriptionPlanId, {
  paystack: { monthlyPlanCode: string; yearlyPlanCode: string };
  flutterwave: { monthlyPlanId: string; yearlyPlanId: string };
  stripe: { monthlyPriceId: string; yearlyPriceId: string };
}> = {
  basic: {
    paystack: { monthlyPlanCode: "PLN_basic_monthly_placeholder", yearlyPlanCode: "PLN_basic_yearly_placeholder" },
    flutterwave: { monthlyPlanId: "FLW_basic_monthly_placeholder", yearlyPlanId: "FLW_basic_yearly_placeholder" },
    stripe: { monthlyPriceId: "price_basic_monthly_placeholder", yearlyPriceId: "price_basic_yearly_placeholder" },
  },
  standard: {
    paystack: { monthlyPlanCode: "PLN_standard_monthly_placeholder", yearlyPlanCode: "PLN_standard_yearly_placeholder" },
    flutterwave: { monthlyPlanId: "FLW_standard_monthly_placeholder", yearlyPlanId: "FLW_standard_yearly_placeholder" },
    stripe: { monthlyPriceId: "price_standard_monthly_placeholder", yearlyPriceId: "price_standard_yearly_placeholder" },
  },
  pro: {
    paystack: { monthlyPlanCode: "PLN_pro_monthly_placeholder", yearlyPlanCode: "PLN_pro_yearly_placeholder" },
    flutterwave: { monthlyPlanId: "FLW_pro_monthly_placeholder", yearlyPlanId: "FLW_pro_yearly_placeholder" },
    stripe: { monthlyPriceId: "price_pro_monthly_placeholder", yearlyPriceId: "price_pro_yearly_placeholder" },
  },
  pro_plus: {
    paystack: { monthlyPlanCode: "PLN_pro_plus_monthly_placeholder", yearlyPlanCode: "PLN_pro_plus_yearly_placeholder" },
    flutterwave: { monthlyPlanId: "FLW_pro_plus_monthly_placeholder", yearlyPlanId: "FLW_pro_plus_yearly_placeholder" },
    stripe: { monthlyPriceId: "price_pro_plus_monthly_placeholder", yearlyPriceId: "price_pro_plus_yearly_placeholder" },
  },
};
