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
import { SubscriptionPricingRecord, ProviderPlanMapping } from "../types4";

export type PaidPlanId = "standard" | "pro" | "pro_plus";

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
