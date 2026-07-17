// Mirrors the platform-backend/functions/src/types4.ts — kept in sync manually
// since the web app and Cloud Functions are separate deploy targets.

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
}

export type SiteContentSectionId =
  | "home"
  | "features"
  | "vendors"
  | "customers"
  | "faq"
  | "about"
  | "privacy-policy"
  | "terms-of-service"
  | "vendor-terms"
  | "customer-terms"
  | "cookie-policy"
  | "acceptable-use-policy";

export const SITE_CONTENT_SECTION_IDS: SiteContentSectionId[] = [
  "home",
  "features",
  "vendors",
  "customers",
  "faq",
  "about",
  "privacy-policy",
  "terms-of-service",
  "vendor-terms",
  "customer-terms",
  "cookie-policy",
  "acceptable-use-policy",
];

export interface GetPublicSiteContentResponse {
  success: true;
  sections: Record<string, { content: SiteContentSectionContent; version: number }>;
}

export type SubscriptionPlanId = "basic" | "standard" | "pro" | "pro_plus";
export type PaidSubscriptionPlanId = "standard" | "pro" | "pro_plus";

// Mirrors the real buildOfferingsResponse shape in
// functions/src/subscriptions/subscriptionFunctions.ts exactly — field
// names (`plan`, `monthlyPriceMinorUnits`) and per-plan (not per-country)
// availability are load-bearing, not cosmetic.
export interface PlanOffering {
  plan: PaidSubscriptionPlanId;
  monthlyPriceMinorUnits: number;
  available: boolean;
  unavailableReason?: "PRICING_NOT_CONFIGURED" | "PAYMENT_PROVIDER_NOT_CONFIGURED";
}

export interface GetOfferingsResponse {
  success: true;
  countryCode: string;
  currencyCode: string | null;
  plans: PlanOffering[];
}

export type VendorSubscriptionStatus =
  | "active"
  | "past_due"
  | "cancelled"
  | "expired";

export interface EffectiveSubscription {
  plan: SubscriptionPlanId;
  status: VendorSubscriptionStatus | string;
  cancelAtPeriodEnd?: boolean;
  currentPeriodEnd?: { seconds: number; nanoseconds: number } | string | null;
  pendingDowngradePlan?: SubscriptionPlanId | null;
  pendingDowngradeAt?: unknown;
  currentMonthlyPriceMinorUnits?: number;
  currency?: string;
}

export interface GetSubscriptionStatusResponse {
  success: true;
  subscription: EffectiveSubscription | null;
  effectivePlan: SubscriptionPlanId;
  planLimits: Record<string, unknown>;
  reason: string;
}

export interface VendorBillingHistoryEntry {
  paymentDate: string | null;
  amount: number | null;
  currency: string | null;
  plan: string;
  paymentStatus: string;
  providerReference: string | null;
}

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export type InvoiceStatus = "unpaid" | "paid" | "cancelled";

export interface InvoiceSummary {
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  subtotal: number;
  currency: string;
  status: InvoiceStatus;
  createdAt: { seconds: number; nanoseconds: number } | string;
  shareToken: string;
}
