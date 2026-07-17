"use client";

import { useCallback, useEffect, useState } from "react";
import { callable } from "@/lib/firebase";
import { GetOfferingsResponse, GetSubscriptionStatusResponse, PaidSubscriptionPlanId } from "@/lib/types";

const PLAN_DISPLAY_NAME: Record<PaidSubscriptionPlanId, string> = {
  standard: "Standard",
  pro: "Pro",
  pro_plus: "Pro+",
};

function formatDate(value: unknown): string {
  if (!value) return "—";
  if (typeof value === "string") return new Date(value).toLocaleDateString();
  if (typeof value === "object" && value !== null && "seconds" in value) {
    return new Date((value as { seconds: number }).seconds * 1000).toLocaleDateString();
  }
  return "—";
}

function formatPrice(minorUnits: number, currencyCode: string | null): string {
  if (!currencyCode) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currencyCode }).format(minorUnits / 100);
  } catch {
    return `${currencyCode} ${(minorUnits / 100).toFixed(2)}`;
  }
}

export default function SubscriptionPage() {
  const [statusRes, setStatusRes] = useState<GetSubscriptionStatusResponse | null>(null);
  const [offerings, setOfferings] = useState<GetOfferingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const getStatus = callable<Record<string, never>, GetSubscriptionStatusResponse>("getSubscriptionStatus");
      const getOfferings = callable<Record<string, never>, GetOfferingsResponse>("getVendorSubscriptionOfferings");
      const [statusResult, offeringsResult] = await Promise.all([getStatus({}), getOfferings({})]);
      setStatusRes(statusResult.data);
      setOfferings(offeringsResult.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load subscription details.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCheckout(plan: PaidSubscriptionPlanId) {
    setActionBusy(plan);
    setError(null);
    try {
      const checkout = callable<{ plan: string; billingInterval: string }, { checkoutUrl?: string; authorizationUrl?: string }>(
        "createSubscriptionCheckout"
      );
      const res = await checkout({ plan, billingInterval: "monthly" });
      const url = res.data.checkoutUrl ?? res.data.authorizationUrl;
      if (url) window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start checkout.");
    } finally {
      setActionBusy(null);
    }
  }

  async function handleCancel() {
    setActionBusy("cancel");
    setError(null);
    try {
      await callable("cancelSubscription")({});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't cancel subscription.");
    } finally {
      setActionBusy(null);
    }
  }

  async function handleReactivate() {
    setActionBusy("reactivate");
    setError(null);
    try {
      await callable("reactivateSubscription")({});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reactivate subscription.");
    } finally {
      setActionBusy(null);
    }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading subscription…</p>;
  if (error && !statusRes) return <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!statusRes) return null;

  const { reason, effectivePlan, subscription } = statusRes;
  const allPlansUnavailable = offerings ? offerings.plans.every((p) => !p.available) : false;
  const noPricingForCountry = offerings ? offerings.plans.every((p) => p.unavailableReason === "PRICING_NOT_CONFIGURED") : false;

  function PlanPicker() {
    if (!offerings) return null;
    if (allPlansUnavailable) {
      return (
        <p className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
          {noPricingForCountry
            ? "Subscriptions are not available in your country yet."
            : "Subscriptions are temporarily unavailable. Please try again later."}
        </p>
      );
    }
    return (
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {offerings.plans.map((plan) => (
          <div key={plan.plan} className="rounded-xl border border-gray-100 p-4 dark:border-gray-800">
            <p className="font-semibold">{PLAN_DISPLAY_NAME[plan.plan]}</p>
            <p className="mt-1 text-lg font-bold">{plan.available ? formatPrice(plan.monthlyPriceMinorUnits, offerings.currencyCode) : "—"}</p>
            <button
              type="button"
              disabled={!plan.available || actionBusy !== null}
              onClick={() => handleCheckout(plan.plan)}
              className="mt-3 w-full rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
            >
              {actionBusy === plan.plan ? "Starting…" : plan.available ? "Subscribe" : "Unavailable"}
            </button>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-xl font-semibold">Subscription</h2>

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {reason === "no_subscription" && (
        <div className="mt-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">You&apos;re on the free Basic plan.</p>
          <PlanPicker />
        </div>
      )}

      {reason === "admin_override" && subscription && (
        <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950">
          <p className="font-semibold">{PLAN_DISPLAY_NAME[subscription.plan as PaidSubscriptionPlanId] ?? subscription.plan}</p>
          <p className="mt-1 text-sm text-blue-800 dark:text-blue-300">
            Your plan is currently managed by the platform support. Self-service billing actions aren&apos;t available while this is active.
          </p>
        </div>
      )}

      {(reason === "active" || reason === "trialing") && subscription && !subscription.cancelAtPeriodEnd && !subscription.pendingDowngradePlan && (
        <div className="mt-4 rounded-xl border border-gray-100 p-4 dark:border-gray-800">
          <p className="font-semibold">{PLAN_DISPLAY_NAME[subscription.plan as PaidSubscriptionPlanId] ?? subscription.plan}</p>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Renews on {formatDate(subscription.currentPeriodEnd)}</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={actionBusy !== null}
              onClick={handleCancel}
              className="rounded-full border border-gray-300 px-4 py-2 text-sm font-semibold hover:border-red-400 hover:text-red-600 disabled:opacity-50"
            >
              {actionBusy === "cancel" ? "Cancelling…" : "Cancel subscription"}
            </button>
          </div>
          <p className="mt-6 text-sm font-medium text-gray-700 dark:text-gray-300">Change plan</p>
          <PlanPicker />
        </div>
      )}

      {(reason === "active" || reason === "trialing") && subscription?.cancelAtPeriodEnd && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950">
          <p className="font-semibold">{PLAN_DISPLAY_NAME[subscription.plan as PaidSubscriptionPlanId] ?? subscription.plan}</p>
          <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">Cancelling on {formatDate(subscription.currentPeriodEnd)}</p>
          <button
            type="button"
            disabled={actionBusy !== null}
            onClick={handleReactivate}
            className="mt-4 rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
          >
            {actionBusy === "reactivate" ? "Reactivating…" : "Reactivate"}
          </button>
        </div>
      )}

      {(reason === "active" || reason === "trialing") && subscription?.pendingDowngradePlan && (
        <div className="mt-4 rounded-xl border border-gray-100 p-4 dark:border-gray-800">
          <p className="font-semibold">{PLAN_DISPLAY_NAME[subscription.plan as PaidSubscriptionPlanId] ?? subscription.plan}</p>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Downgrading to {PLAN_DISPLAY_NAME[subscription.pendingDowngradePlan as PaidSubscriptionPlanId] ?? subscription.pendingDowngradePlan} on{" "}
            {formatDate(subscription.pendingDowngradeAt)}
          </p>
        </div>
      )}

      {reason === "grace_period" && subscription && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950">
          <p className="font-semibold text-red-800 dark:text-red-300">There&apos;s an issue with your last payment</p>
          <p className="mt-1 text-sm text-red-700 dark:text-red-400">
            Please update your payment method before {formatDate(subscription.currentPeriodEnd)} to keep your {PLAN_DISPLAY_NAME[subscription.plan as PaidSubscriptionPlanId] ?? subscription.plan} plan.
          </p>
          <div className="mt-4">
            <PlanPicker />
          </div>
        </div>
      )}

      {reason === "cancelled_before_period_end" && subscription && (
        <div className="mt-4 rounded-xl border border-gray-100 p-4 dark:border-gray-800">
          <p className="font-semibold text-gray-700 dark:text-gray-300">Your subscription has been cancelled.</p>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">You can resubscribe at any time.</p>
          <PlanPicker />
        </div>
      )}

      {reason === "expired_or_other" && (
        <div className="mt-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {effectivePlan === "basic" ? "You're on the free Basic plan." : "Your subscription is inactive."}
          </p>
          <PlanPicker />
        </div>
      )}
    </div>
  );
}
