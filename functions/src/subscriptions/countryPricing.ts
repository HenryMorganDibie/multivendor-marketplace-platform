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
 * Fetches subscriptionPricing/{countryCode} and throws failed-precondition
 * if it's missing or not active. This is a hard stop by design — never
 * falls back to another country's price or attempts currency conversion.
 */
export async function requireActiveCountryPricing(countryCode: string): Promise<SubscriptionPricingRecord> {
  if (!countryCode) {
    throw new https.HttpsError("failed-precondition", "Vendor has no country on file — cannot determine subscription pricing.");
  }
  const snap = await db.collection("subscriptionPricing").doc(countryCode).get();
  if (!snap.exists) {
    throw new https.HttpsError("failed-precondition", `No subscription pricing is configured for country "${countryCode}" yet.`);
  }
  const pricing = snap.data() as SubscriptionPricingRecord;
  if (pricing.status !== "active") {
    throw new https.HttpsError("failed-precondition", `Subscription pricing for country "${countryCode}" is not active.`);
  }
  return pricing;
}

/**
 * Fetches providerPlanMapping/{countryCode}-{planId}. Throws not-found if
 * the document doesn't exist, or failed-precondition if it exists but has
 * no entry for the requested provider — a country can have active pricing
 * without every provider being wired up for it yet.
 */
export async function requireProviderPlanMapping(
  countryCode: string,
  planId: PaidPlanId,
  provider: "paystack" | "flutterwave" | "stripe"
): Promise<ProviderPlanMapping> {
  const docId = `${countryCode}-${planId}`;
  const snap = await db.collection("providerPlanMapping").doc(docId).get();
  if (!snap.exists) {
    throw new https.HttpsError("not-found", `No provider plan mapping configured for ${docId}.`);
  }
  const mapping = snap.data() as ProviderPlanMapping;
  if (!mapping[provider]) {
    throw new https.HttpsError("failed-precondition", `${provider} is not configured for ${docId} yet.`);
  }
  return mapping;
}
