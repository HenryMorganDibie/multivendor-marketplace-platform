"use client";

import { useCallback, useEffect, useState } from "react";
import { Check } from "lucide-react";
import { callable } from "@/lib/firebase";
import { useVendorAuth } from "@/lib/useVendorAuth";
import { GetOfferingsResponse, GetSubscriptionStatusResponse, PaidSubscriptionPlanId, SubscriptionPlanId } from "@/lib/types";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge, StatusTone } from "@/components/StatusBadge";

const PLAN_DISPLAY_FALLBACK: Record<SubscriptionPlanId, string> = {
  basic: "Basic",
  standard: "Standard",
  pro: "Pro",
  pro_plus: "Pro+",
};

const PLAN_TIER_RANK: Record<SubscriptionPlanId, number> = {
  basic: 0,
  standard: 1,
  pro: 2,
  pro_plus: 3,
};

const PLAN_LIMIT_ROWS: { key: string; label: string }[] = [
  { key: "catalogItemLimit", label: "Catalog items" },
  { key: "invoicesPerMonth", label: "Invoices per month" },
  { key: "aiRepliesPerMonth", label: "Ask the platform AI replies / month" },
  { key: "activePromotionsLimit", label: "Active promotions" },
];

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
  const { access } = useVendorAuth();
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

  const { reason, effectivePlan, subscription, planLimits } = statusRes;
  const displayName = offerings?.plans.find((p) => p.plan === effectivePlan)?.displayName ?? PLAN_DISPLAY_FALLBACK[effectivePlan];

  let statusLabel = "Basic (free)";
  let statusTone: StatusTone = "neutral";
  if (reason === "active" || reason === "trialing") {
    if (subscription?.cancelAtPeriodEnd) {
      statusLabel = "Cancelling";
      statusTone = "warning";
    } else {
      statusLabel = "Active";
      statusTone = "success";
    }
  } else if (reason === "grace_period") {
    statusLabel = "Past due";
    statusTone = "danger";
  } else if (reason === "cancelled_before_period_end") {
    statusLabel = "Cancelled";
    statusTone = "neutral";
  } else if (reason === "expired_or_other" && effectivePlan !== "basic") {
    statusLabel = "Expired";
    statusTone = "neutral";
  } else if (reason === "admin_override") {
    statusLabel = "Managed by the platform";
    statusTone = "info";
  }

  const price = subscription?.currentMonthlyPriceMinorUnits ?? offerings?.plans.find((p) => p.plan === effectivePlan)?.monthlyPriceMinorUnits;
  const currency = subscription?.currency ?? offerings?.currencyCode ?? null;

  const allPlansUnavailable = offerings ? offerings.plans.every((p) => !p.available) : false;
  const noPricingForCountry = offerings ? offerings.plans.every((p) => p.unavailableReason === "PRICING_NOT_CONFIGURED") : false;
  const otherPlans = offerings ? offerings.plans.filter((p) => p.plan !== effectivePlan) : [];

  return (
    <div>
      <PageHeader title="Subscription" description="Manage your the platform plan, billing, and usage limits." />

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {/* Current plan card */}
      <div className="mt-6 rounded-2xl border border-gray-100 p-5 dark:border-gray-800">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge label="Current plan" tone="info" />
          <StatusBadge label={statusLabel} tone={statusTone} />
        </div>

        <div className="mt-3 flex flex-wrap items-baseline justify-between gap-3">
          <p className="text-2xl font-bold">{displayName}</p>
          {typeof price === "number" && (
            <p className="text-lg font-semibold text-gray-700 dark:text-gray-300">
              {formatPrice(price, currency)}
              <span className="text-sm font-normal text-gray-500 dark:text-gray-400"> / month</span>
            </p>
          )}
        </div>

        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          {access?.area && (
            <p className="text-gray-600 dark:text-gray-400">
              Business area: <span className="font-medium text-gray-900 dark:text-gray-100">{access.area}{access.country ? `, ${access.country}` : ""}</span>
            </p>
          )}
          {(reason === "active" || reason === "trialing") && subscription && !subscription.cancelAtPeriodEnd && !subscription.pendingDowngradePlan && (
            <p className="text-gray-600 dark:text-gray-400">
              Renews on <span className="font-medium text-gray-900 dark:text-gray-100">{formatDate(subscription.currentPeriodEnd)}</span>
            </p>
          )}
          {(reason === "active" || reason === "trialing") && subscription?.cancelAtPeriodEnd && (
            <p className="text-gray-600 dark:text-gray-400">
              Access ends <span className="font-medium text-gray-900 dark:text-gray-100">{formatDate(subscription.currentPeriodEnd)}</span>
            </p>
          )}
          {reason === "grace_period" && subscription && (
            <p className="text-red-700 dark:text-red-400">
              Update payment before <span className="font-medium">{formatDate(subscription.currentPeriodEnd)}</span> to keep this plan.
            </p>
          )}
          {subscription?.pendingDowngradePlan && (
            <p className="text-gray-600 dark:text-gray-400">
              Downgrading to{" "}
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {PLAN_DISPLAY_FALLBACK[subscription.pendingDowngradePlan as SubscriptionPlanId] ?? subscription.pendingDowngradePlan}
              </span>{" "}
              on {formatDate(subscription.pendingDowngradeAt)}
            </p>
          )}
        </div>

        {reason === "admin_override" && (
          <p className="mt-4 text-sm text-blue-800 dark:text-blue-300">
            Your plan is currently managed by the platform support. Self-service billing actions aren&apos;t available while this is active.
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-3">
          {(reason === "active" || reason === "trialing") && !subscription?.cancelAtPeriodEnd && (
            <button
              type="button"
              disabled={actionBusy !== null}
              onClick={handleCancel}
              className="rounded-full border border-gray-300 px-4 py-2 text-sm font-semibold hover:border-red-400 hover:text-red-600 disabled:opacity-50"
            >
              {actionBusy === "cancel" ? "Cancelling…" : "Cancel subscription"}
            </button>
          )}
          {(reason === "active" || reason === "trialing") && subscription?.cancelAtPeriodEnd && (
            <button
              type="button"
              disabled={actionBusy !== null}
              onClick={handleReactivate}
              className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
            >
              {actionBusy === "reactivate" ? "Resuming…" : "Resume subscription"}
            </button>
          )}
        </div>
      </div>

      {/* Plan limits — ceilings enforced by the backend today. Not a "used
          so far" progress bar: the backend doesn't currently track/return a
          per-vendor usage counter, only the plan's limit. */}
      {planLimits && (
        <div className="mt-6 rounded-2xl border border-gray-100 p-5 dark:border-gray-800">
          <p className="text-sm font-semibold">What&apos;s included in your plan</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PLAN_LIMIT_ROWS.map((row) => {
              const value = (planLimits as Record<string, unknown>)[row.key];
              if (typeof value !== "number") return null;
              return (
                <div key={row.key} className="rounded-xl bg-surface-canvas p-3.5 dark:bg-gray-900">
                  <p className="text-lg font-bold">{value}</p>
                  <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{row.label}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Available plans */}
      <div className="mt-6">
        <p className="text-sm font-semibold">Available plans</p>
        {allPlansUnavailable ? (
          <p className="mt-3 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
            {noPricingForCountry
              ? "Subscriptions are not available in your country yet."
              : "Subscriptions are temporarily unavailable. Please try again later."}
          </p>
        ) : (
          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {otherPlans.map((plan) => (
              <div key={plan.plan} className="flex flex-col rounded-2xl border border-gray-100 p-5 dark:border-gray-800">
                <p className="font-semibold">{plan.displayName ?? PLAN_DISPLAY_FALLBACK[plan.plan]}</p>
                <p className="mt-1 text-xl font-bold">
                  {plan.available ? formatPrice(plan.monthlyPriceMinorUnits, offerings?.currencyCode ?? null) : "—"}
                  {plan.available && <span className="text-sm font-normal text-gray-500 dark:text-gray-400"> / month</span>}
                </p>
                {plan.features && plan.features.length > 0 && (
                  <ul className="mt-4 flex-1 space-y-2 text-sm text-gray-600 dark:text-gray-400">
                    {plan.features.slice(0, 6).map((feature) => (
                      <li key={feature} className="flex items-start gap-2">
                        <Check size={15} className="mt-0.5 shrink-0 text-brand" />
                        {feature}
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  type="button"
                  disabled={!plan.available || actionBusy !== null}
                  onClick={() => handleCheckout(plan.plan)}
                  className="mt-5 w-full rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
                >
                  {actionBusy === plan.plan
                    ? "Starting…"
                    : plan.available
                    ? PLAN_TIER_RANK[plan.plan] > PLAN_TIER_RANK[effectivePlan]
                      ? "Upgrade"
                      : "Downgrade"
                    : "Unavailable"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
