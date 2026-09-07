import { https } from "firebase-functions/v2";
import { db, FieldValue, Timestamp } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { newRequestId } from "../utils/requestContext";
import { SubscriptionPlanId, VendorSubscriptionDoc } from "../types4";
import { resolveEffectivePlan } from "./resolveEffectivePlan";
import { enforceRateLimit } from "./rateLimit";
import { withSubscriptionLock, LockContentionError } from "./subscriptionLock";
import {
  requireActiveCountryPricing, resolveVendorCountry, selectProvider,
  requireMonthlyBillingInterval, PaidPlanId,
  PRICING_NOT_CONFIGURED, PAYMENT_PROVIDER_NOT_CONFIGURED,
} from "./countryPricing";
import { runFlutterwaveCheckout, runStripeCheckout, cancelProviderSubscription } from "./internationalCheckout";
import { requireBillingEligibleVendor } from "../vendors/requireBillingEligible";
import { sendSubscriptionEmail, getVendorEmail } from "./subscriptionEmail";

const VALID_PLAN_IDS: SubscriptionPlanId[] = ["basic", "standard", "pro", "pro_plus"];
const PAID_PLAN_IDS: PaidPlanId[] = ["standard", "pro", "pro_plus"];
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);

/**
 * A vendor billed through Apple/Google IAP cannot be moved to a web
 * provider by cancel-and-recheckout the way Paystack/Flutterwave/Stripe can
 * be swapped between each other. Apple/Google subscriptions can only be
 * cancelled by the vendor themselves, in that store's own subscription
 * settings, not by a server-side API call (per the client's business decision,
 * 2026-08-09: one active subscription across Apple/Google/web at a time;
 * switching providers means cancel with the current one, keep access until
 * the paid period ends, then subscribe fresh with the new one). Web-to-web
 * switches are unaffected by this and keep the existing immediate
 * cancel-and-recheckout behavior below, since the frontend already treats
 * Paystack/Flutterwave/Stripe as one interchangeable "web billing" rail.
 */
export const ALREADY_SUBSCRIBED_VIA_STORE = "ALREADY_SUBSCRIBED_VIA_STORE";

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

async function runPaystackCheckout(params: {
  vendorId: string; plan: string; planCode: string; email: string;
}): Promise<{ success: true; authorizationUrl: string; reference: string }> {
  const requestId = newRequestId();
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
    body: JSON.stringify({ email: params.email, plan: params.planCode, metadata: { vendorId: params.vendorId, plan: params.plan, billingInterval: "monthly" } }),
  });
  const json = await resp.json() as { status: boolean; data?: { authorization_url: string; reference: string }; message?: string };
  if (!resp.ok || !json.status || !json.data) {
    throw new https.HttpsError("internal", json.message ?? "Failed to initialize checkout.");
  }

  return { success: true, authorizationUrl: json.data.authorization_url, reference: json.data.reference };
}

/**
 * createSubscriptionCheckout (Phase 4, Section 5.1 — provider-neutral per
 * LANDING_PAGE_CMS_VENDOR_PORTAL_MAPPING.md Section 4 and
 * frontend-subscription-alignment-scope.md Section 4).
 *
 * The ONLY public checkout callable. Resolves the vendor's country
 * (migration-safe fallback), selects the provider server-side from that
 * country's private priority configuration, and prevents double-billing by
 * cancelling any existing live subscription before starting a new one
 * (Section 12.1.4). The frontend sends only `{ plan }` and never knows
 * which provider was used. Rate limited: 5/60s per vendor.
 */
export const createSubscriptionCheckout = https.onCall(async (request) => {
  checkAppCheck(request, "createSubscriptionCheckout");
  const vendorId = await requireVendorId(request);
  await requireBillingEligibleVendor(vendorId);
  await enforceRateLimit(vendorId, "createSubscriptionCheckout");

  const { plan, billingInterval } = request.data ?? {};
  requireMonthlyBillingInterval(billingInterval);
  if (!VALID_PLAN_IDS.includes(plan)) {
    throw new https.HttpsError("invalid-argument", `plan must be one of: ${VALID_PLAN_IDS.join(", ")}.`);
  }
  if (plan === "basic") {
    throw new https.HttpsError("invalid-argument", "Basic is free in every market — there is nothing to check out.");
  }
  const planId = plan as PaidPlanId;

  const countryCode = await resolveVendorCountry(vendorId);
  await requireActiveCountryPricing(countryCode);
  const { provider, mapping } = await selectProvider(countryCode, planId);

  const userSnap = await db.collection("users").doc(request.auth!.uid).get();
  const email = userSnap.data()?.email as string | undefined;
  if (!email) throw new https.HttpsError("failed-precondition", "Vendor account has no email on file.");

  // Double-billing prevention (Section 12.1.4): if the vendor already has a
  // live recurring subscription, its provider-side subscription must be
  // cancelled BEFORE a new checkout starts, so they're never billed on two
  // plans simultaneously. Locked against concurrent webhook processing so
  // a renewal webhook can't land mid-swap.
  try {
    await withSubscriptionLock(vendorId, `createSubscriptionCheckout:${newRequestId()}`, async () => {
      const subSnap = await db.collection("vendorSubscriptions").doc(vendorId).get();
      if (subSnap.exists) {
        const existing = subSnap.data() as VendorSubscriptionDoc;
        if (ACTIVE_SUBSCRIPTION_STATUSES.has(existing.status)) {
          // Apple/Google cannot be cancelled by a server-side call; only the
          // vendor can do that in the store's own subscription settings.
          // Reject outright rather than silently leaving them billed twice.
          if (existing.provider === "apple" || existing.provider === "google") {
            const storeName = existing.provider === "apple" ? "the App Store" : "Google Play";
            const periodEndMs = existing.currentPeriodEnd && "toMillis" in existing.currentPeriodEnd
              ? existing.currentPeriodEnd.toMillis()
              : null;
            throw new https.HttpsError(
              "failed-precondition",
              `Already subscribed to ${existing.plan} via ${storeName}. Cancel there first, keep access until the period ends, then subscribe again.`,
              {
                errorCode: ALREADY_SUBSCRIBED_VIA_STORE,
                provider: existing.provider,
                plan: existing.plan,
                currentPeriodEndMs: periodEndMs,
              }
            );
          }
          if (existing.providerSubscriptionId) {
            await cancelProviderSubscription(existing.provider as "paystack" | "flutterwave" | "stripe", existing.providerSubscriptionId);
          }
        }
      }
    });
  } catch (err) {
    if (err instanceof LockContentionError) throw new https.HttpsError("aborted", "Subscription is mid-update. Please retry shortly.");
    throw err;
  }

  if (provider === "paystack") {
    return runPaystackCheckout({ vendorId, plan, planCode: mapping.paystack!.monthlyPlanCode, email });
  }
  if (provider === "flutterwave") {
    const pricing = await requireActiveCountryPricing(countryCode);
    return runFlutterwaveCheckout({ vendorId, plan, currencyCode: pricing.currencyCode, mapping, email });
  }
  return runStripeCheckout({ vendorId, plan, mapping, email });
});

/**
 * getVendorSubscriptionOfferings — authenticated, used by the Vendor
 * Portal and mobile app only (frontend-subscription-alignment-scope.md
 * Section 5.1). Resolves the vendor's country exclusively server-side;
 * accepts no client-supplied country. Never returns provider names,
 * priority, or mapping data under any field name.
 */
export const getVendorSubscriptionOfferings = https.onCall(async (request) => {
  checkAppCheck(request, "getVendorSubscriptionOfferings");
  const vendorId = await requireVendorId(request);
  const countryCode = await resolveVendorCountry(vendorId);
  return buildOfferingsResponse(countryCode);
});

/**
 * getPublicSubscriptionOfferings — unauthenticated, used only by the
 * public marketing Pricing page (Section 5.2). Accepts a visitor-supplied
 * countryCode, validated against subscriptionPricing directly (not the
 * location catalogue, to avoid a second dependency for this read-only
 * path). Never authorizes checkout — browsing only. Rate limited since
 * this is the one offerings path with no auth boundary at all.
 */
export const getPublicSubscriptionOfferings = https.onCall(async (request) => {
  checkAppCheck(request, "getPublicSubscriptionOfferings");
  const ip = request.rawRequest?.ip ?? "unknown";
  await enforceRateLimit(`public:${ip}`, "getPublicSubscriptionOfferings", 20);

  const countryCode = (request.data as { countryCode?: unknown } | undefined)?.countryCode;
  if (typeof countryCode !== "string" || !countryCode) {
    throw new https.HttpsError("invalid-argument", "countryCode is required.");
  }
  return buildOfferingsResponse(countryCode);
});

interface PlanOffering {
  plan: PaidPlanId;
  monthlyPriceMinorUnits: number;
  available: boolean;
  unavailableReason?: typeof PRICING_NOT_CONFIGURED | typeof PAYMENT_PROVIDER_NOT_CONFIGURED;
  displayName?: string;
  features?: string[];
}

/**
 * Shared response builder for both offerings callables — combines public
 * pricing with private provider priority/mapping server-side, but returns
 * only country, currency, plan, price, availability, and a vendor-safe
 * unavailable reason. Never throws for a missing/inactive country; the
 * whole point is to let the frontend render an unavailable state instead
 * of discovering it from a failed checkout call.
 */
/** Reads displayName/features from the seeded subscriptionPlans/{planId}
 * docs (single source of truth per seedSubscriptionPlans) so the frontend
 * never hardcodes marketing copy — an admin editing a plan doc changes what
 * vendors see without a redeploy. */
async function attachPlanDisplay(offerings: PlanOffering[]): Promise<PlanOffering[]> {
  const planDocs = await Promise.all(
    offerings.map((o) => db.collection("subscriptionPlans").doc(o.plan).get())
  );
  return offerings.map((offering, i) => {
    const doc = planDocs[i].exists ? planDocs[i].data() : null;
    return {
      ...offering,
      displayName: (doc?.displayName as string | undefined) ?? offering.plan,
      features: (doc?.features as string[] | undefined) ?? [],
    };
  });
}

async function buildOfferingsResponse(countryCode: string): Promise<{
  success: true; countryCode: string; currencyCode: string | null; plans: PlanOffering[];
}> {
  if (!countryCode) {
    const plans = await attachPlanDisplay(
      PAID_PLAN_IDS.map((plan) => ({ plan, monthlyPriceMinorUnits: 0, available: false, unavailableReason: PRICING_NOT_CONFIGURED }))
    );
    return { success: true, countryCode, currencyCode: null, plans };
  }

  const pricingSnap = await db.collection("subscriptionPricing").doc(countryCode).get();
  const pricing = pricingSnap.exists ? (pricingSnap.data() as import("../types4").SubscriptionPricingRecord) : null;
  if (!pricing || pricing.status !== "active") {
    const plans = await attachPlanDisplay(
      PAID_PLAN_IDS.map((plan) => ({ plan, monthlyPriceMinorUnits: 0, available: false, unavailableReason: PRICING_NOT_CONFIGURED }))
    );
    return { success: true, countryCode, currencyCode: pricing?.currencyCode ?? null, plans };
  }

  const providerConfigSnap = await db.collection("subscriptionProviderConfig").doc(countryCode).get();
  const providerPriority = providerConfigSnap.exists
    ? (providerConfigSnap.data()?.providerPriority as string[] | undefined) ?? []
    : [];
  const providerConfigActive = providerConfigSnap.exists && providerConfigSnap.data()?.status === "active" && providerPriority.length > 0;

  const plans: PlanOffering[] = await Promise.all(PAID_PLAN_IDS.map(async (plan): Promise<PlanOffering> => {
    const monthlyPriceMinorUnits = pricing.plans[plan].monthlyPriceMinorUnits;
    if (!providerConfigActive) {
      return { plan, monthlyPriceMinorUnits, available: false, unavailableReason: PAYMENT_PROVIDER_NOT_CONFIGURED };
    }
    const mappingSnap = await db.collection("providerPlanMapping").doc(`${countryCode}-${plan}`).get();
    const mapping = mappingSnap.exists ? mappingSnap.data() : null;
    const hasUsableProvider = mapping && providerPriority.some((p) => Boolean((mapping as Record<string, unknown>)[p]));
    if (!hasUsableProvider) {
      return { plan, monthlyPriceMinorUnits, available: false, unavailableReason: PAYMENT_PROVIDER_NOT_CONFIGURED };
    }
    return { plan, monthlyPriceMinorUnits, available: true };
  }));

  return { success: true, countryCode, currencyCode: pricing.currencyCode, plans: await attachPlanDisplay(plans) };
}

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
      const sub = subSnap.data() as VendorSubscriptionDoc;

      // Setting cancelAtPeriodEnd alone only changes the platform's own record —
      // the provider's recurring billing keeps running until told to stop,
      // and its next renewal webhook would silently overwrite this flag
      // back to false (processNormalizedWebhookEvent's activation/renewal
      // branch), re-"activating" a subscription the vendor explicitly
      // cancelled while charging their card again. Apple/Google can only be
      // cancelled by the vendor in the store's own settings (same
      // constraint as ALREADY_SUBSCRIBED_VIA_STORE above); web providers
      // must be told directly, same call already used for plan switches.
      if (
        (sub.provider === "paystack" || sub.provider === "flutterwave" || sub.provider === "stripe")
        && sub.providerSubscriptionId
      ) {
        await cancelProviderSubscription(sub.provider, sub.providerSubscriptionId);
      }

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

  // Fire-and-forget, after the lock-guarded update above has committed.
  void getVendorEmail(vendorId).then((email) => { if (email) void sendSubscriptionEmail(email, "cancelled", { vendorId }); });

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

  // Fire-and-forget, after the lock-guarded update above has committed.
  void getVendorEmail(vendorId).then((email) => { if (email) void sendSubscriptionEmail(email, "reactivated", { vendorId }); });

  return { success: true };
});

/**
 * requestSubscriptionDowngrade (Section 12.2). Sets pendingDowngradePlan
 * only — never touches the provider or the vendor's current access, since
 * the vendor keeps their current plan's features until the period ends
 * (Section 12.2 point 2). The actual transition happens in
 * expireStaleSubscriptions at currentPeriodEnd.
 *
 * Direction confirmed 2026-08-27: the current checkout architecture (every
 * provider is a vendor-driven hosted-page redirect, no stored card/
 * authorization anywhere) cannot silently re-bill a vendor at a new amount
 * with zero action, which is what a literal reading of Section 12.2 would
 * require for a downgrade between two paid tiers. Approved fallback: at the
 * effective date the old provider subscription is cancelled (so the higher
 * price never bills again) and the vendor is prompted to complete one
 * checkout for the target plan — see expireStaleSubscriptions. Downgrading
 * to Basic needs no such follow-up since Basic has no checkout at all.
 */
export const requestSubscriptionDowngrade = https.onCall(async (request) => {
  const requestId = newRequestId();
  checkAppCheck(request, "requestSubscriptionDowngrade");
  const vendorId = await requireVendorId(request);
  await enforceRateLimit(vendorId, "requestSubscriptionDowngrade");

  const { plan } = request.data ?? {};
  if (!VALID_PLAN_IDS.includes(plan)) {
    throw new https.HttpsError("invalid-argument", `plan must be one of: ${VALID_PLAN_IDS.join(", ")}.`);
  }
  const targetPlan = plan as SubscriptionPlanId;

  try {
    await withSubscriptionLock(vendorId, `requestSubscriptionDowngrade:${requestId}`, async () => {
      const subRef = db.collection("vendorSubscriptions").doc(vendorId);
      const subSnap = await subRef.get();
      if (!subSnap.exists) throw new https.HttpsError("not-found", "No active subscription.");
      const sub = subSnap.data() as VendorSubscriptionDoc;

      if (!ACTIVE_SUBSCRIPTION_STATUSES.has(sub.status)) {
        throw new https.HttpsError("failed-precondition", "No active subscription to downgrade.");
      }
      if (sub.cancelAtPeriodEnd) {
        throw new https.HttpsError("failed-precondition", "Subscription is already scheduled for cancellation. Reactivate first if you want to downgrade instead.");
      }
      if (sub.provider === "apple" || sub.provider === "google") {
        // Store-billed subscriptions can only be changed by the vendor in
        // that store's own subscription settings — same constraint as
        // ALREADY_SUBSCRIBED_VIA_STORE above, applied to downgrades too.
        const storeName = sub.provider === "apple" ? "the App Store" : "Google Play";
        throw new https.HttpsError(
          "failed-precondition",
          `This subscription is billed through ${storeName}. Change or cancel your plan there — it can't be scheduled from the portal.`,
          { errorCode: ALREADY_SUBSCRIBED_VIA_STORE, provider: sub.provider }
        );
      }

      const currentRank = VALID_PLAN_IDS.indexOf(sub.plan);
      const targetRank = VALID_PLAN_IDS.indexOf(targetPlan);
      if (targetRank >= currentRank) {
        throw new https.HttpsError("invalid-argument", "Target plan must be lower than your current plan. Use upgrade instead.");
      }

      const now = FieldValue.serverTimestamp();
      await subRef.update({
        pendingDowngradePlan: targetPlan,
        pendingDowngradeAt: now,
        lastEventType: "vendor.downgrade_requested",
        lastEventAt: now,
        version: FieldValue.increment(1),
        updatedAt: now,
      });
    });
  } catch (err) {
    if (err instanceof LockContentionError) throw new https.HttpsError("aborted", "Subscription is mid-update. Please retry shortly.");
    throw err;
  }

  void getVendorEmail(vendorId).then((email) => {
    if (email) void sendSubscriptionEmail(email, "plan_changed_downgrade_pending", { vendorId, plan: targetPlan });
  });

  return { success: true };
});

/**
 * cancelPendingDowngrade (Section 12.2 point 4). Vendor may cancel a
 * pending downgrade at any point before it becomes effective, remaining on
 * their current plan — mirrors reactivateSubscription's shape.
 */
export const cancelPendingDowngrade = https.onCall(async (request) => {
  const requestId = newRequestId();
  checkAppCheck(request, "cancelPendingDowngrade");
  const vendorId = await requireVendorId(request);
  await enforceRateLimit(vendorId, "cancelPendingDowngrade");

  try {
    await withSubscriptionLock(vendorId, `cancelPendingDowngrade:${requestId}`, async () => {
      const subRef = db.collection("vendorSubscriptions").doc(vendorId);
      const subSnap = await subRef.get();
      if (!subSnap.exists) throw new https.HttpsError("not-found", "No subscription.");
      const sub = subSnap.data() as VendorSubscriptionDoc;

      if (!sub.pendingDowngradePlan) {
        throw new https.HttpsError("failed-precondition", "No pending downgrade to cancel.");
      }

      const now = FieldValue.serverTimestamp();
      await subRef.update({
        pendingDowngradePlan: null,
        pendingDowngradeAt: null,
        lastEventType: "vendor.downgrade_cancelled",
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
