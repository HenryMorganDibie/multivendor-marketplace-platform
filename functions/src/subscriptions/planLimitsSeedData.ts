import { PlanLimits, SubscriptionPlanId } from "../types4";

/**
 * Default plan limits (Phase 4 v10 feature gating matrix, Sections 2-3).
 *
 * Seeded into subscriptionPlans/{planId} by seedSubscriptionPlans rather
 * than read directly from this file at runtime — every enforcement point
 * reads resolveEffectivePlan()'s output, which comes from Firestore, so a
 * limit change is a document update, not a redeploy (Section 11 guarantee).
 *
 * monthlyPriceNGN / yearlyPriceNGN are PLACEHOLDER figures — the source
 * document does not specify final pricing. These must be confirmed with
 * the business before this seed is run against production and can be
 * edited directly in Firestore afterward without any code change.
 */
export const DEFAULT_PLAN_LIMITS: Record<SubscriptionPlanId, PlanLimits> = {
  basic: {
    planLimitsVersion: "v1",
    catalogItemLimit: 10,
    photosPerItemLimit: 2,
    canAccessExternalOrders: false,
    canSetMinimumOrderAmount: false,
    canSetBusinessPolicies: false,
    canAutoSendPickupDetails: false,
    canAutoAcceptOrders: false,
    canShowAIButton: false,
    aiRepliesPerMonth: 0,
    aiInsightsLimit: 1,
    activePromotionsLimit: 0,
    dashboardFilterRange: "today",
    canViewBestSellerWidget: false,
    canViewRevenueCard: false,
    canViewAdvancedAnalytics: false,
    invoicesPerMonth: 3,
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

export const DEFAULT_PLAN_DISPLAY: Record<SubscriptionPlanId, { displayName: string; monthlyPriceNGN: number; yearlyPriceNGN: number; features: string[] }> = {
  basic: { displayName: "Basic", monthlyPriceNGN: 0, yearlyPriceNGN: 0, features: ["10 catalog items", "2 photos per item", "3 invoices/month"] },
  standard: { displayName: "Standard", monthlyPriceNGN: 5000, yearlyPriceNGN: 50000, features: ["30 catalog items", "External orders", "Best seller & revenue widgets", "25 invoices/month"] },
  pro: { displayName: "Pro", monthlyPriceNGN: 15000, yearlyPriceNGN: 150000, features: ["100 catalog items", "Auto-send pickup details", "Advanced analytics", "Invoice branding", "100 invoices/month"] },
  pro_plus: { displayName: "Pro Plus", monthlyPriceNGN: 30000, yearlyPriceNGN: 300000, features: ["250 catalog items", "Auto-accept orders", "Premium invoice templates", "200 invoices/month"] },
};

/** Provider plan codes — PLACEHOLDER values. Real Paystack plan codes must
 * be created in the Paystack dashboard and substituted here (or edited
 * directly in providerPlanCodes/{planId} after seeding) before any live
 * checkout can succeed. */
export const DEFAULT_PROVIDER_PLAN_CODES: Record<SubscriptionPlanId, { paystack: { monthlyPlanCode: string; yearlyPlanCode: string } }> = {
  basic: { paystack: { monthlyPlanCode: "PLN_basic_monthly_placeholder", yearlyPlanCode: "PLN_basic_yearly_placeholder" } },
  standard: { paystack: { monthlyPlanCode: "PLN_standard_monthly_placeholder", yearlyPlanCode: "PLN_standard_yearly_placeholder" } },
  pro: { paystack: { monthlyPlanCode: "PLN_pro_monthly_placeholder", yearlyPlanCode: "PLN_pro_yearly_placeholder" } },
  pro_plus: { paystack: { monthlyPlanCode: "PLN_pro_plus_monthly_placeholder", yearlyPlanCode: "PLN_pro_plus_yearly_placeholder" } },
};
