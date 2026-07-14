import { https } from "firebase-functions/v2";
import { db } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { newRequestId } from "../utils/requestContext";
import { SubscriptionPlanId } from "../types4";
import { enforceRateLimit } from "./rateLimit";
import { requireActiveCountryPricing, requireProviderPlanMapping, PaidPlanId } from "./countryPricing";

const VALID_PLAN_IDS: SubscriptionPlanId[] = ["basic", "standard", "pro", "pro_plus"];

async function requireVendorId(request: https.CallableRequest<unknown>): Promise<string> {
  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string | undefined;
  if (!vendorId) throw new https.HttpsError("failed-precondition", "Vendor ID could not be determined.");
  return vendorId;
}

function getFlutterwaveSecret(): string {
  return process.env.FLUTTERWAVE_SECRET_KEY ?? (process.env.FUNCTIONS_EMULATOR === "true" ? "emulator_test_secret" : "");
}
function getStripeSecret(): string {
  return process.env.STRIPE_SECRET_KEY ?? (process.env.FUNCTIONS_EMULATOR === "true" ? "emulator_test_secret" : "");
}

/**
 * createFlutterwaveCheckout — Flutterwave as a second Nigeria-capable
 * provider alongside Paystack (Provider Abstraction Contract). Exists so
 * a Paystack account issue never blocks a vendor from subscribing —
 * having a second provider ready from day one, rather than discovering
 * weeks in that the first one has a problem, was the explicit reason for
 * building this now rather than after Paystack was already in production.
 *
 * Rate limited: 5/60s per vendor, same as createSubscriptionCheckout.
 */
export const createFlutterwaveCheckout = https.onCall(async (request) => {
  const requestId = newRequestId();
  checkAppCheck(request, "createFlutterwaveCheckout");
  const vendorId = await requireVendorId(request);
  await enforceRateLimit(vendorId, "createFlutterwaveCheckout");

  // billingInterval is still accepted on the request (backward compat) but
  // ignored — monthly only for MVP, per the per-country pricing rollout.
  const { plan } = request.data ?? {};
  if (!VALID_PLAN_IDS.includes(plan)) {
    throw new https.HttpsError("invalid-argument", `plan must be one of: ${VALID_PLAN_IDS.join(", ")}.`);
  }
  if (plan === "basic") {
    throw new https.HttpsError("invalid-argument", "Basic is free in every market — there is nothing to check out.");
  }
  const planId = plan as PaidPlanId;

  const vendorSnap = await db.collection("vendors").doc(vendorId).get();
  const countryCode = (vendorSnap.data()?.countryCode as string | undefined) ?? "";
  await requireActiveCountryPricing(countryCode);
  const mapping = await requireProviderPlanMapping(countryCode, planId, "flutterwave");
  const planCode = mapping.flutterwave!.monthlyPlanId;

  const userSnap = await db.collection("users").doc(request.auth!.uid).get();
  const email = userSnap.data()?.email as string | undefined;
  if (!email) throw new https.HttpsError("failed-precondition", "Vendor account has no email on file.");

  const secret = getFlutterwaveSecret();
  const isEmulator = process.env.FUNCTIONS_EMULATOR === "true";

  if (isEmulator) {
    // No real Flutterwave call in the emulator — deterministic fake
    // checkout link, matching createSubscriptionCheckout's pattern, so
    // acceptance tests exercise this end-to-end without live network
    // access or a real Flutterwave account.
    return {
      success: true,
      authorizationUrl: `https://checkout.flutterwave.test/${requestId}`,
      reference: requestId,
    };
  }

  const txRef = `the platform_${vendorId}_${Date.now()}`;
  const resp = await fetch("https://api.flutterwave.com/v3/payments", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      tx_ref: txRef,
      amount: "0", // real amount is resolved server-side from planCode via Flutterwave's Payment Plan, never client-supplied
      currency: "NGN",
      payment_plan: planCode,
      customer: { email },
      meta: { vendorId, planId: plan, billingInterval: "monthly" },
    }),
  });
  const json = await resp.json() as { status: string; data?: { link: string }; message?: string };
  if (!resp.ok || json.status !== "success" || !json.data) {
    throw new https.HttpsError("internal", json.message ?? "Failed to initialize Flutterwave checkout.");
  }

  return { success: true, authorizationUrl: json.data.link, reference: txRef };
});

/**
 * createStripeCheckout — Stripe for international (non-Nigeria) vendors,
 * outside Paystack/Flutterwave's Nigeria-first coverage (Provider
 * Abstraction Contract).
 *
 * Rate limited: 5/60s per vendor, same as the other checkout callables.
 */
export const createStripeCheckout = https.onCall(async (request) => {
  const requestId = newRequestId();
  checkAppCheck(request, "createStripeCheckout");
  const vendorId = await requireVendorId(request);
  await enforceRateLimit(vendorId, "createStripeCheckout");

  // billingInterval is still accepted on the request (backward compat) but
  // ignored — monthly only for MVP, per the per-country pricing rollout.
  const { plan } = request.data ?? {};
  if (!VALID_PLAN_IDS.includes(plan)) {
    throw new https.HttpsError("invalid-argument", `plan must be one of: ${VALID_PLAN_IDS.join(", ")}.`);
  }
  if (plan === "basic") {
    throw new https.HttpsError("invalid-argument", "Basic is free in every market — there is nothing to check out.");
  }
  const planId = plan as PaidPlanId;

  const vendorSnap = await db.collection("vendors").doc(vendorId).get();
  const countryCode = (vendorSnap.data()?.countryCode as string | undefined) ?? "";
  await requireActiveCountryPricing(countryCode);
  const mapping = await requireProviderPlanMapping(countryCode, planId, "stripe");
  const priceId = mapping.stripe!.monthlyPriceId;

  const userSnap = await db.collection("users").doc(request.auth!.uid).get();
  const email = userSnap.data()?.email as string | undefined;
  if (!email) throw new https.HttpsError("failed-precondition", "Vendor account has no email on file.");

  const secret = getStripeSecret();
  const isEmulator = process.env.FUNCTIONS_EMULATOR === "true";

  if (isEmulator) {
    return {
      success: true,
      authorizationUrl: `https://checkout.stripe.test/${requestId}`,
      reference: requestId,
    };
  }

  const successUrl = process.env.STRIPE_CHECKOUT_SUCCESS_URL ?? "https://the platform.com/checkout/success";
  const cancelUrl = process.env.STRIPE_CHECKOUT_CANCEL_URL ?? "https://the platform.com/checkout/cancel";

  const params = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    customer_email: email,
    success_url: successUrl,
    cancel_url: cancelUrl,
    "subscription_data[metadata][vendorId]": vendorId,
    "subscription_data[metadata][planId]": plan,
  });

  const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const json = await resp.json() as { url?: string; id?: string; error?: { message: string } };
  if (!resp.ok || !json.url) {
    throw new https.HttpsError("internal", json.error?.message ?? "Failed to initialize Stripe checkout.");
  }

  return { success: true, authorizationUrl: json.url, reference: json.id };
});
