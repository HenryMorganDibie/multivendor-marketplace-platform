/**
 * Shared per-country subscription pricing lookup, used identically by all
 * three checkout callables (createSubscriptionCheckout, createFlutterwaveCheckout,
 * createStripeCheckout) so the "reject if no active country pricing" rule
 * can never be accidentally skipped for one provider and not another.
 *
 * Source of truth: subscriptionPricing/{countryCode} and
 * providerPlanMapping/{countryCode}-{planId}, both seeded from
 * subscription-pricing/pricing.json via `npm run import:pricing`. See
 * subscription-pricing/README.md for the full schema and history.
 */
import { https } from "firebase-functions/v2";
import { db } from "../admin";
import { SubscriptionPricingRecord, ProviderPlanMapping, SubscriptionProviderConfig, SubscriptionProvider } from "../types4";

export type PaidPlanId = "standard" | "pro" | "pro_plus";
export type CheckoutProvider = "paystack" | "flutterwave" | "stripe";
const VALID_CHECKOUT_PROVIDERS: CheckoutProvider[] = ["paystack", "flutterwave", "stripe"];

/**
 * Migration-safe vendor country resolution (LANDING_PAGE_CMS_VENDOR_PORTAL_
 * MAPPING.md Section 1.1 / frontend-subscription-alignment-scope.md Section
 * 3). Existing vendors have only the legacy flat `countryCode` field;
 * newly migrated vendors have `businessLocation.countryCode`. Neither the
 * mobile app nor the Vendor Portal ever sees or chooses between the two —
 * this is the one place that resolves it, server-side, always.
 */
export async function resolveVendorCountry(vendorId: string): Promise<string> {
  const vendorSnap = await db.collection("vendors").doc(vendorId).get();
  const data = vendorSnap.data();
  const structured = data?.businessLocation?.countryCode as string | undefined;
  const legacy = data?.countryCode as string | undefined;
  return structured ?? legacy ?? "";
}

/**
 * Monthly billing only for MVP — a deliberate decision, not a temporary
 * gap. `billingInterval` is kept on the request shape for forward
 * compatibility (so a future yearly rollout doesn't need a breaking
 * request-shape change), but any value other than "monthly" (or omitting
 * it, which defaults to "monthly") is rejected outright rather than
 * silently ignored — the API should fail clearly on an unsupported value,
 * not accept it and quietly do something else.
 */
export function requireMonthlyBillingInterval(billingInterval: unknown): void {
  if (billingInterval !== undefined && billingInterval !== null && billingInterval !== "monthly") {
    throw new https.HttpsError(
      "invalid-argument",
      `billingInterval must be "monthly" — yearly billing is not supported yet.`
    );
  }
}

/**
 * ISO 4217 minor-unit exponent, per currency. Looked up per currency code,
 * never assumed to be 2 for everything — most currencies use 2 decimal
 * places, but zero-decimal and three-decimal currencies are common enough
 * (Japan, South Korea, most of the CFA franc zone, several Gulf states)
 * that hardcoding 2 would silently misprice a meaningful number of
 * countries by a factor of 100.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW",
  "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);
const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export function currencyMinorUnitExponent(currencyCode: string): number {
  const code = currencyCode.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

/**
 * Machine-readable error codes, carried in HttpsError.details.errorCode
 * (in addition to the existing HttpsError.code/message), so the frontend
 * can distinguish "no pricing at all for this country" from "pricing
 * exists but this specific provider isn't wired up yet" without parsing
 * message strings.
 */
export const PRICING_NOT_CONFIGURED = "PRICING_NOT_CONFIGURED";
export const PAYMENT_PROVIDER_NOT_CONFIGURED = "PAYMENT_PROVIDER_NOT_CONFIGURED";

/**
 * Fetches subscriptionPricing/{countryCode} and throws failed-precondition
 * if it's missing or not active. This is a hard stop by design — never
 * falls back to another country's price or attempts currency conversion.
 */
export async function requireActiveCountryPricing(countryCode: string): Promise<SubscriptionPricingRecord> {
  if (!countryCode) {
    throw new https.HttpsError(
      "failed-precondition",
      "Vendor has no country on file — cannot determine subscription pricing.",
      { errorCode: PRICING_NOT_CONFIGURED }
    );
  }
  const snap = await db.collection("subscriptionPricing").doc(countryCode).get();
  if (!snap.exists) {
    throw new https.HttpsError(
      "failed-precondition",
      `No subscription pricing is configured for country "${countryCode}" yet.`,
      { errorCode: PRICING_NOT_CONFIGURED }
    );
  }
  const pricing = snap.data() as SubscriptionPricingRecord;
  if (pricing.status !== "active") {
    throw new https.HttpsError(
      "failed-precondition",
      `Subscription pricing for country "${countryCode}" is not active.`,
      { errorCode: PRICING_NOT_CONFIGURED }
    );
  }
  return pricing;
}

/**
 * Fetches providerPlanMapping/{countryCode}-{planId} for a specific
 * provider. Both "no mapping document at all" and "mapping exists but not
 * for this provider" surface as the same failed-precondition +
 * PAYMENT_PROVIDER_NOT_CONFIGURED error code — a country can have active
 * pricing without every provider being wired up for it yet, and the
 * frontend only needs to know "this provider isn't usable here", not which
 * of the two underlying reasons caused it.
 */
export async function requireProviderPlanMapping(
  countryCode: string,
  planId: PaidPlanId,
  provider: "paystack" | "flutterwave" | "stripe"
): Promise<ProviderPlanMapping> {
  const docId = `${countryCode}-${planId}`;
  const snap = await db.collection("providerPlanMapping").doc(docId).get();
  if (!snap.exists) {
    throw new https.HttpsError(
      "failed-precondition",
      `No provider plan mapping configured for ${docId}.`,
      { errorCode: PAYMENT_PROVIDER_NOT_CONFIGURED }
    );
  }
  const mapping = snap.data() as ProviderPlanMapping;
  if (!mapping[provider]) {
    throw new https.HttpsError(
      "failed-precondition",
      `${provider} is not configured for ${docId} yet.`,
      { errorCode: PAYMENT_PROVIDER_NOT_CONFIGURED }
    );
  }
  return mapping;
}

/**
 * Fetches subscriptionProviderConfig/{countryCode} — private, Admin-SDK
 * only, never stored in the public subscriptionPricing document (see
 * frontend-subscription-alignment-scope.md Section 4.1 for why: a public
 * document must never reveal which providers the platform uses per country or
 * their priority order). Throws the same PAYMENT_PROVIDER_NOT_CONFIGURED
 * error a missing providerPlanMapping would, since "no provider priority
 * configured for this country" and "no provider mapped for this country"
 * are the same failure from the caller's point of view: checkout isn't
 * possible here, full stop.
 */
export async function requireProviderPriority(countryCode: string): Promise<SubscriptionProvider[]> {
  const snap = await db.collection("subscriptionProviderConfig").doc(countryCode).get();
  if (!snap.exists) {
    throw new https.HttpsError(
      "failed-precondition",
      `No provider configuration exists for country "${countryCode}".`,
      { errorCode: PAYMENT_PROVIDER_NOT_CONFIGURED }
    );
  }
  const config = snap.data() as SubscriptionProviderConfig;
  if (config.status !== "active" || !Array.isArray(config.providerPriority) || config.providerPriority.length === 0) {
    throw new https.HttpsError(
      "failed-precondition",
      `Provider configuration for country "${countryCode}" is not active or has no priority list.`,
      { errorCode: PAYMENT_PROVIDER_NOT_CONFIGURED }
    );
  }
  return config.providerPriority;
}

/**
 * Validation for subscriptionProviderConfig writes (admin tooling / import
 * scripts, not any client path — the collection is Admin-SDK write-only).
 * Rejects: values outside the checkout-provider enum, duplicates, and an
 * empty list. Exported so admin scripts can reuse it rather than
 * reimplementing the same checks.
 */
export function validateProviderPriority(providerPriority: unknown): asserts providerPriority is CheckoutProvider[] {
  if (!Array.isArray(providerPriority) || providerPriority.length === 0) {
    throw new Error("providerPriority must be a non-empty array.");
  }
  const seen = new Set<string>();
  for (const p of providerPriority) {
    if (!VALID_CHECKOUT_PROVIDERS.includes(p as CheckoutProvider)) {
      throw new Error(`providerPriority contains an unsupported provider: "${p}". Must be one of: ${VALID_CHECKOUT_PROVIDERS.join(", ")}.`);
    }
    if (seen.has(p as string)) {
      throw new Error(`providerPriority contains a duplicate entry: "${p}".`);
    }
    seen.add(p as string);
  }
}

/**
 * Picks the first provider in a country's priority list that also has an
 * active providerPlanMapping entry for the requested plan — the single
 * server-side provider-selection decision point (Section 4.1). Returns
 * both the chosen provider and its resolved mapping so the caller never
 * has to look it up a second time. Throws PAYMENT_PROVIDER_NOT_CONFIGURED
 * if nothing in the priority list has a usable mapping — never silently
 * falls back to a provider outside the configured order.
 */
export async function selectProvider(
  countryCode: string,
  planId: PaidPlanId
): Promise<{ provider: CheckoutProvider; mapping: ProviderPlanMapping }> {
  const priority = await requireProviderPriority(countryCode);
  const mappingSnap = await db.collection("providerPlanMapping").doc(`${countryCode}-${planId}`).get();
  if (!mappingSnap.exists) {
    throw new https.HttpsError(
      "failed-precondition",
      `No provider plan mapping configured for ${countryCode}-${planId}.`,
      { errorCode: PAYMENT_PROVIDER_NOT_CONFIGURED }
    );
  }
  const mapping = mappingSnap.data() as ProviderPlanMapping;
  for (const candidate of priority) {
    if ((candidate === "paystack" || candidate === "flutterwave" || candidate === "stripe") && mapping[candidate]) {
      return { provider: candidate, mapping };
    }
  }
  throw new https.HttpsError(
    "failed-precondition",
    `No provider in ${countryCode}'s priority list has a plan mapping for ${planId}.`,
    { errorCode: PAYMENT_PROVIDER_NOT_CONFIGURED }
  );
}

/**
 * Read-only check: is checkout actually possible for this vendor's
 * country+plan, for any provider? Lets the frontend decide whether to show
 * a working "Subscribe" button before the vendor ever taps it, rather than
 * only discovering unavailability from a failed checkout call. Never
 * throws — always returns a structured result.
 */
export interface CheckoutAvailability {
  available: boolean;
  countryCode: string;
  availableProviders: Array<"paystack" | "flutterwave" | "stripe">;
  reason?: typeof PRICING_NOT_CONFIGURED | typeof PAYMENT_PROVIDER_NOT_CONFIGURED;
}

export async function checkCheckoutAvailability(countryCode: string, planId: PaidPlanId): Promise<CheckoutAvailability> {
  if (!countryCode) {
    return { available: false, countryCode, availableProviders: [], reason: PRICING_NOT_CONFIGURED };
  }
  const pricingSnap = await db.collection("subscriptionPricing").doc(countryCode).get();
  if (!pricingSnap.exists || (pricingSnap.data() as SubscriptionPricingRecord).status !== "active") {
    return { available: false, countryCode, availableProviders: [], reason: PRICING_NOT_CONFIGURED };
  }

  const mappingSnap = await db.collection("providerPlanMapping").doc(`${countryCode}-${planId}`).get();
  if (!mappingSnap.exists) {
    return { available: false, countryCode, availableProviders: [], reason: PAYMENT_PROVIDER_NOT_CONFIGURED };
  }
  const mapping = mappingSnap.data() as ProviderPlanMapping;
  const availableProviders = (["paystack", "flutterwave", "stripe"] as const).filter((p) => Boolean(mapping[p]));
  if (availableProviders.length === 0) {
    return { available: false, countryCode, availableProviders: [], reason: PAYMENT_PROVIDER_NOT_CONFIGURED };
  }
  return { available: true, countryCode, availableProviders };
}
