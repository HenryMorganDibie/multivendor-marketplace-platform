/**
 * THE PLATFORM Phase 4 Types — Vendor Subscriptions (Provider-Agnostic)
 *
 * Source of truth: PHASE_4_COLLECTION_MAPPING.md v10 (APPROVED FOR
 * IMPLEMENTATION). Covers vendorSubscriptions, subscriptionEvents,
 * subscriptionPlans (public), providerPlanCodes (private), invoiceBranding,
 * subscriptionLocks, rateLimits, ratings, vendorRatingStats.
 *
 * One deliberate deviation from the spec document, noted here rather than
 * silently: vendor suspension is NOT tracked via a new suspendedAt field on
 * vendorSubscriptions. Phase 1's suspendVendor already sets
 * vendors/{vendorId}.vendorStatus = "suspended" and vendors/{vendorId}.suspendedAt
 * — resolveEffectivePlan reads that existing field directly. Adding a second,
 * independent suspendedAt on vendorSubscriptions would create two sources of
 * truth for the same fact that could drift out of sync (admin suspends via
 * suspendVendor, vendorSubscriptions never hears about it). The spec's
 * EC12/Decision B behavior is preserved exactly; only the storage location
 * changes to reuse Phase 1's existing, already-audited suspension mechanism.
 */

import { firestore } from "firebase-admin";

// ─── Plans ──────────────────────────────────────────────────────────────────

export type SubscriptionPlanId = "basic" | "standard" | "pro" | "pro_plus";

export type SubscriptionProvider =
  | "paystack"
  | "stripe"
  | "flutterwave"
  | "apple"
  | "google"
  | "manual_admin_override";

export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "cancelled"
  | "expired"
  | "incomplete"
  | "paused";

export type DashboardFilterRange = "today" | "week" | "month" | "year";

/**
 * PlanLimits — the single object every enforcement point reads from. Never
 * hardcode a limit inline in a Cloud Function; always resolve it through
 * resolveEffectivePlan() so a limit change is a Firestore document update,
 * not a redeploy.
 */
export interface PlanLimits {
  planLimitsVersion: "v1";

  // Core
  catalogItemLimit: number;
  photosPerItemLimit: number;
  canAccessExternalOrders: boolean;
  canSetMinimumOrderAmount: boolean;
  canSetBusinessPolicies: boolean;
  canAutoSendPickupDetails: boolean;
  canAutoAcceptOrders: boolean; // gate reserved, enforced in a future automation phase
  canShowAIButton: boolean; // gate reserved, enforced in a future AI phase

  // AI (gate reserved, enforced in future AI phase)
  aiRepliesPerMonth: number;
  aiInsightsLimit: number;

  // Promotions (gate reserved, enforced in future promotions phase)
  activePromotionsLimit: number;

  // Dashboard (enforced in Phase 4)
  dashboardFilterRange: DashboardFilterRange;
  canViewBestSellerWidget: boolean;
  canViewRevenueCard: boolean;
  canViewAdvancedAnalytics: boolean;

  // Invoices (enforced in Phase 4)
  invoicesPerMonth: number;
  invoiceHistoryDays: number;
  canDownloadInvoicePdf: boolean;
  canDuplicateInvoice: boolean;

  // Invoice branding (enforced in Phase 4)
  canUploadLogo: boolean;
  canSetBrandColor: boolean;
  canSetThankYouMessage: boolean;
  canSetFooterText: boolean;
  canUsePremiumTemplates: boolean;
  canUseSeasonalThemes: boolean;
  canAddQrCode: boolean;
  canUsePrintLayout: boolean;
}

// ─── vendorSubscriptions/{vendorId} ────────────────────────────────────────

export interface VendorSubscriptionDoc {
  vendorId: string;
  provider: SubscriptionProvider;
  providerSubscriptionId: string;
  providerCustomerId: string;
  providerPlanId: string;
  plan: SubscriptionPlanId;
  status: SubscriptionStatus;
  currency: string;
  amountPaid: number;
  billingInterval: "monthly" | "yearly";
  currentPeriodStart: firestore.Timestamp | firestore.FieldValue;
  currentPeriodEnd: firestore.Timestamp | firestore.FieldValue;

  cancelledAt?: firestore.Timestamp | firestore.FieldValue | null;
  cancelAtPeriodEnd: boolean;

  pendingDowngradePlan?: SubscriptionPlanId | null;
  pendingDowngradeAt?: firestore.Timestamp | firestore.FieldValue | null;

  gracePeriodEnd?: firestore.Timestamp | firestore.FieldValue | null;
  gracePeriodSetAt?: firestore.Timestamp | firestore.FieldValue | null;
  gracePeriodReminderSentAt?: firestore.Timestamp | firestore.FieldValue | null;

  adminOverrideExpiresAt?: firestore.Timestamp | firestore.FieldValue | null;

  lastEventType: string;
  lastEventAt: firestore.Timestamp | firestore.FieldValue;
  lastEventSequence: number;
  lastEventPriority: number;

  version: number;

  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── subscriptionEvents/{eventId} ──────────────────────────────────────────

export interface SubscriptionEventDoc {
  eventId: string;
  vendorId: string | null;
  provider: string;
  providerEventId: string;
  normalizedEventType: string;
  rawEventType: string;
  plan: string;
  previousPlan?: string | null;
  status: string;
  effectiveFrom?: firestore.Timestamp | firestore.FieldValue | null;
  amountPaid?: number | null;
  currency?: string | null;
  idempotencyKey: string;
  wasIgnored: boolean;
  ignoreReason?: string | null;
  lastWebhookId?: string | null;

  // Admin-action audit fields (v7) — present only on admin-initiated events.
  reason?: string | null;
  performedBy?: string | null;
  ticketId?: string | null;
  notes?: string | null;
  oldPlan?: string | null;
  newPlan?: string | null;
  oldStatus?: string | null;
  newStatus?: string | null;

  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
  processedAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── subscriptionPlans/{planId} — PUBLIC SAFE ──────────────────────────────

export interface SubscriptionPlanDoc extends PlanLimits {
  planId: SubscriptionPlanId;
  displayName: string;
  monthlyPriceNGN: number;
  yearlyPriceNGN: number;
  features: string[];
  isActive: boolean;
  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── providerPlanCodes/{planId} — PRIVATE, Admin SDK only ─────────────────

export interface ProviderPlanCodesDoc {
  planId: SubscriptionPlanId;
  paystack: {
    monthlyPlanCode: string;
    yearlyPlanCode: string;
  };
  stripe?: {
    monthlyPriceId: string;
    yearlyPriceId: string;
  };
  flutterwave?: {
    monthlyPlanId: string;
    yearlyPlanId: string;
  };
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── invoiceBranding/{vendorId} ────────────────────────────────────────────

export interface InvoiceBrandingDoc {
  vendorId: string;
  logoUrl?: string | null;
  brandColor?: string | null;
  thankYouMessage?: string | null;
  footerText?: string | null;
  selectedTemplateId?: string | null;
  selectedSeasonalThemeId?: string | null;
  qrCodeEnabled: boolean;
  printLayoutEnabled: boolean;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
  updatedByUid: string;
}

// ─── subscriptionLocks/{vendorId} — Admin SDK only ─────────────────────────

export interface SubscriptionLockDoc {
  vendorId: string;
  lockedAt: firestore.Timestamp | firestore.FieldValue;
  lockedBy: string;
  expiresAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── rateLimits/{vendorId}_{functionName} — Admin SDK only ────────────────

export interface RateLimitDoc {
  vendorId: string;
  functionName: string;
  windowStart: firestore.Timestamp | firestore.FieldValue;
  requestCount: number;
}

// ─── invoices/{invoiceId} ──────────────────────────────────────────────────

export type InvoiceStatus = "draft" | "unpaid" | "paid" | "cancelled";

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface InvoiceBrandingSnapshot {
  logoUrl?: string | null;
  brandColor?: string | null;
  thankYouMessage?: string | null;
  footerText?: string | null;
  selectedTemplateId?: string | null;
  selectedSeasonalThemeId?: string | null;
  qrCodeEnabled: boolean;
  printLayoutEnabled: boolean;
}

export interface InvoiceDoc {
  invoiceId: string;
  invoiceNumber: string;
  vendorId: string;
  customerId?: string | null;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  lineItems: InvoiceLineItem[];
  subtotal: number;
  currency: string;
  notes?: string | null;
  status: InvoiceStatus;
  paidAt?: firestore.Timestamp | firestore.FieldValue | null;
  cancelledAt?: firestore.Timestamp | firestore.FieldValue | null;
  // Captured once, at payment time, per the "paid invoices keep their
  // branding snapshot permanently" guarantee. Unpaid invoices have no
  // snapshot and always render with the vendor's CURRENT effective-plan
  // branding at render/download time.
  brandingSnapshot?: InvoiceBrandingSnapshot | null;
  hiddenFromHistory: boolean;
  shareToken: string;
  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

export interface InvoiceMonthlyCounterDoc {
  vendorId: string;
  monthKey: string; // "2026-07", UTC calendar month
  count: number;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── ratings/{ratingId} ─────────────────────────────────────────────────────

export type RatingModerationStatus = "clean" | "flagged" | "removed";

export interface RatingDoc {
  ratingId: string;
  displayId: string;

  orderId: string;
  vendorId: string;
  customerId: string;

  stars: number;
  privateFeedback?: string | null;
  hasPrivateFeedback: boolean;

  submittedAt: firestore.Timestamp | firestore.FieldValue;

  readByVendor: boolean;
  readByVendorAt?: firestore.Timestamp | firestore.FieldValue | null;

  moderationStatus?: RatingModerationStatus | null;
  moderatedByAdminUid?: string | null;
  moderationReason?: string | null;
}

/** The ONLY shape a vendor client is ever allowed to see. orderId and
 * customerId must never appear here, under any circumstance. */
export interface VendorFacingRating {
  ratingId: string;
  displayId: string;
  stars: number;
  privateFeedback?: string | null;
  hasPrivateFeedback: boolean;
  submittedAt: firestore.Timestamp | firestore.FieldValue;
  readByVendor: boolean;
}

// Fields added to Phase 2's OrderDoc in Phase 4 — additive only.
export interface OrderPhase4Extension {
  hasRating?: boolean;
}

// ─── vendorRatingStats/{vendorId} ──────────────────────────────────────────

export interface VendorRatingStatsDoc {
  vendorId: string;
  average: number;
  total: number;
  breakdown: { 5: number; 4: number; 3: number; 2: number; 1: number };
  lastRatingAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}
