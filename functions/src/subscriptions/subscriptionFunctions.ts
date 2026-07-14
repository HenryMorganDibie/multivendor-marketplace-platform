import { https } from "firebase-functions/v2";
import { db, FieldValue, Timestamp } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { newRequestId } from "../utils/requestContext";
import { SubscriptionPlanId, VendorSubscriptionDoc } from "../types4";
import { resolveEffectivePlan } from "./resolveEffectivePlan";
import { enforceRateLimit } from "./rateLimit";
import { withSubscriptionLock, LockContentionError } from "./subscriptionLock";
import { requireActiveCountryPricing, requireProviderPlanMapping, PaidPlanId } from "./countryPricing";

const VALID_PLAN_IDS: SubscriptionPlanId[] = ["basic", "standard", "pro", "pro_plus"];

function getPaystackSecret(): string {
  return process.env.PAYSTACK_SECRET_KEY ?? (process.env.FUNCTIONS_EMULATOR === "true" ? "emulator_test_secret" : "");
}

async function requireVendorId(request: https.CallableRequest<unknown>): Promise<string> {
  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string | undefined;
  if (!vendorId) throw new https.HttpsError("failed-precondition", "Vendor ID could not be determined.");
  return vendorId;
}

/**
 * createSubscriptionCheckout (Phase 4, Section 5.1).
 *
 * Looks up the Paystack plan code from the PRIVATE providerPlanCodes
 * collection via the Admin SDK (never exposed to any client) and asks
 * Paystack to initialize a transaction, returning the authorization URL
 * for the client to open. Rate limited: 5/60s per vendor.
 */
export const createSubscriptionCheckout = https.onCall(async (request) => {
  const requestId = newRequestId();
  checkAppCheck(request, "createSubscriptionCheckout");
  const vendorId = await requireVendorId(request);
  await enforceRateLimit(vendorId, "createSubscriptionCheckout");

  // billingInterval is still accepted on the request (for backward
  // compatibility with existing callers) but ignored — monthly only for
  // MVP, per the per-country pricing rollout decision. Yearly pricing
  // isn't represented anywhere in subscriptionPricing yet.
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
  const mapping = await requireProviderPlanMapping(countryCode, planId, "paystack");
  const planCode = mapping.paystack!.monthlyPlanCode;

  const userSnap = await db.collection("users").doc(request.auth!.uid).get();
  const email = userSnap.data()?.email as string | undefined;
  if (!email) throw new https.HttpsError("failed-precondition", "Vendor account has no email on file.");

  const secret = getPaystackSecret();
  const isEmulator = process.env.FUNCTIONS_EMULATOR === "true";

  if (isEmulator) {
    // No real Paystack call in the emulator — return a deterministic fake
    // authorization URL so acceptance tests can exercise this callable
    // end-to-end without live network access or a real Paystack account.
    return {
      success: true,
      authorizationUrl: `https://checkout.paystack.test/${requestId}`,
      reference: requestId,
    };
  }

  const resp = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, plan: planCode, metadata: { vendorId, plan, billingInterval: "monthly" } }),
  });
  const json = await resp.json() as { status: boolean; data?: { authorization_url: string; reference: string }; message?: string };
  if (!resp.ok || !json.status || !json.data) {
    throw new https.HttpsError("internal", json.message ?? "Failed to initialize checkout.");
  }

  return { success: true, authorizationUrl: json.data.authorization_url, reference: json.data.reference };
});

/**
 * getSubscriptionStatus (Phase 4, Section 5.3). Vendor or admin.
 */
export const getSubscriptionStatus = https.onCall(async (request) => {
  checkAppCheck(request, "getSubscriptionStatus");
  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");

  const requestedVendorId = (request.data as { vendorId?: string } | undefined)?.vendorId;
  let vendorId: string;
  if (request.auth.token.role === "admin") {
    if (!requestedVendorId) throw new https.HttpsError("invalid-argument", "vendorId is required for admin requests.");
    vendorId = requestedVendorId;
  } else {
    vendorId = await requireVendorId(request);
  }

  const effective = await resolveEffectivePlan(vendorId);
  const eventsSnap = await db.collection("subscriptionEvents")
    .where("vendorId", "==", vendorId)
    .orderBy("processedAt", "desc")
    .limit(10)
    .get();

  return {
    success: true,
    subscription: effective.subscription,
    effectivePlan: effective.plan,
    planLimits: effective.limits,
    reason: effective.reason,
    pendingDowngrade: effective.subscription?.pendingDowngradePlan ?? null,
    recentEvents: eventsSnap.docs.map((d) => d.data()),
  };
});

/**
 * cancelSubscription (Phase 4, Section 5.4). Vendor role, cancel-at-period-
 * end only — immediate cancellation is admin-only (cancelSubscriptionAdmin).
 * Clears any pending downgrade since cancellation takes priority.
 */
export const cancelSubscription = https.onCall(async (request) => {
  const requestId = newRequestId();
  checkAppCheck(request, "cancelSubscription");
  const vendorId = await requireVendorId(request);
  await enforceRateLimit(vendorId, "cancelSubscription");

  try {
    await withSubscriptionLock(vendorId, `cancelSubscription:${requestId}`, async () => {
      const subRef = db.collection("vendorSubscriptions").doc(vendorId);
      const subSnap = await subRef.get();
      if (!subSnap.exists) throw new https.HttpsError("not-found", "No active subscription.");
      const now = FieldValue.serverTimestamp();
      await subRef.update({
        cancelAtPeriodEnd: true,
        cancelledAt: now,
        pendingDowngradePlan: null,
        pendingDowngradeAt: null,
        lastEventType: "vendor.cancelled",
        lastEventAt: now,
        version: FieldValue.increment(1),
        updatedAt: now,
      });
    });
  } catch (err) {
    if (err instanceof LockContentionError) throw new https.HttpsError("aborted", "Subscription is mid-update. Please retry shortly.");
    throw err;
  }

  return { success: true };
});

/**
 * reactivateSubscription (Phase 4, Section 5.5 / Decision C). Only valid
 * before currentPeriodEnd — after that, the vendor must start a fresh
 * subscription via createSubscriptionCheckout.
 */
export const reactivateSubscription = https.onCall(async (request) => {
  const requestId = newRequestId();
  checkAppCheck(request, "reactivateSubscription");
  const vendorId = await requireVendorId(request);
  await enforceRateLimit(vendorId, "reactivateSubscription");

  try {
    await withSubscriptionLock(vendorId, `reactivateSubscription:${requestId}`, async () => {
      const subRef = db.collection("vendorSubscriptions").doc(vendorId);
      const subSnap = await subRef.get();
      if (!subSnap.exists) throw new https.HttpsError("not-found", "No subscription to reactivate.");
      const sub = subSnap.data() as VendorSubscriptionDoc;

      if (!sub.cancelAtPeriodEnd) {
        throw new https.HttpsError("failed-precondition", "Subscription is not scheduled for cancellation.");
      }
      const periodEndMs = sub.currentPeriodEnd && "toMillis" in sub.currentPeriodEnd ? sub.currentPeriodEnd.toMillis() : 0;
      if (periodEndMs <= Date.now()) {
        throw new https.HttpsError("failed-precondition", "Billing period has already ended. Start a new subscription instead.");
      }

      const now = FieldValue.serverTimestamp();
      await subRef.update({
        cancelAtPeriodEnd: false,
        cancelledAt: null,
        lastEventType: "vendor.reactivated",
        lastEventAt: now,
        version: FieldValue.increment(1),
        updatedAt: now,
      });
    });
  } catch (err) {
    if (err instanceof LockContentionError) throw new https.HttpsError("aborted", "Subscription is mid-update. Please retry shortly.");
    throw err;
  }

  return { success: true };
});
