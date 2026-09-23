"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Clock } from "lucide-react";
import { callable } from "@/lib/firebase";
import { formatFirestoreDate } from "@/lib/formatFirestoreDate";
import { useVendorAuth } from "@/lib/useVendorAuth";
import { GetOfferingsResponse, GetSubscriptionStatusResponse, PaidSubscriptionPlanId, PlanOffering, SubscriptionPlanId } from "@/lib/types";
import { EmptyState } from "@/components/EmptyState";
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
  { key: "aiRepliesPerMonth", label: "Ask Platform AI replies / month" },
  { key: "activePromotionsLimit", label: "Active promotions" },
];

// Shared with the invoices screen — see formatFirestoreDate for why the
// underscore-prefixed Timestamp shape has to be handled.
const formatDate = formatFirestoreDate;

function formatPrice(minorUnits: number, currencyCode: string | null): string {
  if (!currencyCode) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currencyCode }).format(minorUnits / 100);
  } catch {
    return `${currencyCode} ${(minorUnits / 100).toFixed(2)}`;
  }
}

// Section 12.1.5: an upgrade begins immediately, so the vendor's new billing
// date is simply one month from today - not derived from any existing
// period end (there is no proration to reconcile against for MVP).
function addOneMonth(date: Date): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + 1);
  return result;
}

export default function SubscriptionPage() {
  const { access } = useVendorAuth();
  // Section 4.1: a suspended vendor gets read-only portal access with
  // billing actions restricted. The chrome already banners this; the
  // backend now rejects these calls outright (requireBillingEligibleVendor)
  // - disabling the buttons here means a suspended vendor sees why an
  // action isn't available instead of getting a rejection after tapping it.
  const billingRestricted = access?.accessState === "read_only";
  const [statusRes, setStatusRes] = useState<GetSubscriptionStatusResponse | null>(null);
  const [offerings, setOfferings] = useState<GetOfferingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Section 12.1.5: the plan awaiting the pre-checkout upgrade disclosure.
  // Downgrades never populate this - they still go straight to handleCheckout,
  // unchanged (Section 12.2 downgrade flow is being reworked separately).
  const [pendingUpgrade, setPendingUpgrade] = useState<PlanOffering | null>(null);

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

  // Section 12.2: schedules the plan change for period-end - never touches
  // the provider or current access immediately (unlike handleCheckout,
  // which is upgrade-only and bills right away).
  async function handleDowngrade(plan: SubscriptionPlanId) {
    setActionBusy(plan);
    setError(null);
    try {
      await callable<{ plan: string }, { success: true }>("requestSubscriptionDowngrade")({ plan });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't schedule downgrade.");
    } finally {
      setActionBusy(null);
    }
  }

  async function handleCancelPendingDowngrade() {
    setActionBusy("cancel-downgrade");
    setError(null);
    try {
      await callable("cancelPendingDowngrade")({});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't cancel the pending downgrade.");
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
  } else if (reason === "payment_failed_initial") {
    // Section 4.5: distinct from the ongoing grace period, even though both
    // are backend status "past_due" — this is the first ~24h after the
    // charge failed.
    statusLabel = "Payment failed";
    statusTone = "danger";
  } else if (reason === "grace_period") {
    statusLabel = "Past due";
    statusTone = "danger";
  } else if (reason === "cancelled_before_period_end") {
    statusLabel = "Cancelled";
    statusTone = "neutral";
  } else if (reason === "cancelled") {
    // A provider- or admin-driven immediate cancellation, reported as its
    // own reason rather than falling into the same bucket as a genuine
    // scheduled-job expiry (Section 4.5's cancelled-vs-expired distinction).
    // Same "inactive plan, resubscribe" treatment as expired today, kept as
    // a separate branch so the two can diverge later without re-deriving
    // which backend status produced them.
    statusLabel = "Cancelled";
    statusTone = "neutral";
  } else if (reason === "expired") {
    statusLabel = "Expired";
    statusTone = "neutral";
  } else if (reason === "admin_override") {
    statusLabel = "Managed by Platform";
    statusTone = "info";
  }

  const price = subscription?.currentMonthlyPriceMinorUnits ?? offerings?.plans.find((p) => p.plan === effectivePlan)?.monthlyPriceMinorUnits;
  const currency = subscription?.currency ?? offerings?.currencyCode ?? null;

  const allPlansUnavailable = offerings ? offerings.plans.every((p) => !p.available) : false;
  const noPricingForCountry = offerings ? offerings.plans.every((p) => p.unavailableReason === "PRICING_NOT_CONFIGURED") : false;
  // Distinct from noPricingForCountry: pricing exists, but no provider route
  // is usable for this country/plan (Section 4.5 requires these two shown
  // with different copy, not the same generic fallback).
  const noProviderForCountry = offerings
    ? offerings.plans.every((p) => p.unavailableReason === "PAYMENT_PROVIDER_NOT_CONFIGURED")
    : false;
  const otherPlans = offerings ? offerings.plans.filter((p) => p.plan !== effectivePlan) : [];

  return (
    <div>
      <PageHeader title="Subscription" description="Manage your Platform plan, billing, and usage limits." />

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {/**
        * The card used to lead with a "Current plan" badge, then the plan name
        * as a heading, then "(free)" or the price — three pieces of UI saying
        * the same thing before any actual information appeared. The section
        * label carries "this is yours" now, so the card only has to state the
        * plan, its price and its status once.
        */}
      <p className="mt-section-y text-label-sm font-semibold uppercase tracking-wide text-ink-tertiary">Your plan</p>

      <div className="mt-2 rounded-card border border-hairline p-card-p">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p className="text-section-title text-ink">{displayName}</p>
            <StatusBadge label={statusLabel} tone={statusTone} />
          </div>
          <p className="text-body-base font-semibold text-ink-secondary">
            {typeof price === "number" ? (
              <>
                {formatPrice(price, currency)}
                <span className="font-normal text-ink-tertiary"> / month</span>
              </>
            ) : (
              "Free"
            )}
          </p>
        </div>

        <div className="mt-3 grid gap-1.5 text-body-sm sm:grid-cols-2">
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
          {reason === "payment_failed_initial" && subscription && (
            <p className="text-red-700 dark:text-red-400">
              Your payment didn't go through. Update payment details before <span className="font-medium">{formatDate(subscription.gracePeriodEnd)}</span> to keep this plan.
            </p>
          )}
          {reason === "grace_period" && subscription && (
            <p className="text-red-700 dark:text-red-400">
              There&apos;s an issue with your last payment. Update payment before{" "}
              <span className="font-medium">{formatDate(subscription.currentPeriodEnd)}</span> to keep this plan.
            </p>
          )}
          {(reason === "active" || reason === "trialing") && subscription?.pendingDowngradePlan && (
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
            Your plan is currently managed by Platform support. Self-service billing actions aren&apos;t available while this is active.
          </p>
        )}

        {/* Section 12.2: the downgrade's effective date has passed. There's
            no way to silently re-bill the vendor at the new plan's price
            (see requestSubscriptionDowngrade), so access already dropped to
            Basic and one checkout is needed to actually activate the target
            plan - this is the prompt for that, not a stuck/broken state. */}
        {reason === "expired" && subscription?.pendingDowngradePlan && (
          <div className="mt-4 rounded-input bg-surface-canvas px-3.5 py-3">
            <p className="text-body-sm text-ink-secondary">
              Your downgrade to{" "}
              <span className="font-medium text-ink">
                {PLAN_DISPLAY_FALLBACK[subscription.pendingDowngradePlan as SubscriptionPlanId] ?? subscription.pendingDowngradePlan}
              </span>{" "}
              is ready. Complete checkout to activate it.
            </p>
            <button
              type="button"
              disabled={actionBusy !== null || billingRestricted}
              onClick={() => handleCheckout(subscription.pendingDowngradePlan as PaidSubscriptionPlanId)}
              className="mt-3 rounded-button bg-brand px-4 py-2.5 text-button text-white transition-colors hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {actionBusy === subscription.pendingDowngradePlan ? "Starting…" : "Complete checkout"}
            </button>
          </div>
        )}

        <div className="mt-5 flex flex-wrap gap-3">
          {(reason === "active" || reason === "trialing") && !subscription?.cancelAtPeriodEnd && (
            <button
              type="button"
              disabled={actionBusy !== null}
              onClick={handleCancel}
              className="rounded-button border border-hairline-strong px-4 py-2.5 text-button text-ink transition-colors hover:border-red-400 hover:text-red-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500 active:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {actionBusy === "cancel" ? "Cancelling…" : "Cancel subscription"}
            </button>
          )}
          {(reason === "active" || reason === "trialing") && subscription?.cancelAtPeriodEnd && (
            <button
              type="button"
              disabled={actionBusy !== null}
              onClick={handleReactivate}
              className="rounded-button bg-brand px-4 py-2.5 text-button text-white transition-colors hover:bg-brand-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:bg-brand-darker disabled:cursor-not-allowed disabled:opacity-50"
            >
              {actionBusy === "reactivate" ? "Resuming…" : "Resume subscription"}
            </button>
          )}
          {(reason === "active" || reason === "trialing") && !subscription?.cancelAtPeriodEnd && subscription?.pendingDowngradePlan && (
            <button
              type="button"
              disabled={actionBusy !== null}
              onClick={handleCancelPendingDowngrade}
              className="rounded-button border border-hairline-strong px-4 py-2.5 text-button text-ink transition-colors hover:border-gray-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {actionBusy === "cancel-downgrade" ? "Cancelling…" : "Cancel pending downgrade"}
            </button>
          )}
          {/* Section 4.5: grace period requires the same retry/update-payment
              action as the initial payment-failed state — this was previously
              only rendered for payment_failed_initial, leaving grace_period
              with messaging but no action to take. */}
          {(reason === "payment_failed_initial" || reason === "grace_period") && subscription?.providerSubscriptionId && (
            <button
              type="button"
              disabled={actionBusy !== null || billingRestricted}
              onClick={() => window.location.reload()}
              className="rounded-button bg-brand px-4 py-2.5 text-button text-white transition-colors hover:bg-brand-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
              title="Go to your payment provider to retry the payment"
            >
              Update payment
            </button>
          )}
        </div>
      </div>

      {/* Plan limits — ceilings enforced by the backend today. Not a "used
          so far" progress bar: the backend doesn't currently track/return a
          per-vendor usage counter, only the plan's limit. */}
      {planLimits && (
        <div className="mt-section-y rounded-card border border-hairline p-card-p">
          <p className="text-card-title text-ink">What&apos;s included</p>
          {/**
            * grid-cols-2 from the smallest width up. This was one column on
            * mobile (sm:grid-cols-2 only kicks in at 640px), so four short
            * numbers became four full-width cards and consumed almost an
            * entire phone screen to say "7, 2, 0, 0".
            */}
          <div className="mt-3 grid grid-cols-2 gap-card-gap lg:grid-cols-4">
            {PLAN_LIMIT_ROWS.map((row) => {
              const value = (planLimits as Record<string, unknown>)[row.key];
              if (typeof value !== "number") return null;
              return (
                <div key={row.key} className="rounded-input bg-surface-canvas px-3.5 py-3">
                  <p className="text-metric-lg text-ink">{value}</p>
                  <p className="mt-0.5 text-label-sm text-ink-secondary">{row.label}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Available plans */}
      <div className="mt-section-y">
        {/**
          * When there is nothing to show, the heading "Available plans" sitting
          * above a grey box reads as a failed load. Suppressed in that case in
          * favour of an informational state that says what is actually true:
          * paid plans have not launched in this country yet, and the vendor is
          * fine on Basic in the meantime.
          */}
        {!allPlansUnavailable && <p className="text-card-title text-ink">Available plans</p>}
        {allPlansUnavailable ? (
          <EmptyState
            icon={Clock}
            tone="info"
            title={
              noPricingForCountry
                ? `Plans coming soon to ${access?.country ?? "your country"}`
                : "Plans temporarily unavailable"
            }
            /* Section 4.5's exact required copy for each internal cause, kept
               distinct even though "no provider route" and a generic load
               failure previously shared one fallback string. Internal terms
               ("provider mapping", "country pricing") never appear here. */
            description={
              noPricingForCountry
                ? "Subscriptions are not available in your country yet."
                : noProviderForCountry
                  ? "Subscriptions are temporarily unavailable. Please try again later."
                  : "We couldn't load plans just now. Please try again shortly."
            }
          />
        ) : (
          <div className="mt-3 grid gap-card-gap sm:grid-cols-2 lg:grid-cols-3">
            {otherPlans.map((plan) => {
              const isUpgrade = PLAN_TIER_RANK[plan.plan] > PLAN_TIER_RANK[effectivePlan];
              return (
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
                    disabled={!plan.available || actionBusy !== null || billingRestricted || Boolean(subscription?.pendingDowngradePlan)}
                    // Section 12.1.5: an upgrade must not reach handleCheckout
                    // (and therefore createSubscriptionCheckout) until the
                    // vendor has seen and confirmed the immediate-billing
                    // disclosure below. Downgrades schedule a period-end
                    // transition via requestSubscriptionDowngrade instead of
                    // billing immediately (Section 12.2) - they used to call
                    // handleCheckout directly, which re-billed the vendor for
                    // the lower plan right away instead of waiting.
                    onClick={() => (isUpgrade ? setPendingUpgrade(plan) : handleDowngrade(plan.plan))}
                    title={billingRestricted ? "Billing actions are unavailable while your account is suspended." : undefined}
                    className="mt-5 w-full rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-50"
                  >
                    {actionBusy === plan.plan
                      ? isUpgrade
                        ? "Starting…"
                        : "Scheduling…"
                      : plan.available
                      ? isUpgrade
                        ? "Upgrade"
                        : "Downgrade"
                      : "Unavailable"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Section 12.1.5: pre-checkout upgrade disclosure. No Modal/Dialog
          component exists elsewhere in this codebase to reuse, so this is a
          self-contained overlay built from the same design tokens (rounded-card,
          border-hairline, text-card-title, rounded-button, bg-brand, etc.) used
          throughout the rest of this page. */}
      {pendingUpgrade && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setPendingUpgrade(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="upgrade-confirm-title"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-card border border-hairline bg-white p-card-p shadow-xl dark:border-gray-800 dark:bg-gray-900"
          >
            <p id="upgrade-confirm-title" className="text-card-title text-ink">
              Confirm upgrade to {pendingUpgrade.displayName ?? PLAN_DISPLAY_FALLBACK[pendingUpgrade.plan]}
            </p>

            <div className="mt-3 space-y-1.5 text-body-sm text-ink-secondary">
              <p>
                New plan:{" "}
                <span className="font-medium text-ink">
                  {pendingUpgrade.displayName ?? PLAN_DISPLAY_FALLBACK[pendingUpgrade.plan]}
                </span>
              </p>
              <p>
                New monthly billing date:{" "}
                <span className="font-medium text-ink">{formatDate(addOneMonth(new Date()))}</span>
              </p>
            </div>

            <p className="mt-4 rounded-input bg-surface-canvas px-3.5 py-3 text-body-sm text-ink-secondary">
              Your {pendingUpgrade.displayName ?? PLAN_DISPLAY_FALLBACK[pendingUpgrade.plan]} plan will begin
              immediately and your new monthly billing date will be {formatDate(addOneMonth(new Date()))}. Unused
              time on your current plan is not refundable.
            </p>

            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setPendingUpgrade(null)}
                className="flex-1 rounded-button border border-hairline-strong px-4 py-2.5 text-button text-ink transition-colors hover:border-gray-400"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const plan = pendingUpgrade.plan;
                  setPendingUpgrade(null);
                  handleCheckout(plan);
                }}
                className="flex-1 rounded-button bg-brand px-4 py-2.5 text-button text-white transition-colors hover:bg-brand-dark"
              >
                Confirm and pay
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
