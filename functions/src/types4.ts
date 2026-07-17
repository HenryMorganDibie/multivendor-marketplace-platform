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
  /**
   * The vendor's currently-billed monthly amount, in minor currency units
   * (LANDING_PAGE_CMS_VENDOR_PORTAL_MAPPING.md Section 12.3). Set at
   * subscription creation and on every activation/renewal webhook — always
   * mirrors what the provider actually charged (converted from `amountPaid`),
   * never proactively re-fetched from `subscriptionPricing`. This is what
   * makes the "existing subscribers keep their price until a real renewal
   * charges them the new one" guarantee true: this field only ever changes
   * when a real payment at a real amount happens, never on a pricing-config
   * edit alone.
   */
  currentMonthlyPriceMinorUnits?: number;
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
//
// Deliberately carries NO pricing. Pricing moved to subscriptionPricing/
// {countryCode} (per-country, per the client's architecture decision) precisely
// because a single global price per plan was never correct — see
// subscriptionPricing/README.md for the full history of why.

export interface SubscriptionPlanDoc extends PlanLimits {
  planId: SubscriptionPlanId;
  displayName: string;
  features: string[];
  isActive: boolean;
  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── providerPlanCodes/{planId} — PRIVATE, Admin SDK only ─────────────────
//
// Legacy, plan-only (not country-specific) provider codes. Kept as-is —
// still seeded by seedSubscriptionPlans and still asserted not-client-
// readable by the acceptance tests — but no longer read by any checkout
// callable, which now read providerPlanMapping/{countryCode}-{planId}
// instead (see below). Left in place rather than removed since nothing
// in this pass audited every consumer of this collection; removing it
// is a separate, deliberate cleanup decision for later.

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

// ─── subscriptionPricing/{countryCode} — PUBLIC read, seed-script write only

export interface SubscriptionPricingPlanEntry {
  monthlyPriceMinorUnits: number;
  /**
   * Record-keeping metadata only (Section 12.3) — the backend never
   * compares this against the current date to decide whether to apply a
   * price. Documents when a price became/becomes effective, for admin
   * reference and so a future automated-notice-enforcement version has the
   * data it needs without a schema migration. Optional: older/never-changed
   * prices may not have one.
   */
  effectiveFrom?: firestore.Timestamp | firestore.FieldValue;
}

export interface SubscriptionPricingRecord {
  countryCode: string;
  currencyCode: string;
  plans: {
    standard: SubscriptionPricingPlanEntry;
    pro: SubscriptionPricingPlanEntry;
    pro_plus: SubscriptionPricingPlanEntry;
  };
  status: "active" | "inactive" | "archived";
  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── subscriptionProviderConfig/{countryCode} — PRIVATE, Admin SDK only ───
//
// Country-specific provider priority order (frontend-subscription-
// alignment-scope.md Section 4.1). Never stored in the public
// subscriptionPricing document — provider names/priority must never reach
// any client. createSubscriptionCheckout picks the first provider in this
// list that also has an active providerPlanMapping entry for the requested
// plan. No universal fallback order across countries.

export interface SubscriptionProviderConfig {
  countryCode: string;
  providerPriority: Array<Extract<SubscriptionProvider, "paystack" | "flutterwave" | "stripe">>;
  status: "active" | "inactive";
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── providerPlanMapping/{countryCode}-{planId} — PRIVATE, Admin SDK only ──
//
// Country-aware successor to providerPlanCodes above: the same provider
// plan/price identifier concept, but a given plan can have a different
// provider-side identifier per country (e.g. Nigeria's Pro plan sells
// through a different Paystack plan code than it did before country
// pricing existed). All three provider fields are optional — a country
// only needs an entry for whichever provider(s) actually serve it.

export interface ProviderPlanMapping {
  countryCode: string;
  planId: "standard" | "pro" | "pro_plus";
  paystack?: { monthlyPlanCode: string };
  flutterwave?: { monthlyPlanId: string };
  stripe?: { monthlyPriceId: string };
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

// ─── siteContent/{sectionId} — PRIVATE, Admin SDK only ────────────────────
//
// LANDING_PAGE_CMS_VENDOR_PORTAL_MAPPING.md Section 2.1. Public visitors
// never read this collection directly — getPublicSiteContent projects only
// publishedContent + version. All writes go through saveSiteContentDraft /
// publishSiteContent (Super-Admin only), never a direct client write.

export type SiteContentNode =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "bulletList"; items: string[] }
  | { type: "orderedList"; items: string[] }
  | { type: "link"; text: string; href: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string };

export interface SiteContentImageRef {
  storagePath: string;
  altText: string;
}

export interface SiteContentSectionContent {
  nodes: SiteContentNode[];
  images?: Record<string, SiteContentImageRef>;
  [key: string]: unknown;
}

export interface SiteContentDoc {
  sectionId: string;
  draftContent: SiteContentSectionContent;
  publishedContent: SiteContentSectionContent | null;
  previousPublishedContent?: SiteContentSectionContent | null;
  status: "draft" | "published";
  version: number;
  publishedAt: firestore.Timestamp | firestore.FieldValue | null;
  publishedBy: string | null;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
  updatedBy: string;
}

// ─── contactSubmissions/{submissionId} — PRIVATE, Admin SDK only ──────────
//
// Section 3. Public create only, through submitContactForm — never a
// direct client write. status/createdAt/source are always server-owned.

export interface ContactSubmissionDoc {
  submissionId: string;
  name: string;
  email: string;
  subjectCategory: string;
  message: string;
  status: "new" | "reviewed" | "closed" | "spam";
  source: "public_website";
  createdAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── waitlistSubmissions/{docId} — PRIVATE, Admin SDK only ────────────────
//
// docId is sha256(email:countryCode) so a repeat signup for the same
// email+country updates in place rather than creating a duplicate row.
// Written only by joinWaitlist, never a direct client write.

export interface WaitlistSubmissionDoc {
  email: string;
  countryCode: string;
  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── Vendor-safe billing history projection (Section 4.3) ─────────────────
//
// Returned by getVendorBillingHistory — never the raw subscriptionEvents
// document. No webhook payloads, provider IDs beyond a display reference,
// internal error detail, or admin override notes.

export interface VendorBillingHistoryEntry {
  paymentDate: string | null; // ISO string, or null if not yet processed
  amount: number | null;
  currency: string | null;
  plan: string;
  paymentStatus: string; // plain-language, not a raw backend status string
  providerReference: string | null;
}
