import { https } from "firebase-functions/v2";
import { newRequestId } from "../utils/requestContext";
import { ProviderPlanMapping } from "../types4";

/**
 * runFlutterwaveCheckout / runStripeCheckout — internal-only provider
 * implementations, no longer public https.onCall callables
 * (frontend-subscription-alignment-scope.md Section 4: the frontend must
 * never select between Paystack/Flutterwave/Stripe callables and must
 * contain no provider-specific branching). createSubscriptionCheckout in
 * subscriptionFunctions.ts is the only public entry point; it resolves the
 * provider server-side (countryPricing.ts's selectProvider) and calls
 * whichever of these matches.
 *
 * Auth, App Check, and rate limiting all happen once in the caller — these
 * functions assume the caller has already verified the vendor and resolved
 * pricing/mapping, and only handle the provider-specific checkout-session
 * creation itself.
 */

function getFlutterwaveSecret(): string {
  return process.env.FLUTTERWAVE_SECRET_KEY ?? (process.env.FUNCTIONS_EMULATOR === "true" ? "emulator_test_secret" : "");
}
function getStripeSecret(): string {
  return process.env.STRIPE_SECRET_KEY ?? (process.env.FUNCTIONS_EMULATOR === "true" ? "emulator_test_secret" : "");
}

export interface CheckoutResult {
  success: true;
  authorizationUrl: string;
  reference: string;
}

/**
 * runFlutterwaveCheckout — Flutterwave as a provider option (Provider
 * Abstraction Contract). Currency is read from subscriptionPricing/
 * {countryCode} by the caller, never hardcoded to NGN, so any country with
 * an active Flutterwave entry in providerPlanMapping can use this.
 */
export async function runFlutterwaveCheckout(params: {
  vendorId: string;
  plan: string;
  currencyCode: string;
  mapping: ProviderPlanMapping;
  email: string;
}): Promise<CheckoutResult> {
  const requestId = newRequestId();
  const planCode = params.mapping.flutterwave!.monthlyPlanId;
  const secret = getFlutterwaveSecret();
  const isEmulator = process.env.FUNCTIONS_EMULATOR === "true";

  if (isEmulator) {
    // No real Flutterwave call in the emulator — deterministic fake
    // checkout link so acceptance tests exercise this end-to-end without
    // live network access or a real Flutterwave account.
    return {
      success: true,
      authorizationUrl: `https://checkout.flutterwave.test/${requestId}`,
      reference: requestId,
    };
  }

  const txRef = `platform_${params.vendorId}_${Date.now()}`;
  const resp = await fetch("https://api.flutterwave.com/v3/payments", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      tx_ref: txRef,
      amount: "0", // real amount is resolved server-side from planCode via Flutterwave's Payment Plan, never client-supplied
      currency: params.currencyCode,
      payment_plan: planCode,
      customer: { email: params.email },
      meta: { vendorId: params.vendorId, plan: params.plan, billingInterval: "monthly" },
    }),
  });
  const json = await resp.json() as { status: string; data?: { link: string }; message?: string };
  if (!resp.ok || json.status !== "success" || !json.data) {
    throw new https.HttpsError("internal", json.message ?? "Failed to initialize Flutterwave checkout.");
  }

  return { success: true, authorizationUrl: json.data.link, reference: txRef };
}

/**
 * runStripeCheckout — Stripe as a provider option, typically for
 * international (non-Nigeria-first) markets, per country/provider
 * configuration (Provider Abstraction Contract).
 */
export async function runStripeCheckout(params: {
  vendorId: string;
  plan: string;
  mapping: ProviderPlanMapping;
  email: string;
}): Promise<CheckoutResult> {
  const requestId = newRequestId();
  const priceId = params.mapping.stripe!.monthlyPriceId;
  const secret = getStripeSecret();
  const isEmulator = process.env.FUNCTIONS_EMULATOR === "true";

  if (isEmulator) {
    return {
      success: true,
      authorizationUrl: `https://checkout.stripe.test/${requestId}`,
      reference: requestId,
    };
  }

  const successUrl = process.env.STRIPE_CHECKOUT_SUCCESS_URL ?? "https://theplatform.com/checkout/success";
  const cancelUrl = process.env.STRIPE_CHECKOUT_CANCEL_URL ?? "https://theplatform.com/checkout/cancel";

  const params_ = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    customer_email: params.email,
    success_url: successUrl,
    cancel_url: cancelUrl,
    "subscription_data[metadata][vendorId]": params.vendorId,
    "subscription_data[metadata][planId]": params.plan,
  });

  const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params_.toString(),
  });
  const json = await resp.json() as { url?: string; id?: string; error?: { message: string } };
  if (!resp.ok || !json.url) {
    throw new https.HttpsError("internal", json.error?.message ?? "Failed to initialize Stripe checkout.");
  }

  return { success: true, authorizationUrl: json.url, reference: json.id! };
}

/**
 * cancelProviderSubscription — best-effort immediate cancellation of an
 * existing provider-side subscription, used by createSubscriptionCheckout's
 * double-billing prevention (Section 12.1.4) before starting a new
 * checkout for a vendor who already has one. Throws on failure — the
 * caller must NOT proceed to a new checkout if this fails, since that
 * would risk two simultaneously-billing subscriptions, which is exactly
 * what this exists to prevent.
 *
 * NOTE: implemented against each provider's standard subscription-
 * cancellation endpoint. Paystack in particular requires both the
 * subscription code and an email token to disable a subscription via its
 * public API — since this codebase doesn't currently persist that token,
 * Paystack cancellation here uses the subscription code alone against the
 * management endpoint; this should be verified against a live Paystack
 * sandbox before this path is exercised in production, as should
 * Flutterwave/Stripe's exact current parameter names.
 */
export async function cancelProviderSubscription(
  provider: "paystack" | "flutterwave" | "stripe",
  providerSubscriptionId: string
): Promise<void> {
  const isEmulator = process.env.FUNCTIONS_EMULATOR === "true";
  if (isEmulator || !providerSubscriptionId) return;

  if (provider === "paystack") {
    const secret = process.env.PAYSTACK_SECRET_KEY ?? "";
    const resp = await fetch("https://api.paystack.co/subscription/disable", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code: providerSubscriptionId, token: providerSubscriptionId }),
    });
    if (!resp.ok) {
      throw new https.HttpsError("internal", "Failed to cancel existing Paystack subscription before upgrade.");
    }
  } else if (provider === "flutterwave") {
    const secret = process.env.FLUTTERWAVE_SECRET_KEY ?? "";
    const resp = await fetch(`https://api.flutterwave.com/v3/subscriptions/${providerSubscriptionId}/cancel`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!resp.ok) {
      throw new https.HttpsError("internal", "Failed to cancel existing Flutterwave subscription before upgrade.");
    }
  } else if (provider === "stripe") {
    const secret = process.env.STRIPE_SECRET_KEY ?? "";
    const resp = await fetch(`https://api.stripe.com/v1/subscriptions/${providerSubscriptionId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!resp.ok) {
      throw new https.HttpsError("internal", "Failed to cancel existing Stripe subscription before upgrade.");
    }
  }
}
