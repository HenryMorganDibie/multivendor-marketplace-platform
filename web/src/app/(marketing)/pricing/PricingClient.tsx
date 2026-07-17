"use client";

import { useEffect, useState } from "react";
import { callable } from "@/lib/firebase";
import { GetOfferingsResponse, PaidSubscriptionPlanId } from "@/lib/types";
import { PRICING_COUNTRIES, suggestCountryFromLocale } from "./countries";
import WaitlistForm from "./WaitlistForm";

const STORAGE_KEY = "the platform:pricing:countryCode";

// "Pro Plus" (with a space) must never appear in the UI (Section 1.1) —
// pro_plus displays as "Pro+" exclusively.
const PLAN_DISPLAY_NAME: Record<PaidSubscriptionPlanId, string> = {
  standard: "Standard",
  pro: "Pro",
  pro_plus: "Pro+",
};

// Mirrors functions/src/subscriptions/planLimitsSeedData.ts's
// DEFAULT_PLAN_DISPLAY exactly — real seeded limits, not invented copy.
// Kept in sync manually; update both if the plan-gating matrix changes.
const PLAN_FEATURES: Record<PaidSubscriptionPlanId, string[]> = {
  standard: ["30 catalog items", "External orders", "Best seller & revenue widgets", "25 invoices/month"],
  pro: ["100 catalog items", "Auto-send pickup details", "Advanced analytics", "Invoice branding", "100 invoices/month"],
  pro_plus: ["250 catalog items", "Auto-accept orders", "Premium invoice templates", "200 invoices/month"],
};

const FREE_PLAN_FEATURES = ["10 catalog items", "2 photos per item", "3 invoices/month"];

const PRICING_FAQ = [
  {
    q: "How does billing work?",
    a: "Paid plans bill monthly, in your country's local currency, through the payment method available where you're registered.",
  },
  {
    q: "How do upgrades work?",
    a: "Upgrades take effect immediately after payment, at the plan's current published price.",
  },
  {
    q: "How do downgrades work?",
    a: "Downgrades take effect at the end of your current billing period — you keep your current plan's features until then.",
  },
  {
    q: "Can I cancel anytime?",
    a: "Yes. Cancelling keeps your plan active until the end of the period you've already paid for, with no further charges after that.",
  },
  {
    q: "What payment methods are supported?",
    a: "the platform supports the payment methods available in your country, selected automatically — you never have to choose a provider.",
  },
];

function formatPrice(minorUnits: number, currencyCode: string | null): string {
  if (!currencyCode) return "—";
  if (minorUnits === 0) return "Free";
  const amount = minorUnits / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currencyCode }).format(amount);
  } catch {
    return `${currencyCode} ${amount.toFixed(2)}`;
  }
}

export default function PricingClient() {
  const [countryCode, setCountryCode] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [offerings, setOfferings] = useState<GetOfferingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stored = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    setCountryCode(stored ?? suggestCountryFromLocale());
    setInitialized(true);
  }, []);

  useEffect(() => {
    if (!initialized || !countryCode) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    const getOfferings = callable<{ countryCode: string }, GetOfferingsResponse>("getPublicSubscriptionOfferings");
    getOfferings({ countryCode })
      .then((res) => {
        if (!cancelled) setOfferings(res.data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load pricing.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [initialized, countryCode]);

  function handleCountryChange(next: string) {
    setCountryCode(next);
    setOfferings(null);
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, next);
  }

  const allUnavailable = offerings ? offerings.plans.every((p) => !p.available) : false;
  const selectedCountryLabel = PRICING_COUNTRIES.find((c) => c.countryCode === countryCode)?.label ?? "your country";

  return (
    <div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-3xl font-extrabold tracking-[-0.02em] text-ink sm:text-4xl">Pricing</h1>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-ink-secondary">Country</span>
          <select
            value={countryCode ?? ""}
            onChange={(e) => handleCountryChange(e.target.value)}
            className="rounded-input border border-transparent bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:bg-white"
          >
            <option value="" disabled>
              Select a country
            </option>
            {PRICING_COUNTRIES.map((c) => (
              <option key={c.countryCode} value={c.countryCode}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!countryCode && initialized && (
        <p className="mt-6 rounded-card border border-hairline bg-surface-canvas p-6 text-sm text-ink-secondary">
          Select your country above to see pricing.
        </p>
      )}

      {loading && (
        <p aria-live="polite" className="mt-6 text-sm text-ink-tertiary">
          Loading pricing…
        </p>
      )}

      {error && (
        <p role="alert" className="mt-6 text-sm text-red-600">
          {error}
        </p>
      )}

      {offerings && allUnavailable && (
        <div className="mt-6 rounded-card border border-hairline bg-surface-canvas p-6">
          <p className="text-sm text-ink-secondary">Paid plans are not available in {selectedCountryLabel} yet.</p>
          <WaitlistForm countryCode={countryCode ?? ""} countryLabel={selectedCountryLabel} />
        </div>
      )}

      {offerings && !allUnavailable && (
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col rounded-card border border-hairline p-6 shadow-soft">
            <h2 className="text-lg font-bold tracking-[-0.01em] text-ink">Free</h2>
            <p className="mt-2 text-2xl font-extrabold tracking-[-0.01em] text-ink">Free</p>
            <ul className="mt-4 flex-1 space-y-2 text-sm text-ink-secondary">
              {FREE_PLAN_FEATURES.map((feature) => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
            <a
              href="/vendors"
              className="mt-6 rounded-button border border-hairline-strong px-4 py-2 text-center text-sm font-semibold text-ink transition hover:border-brand hover:text-brand"
            >
              Become a Vendor
            </a>
          </div>
          {offerings.plans.map((plan) => (
            <div key={plan.plan} className="flex flex-col rounded-card border border-hairline p-6 shadow-soft">
              <h2 className="text-lg font-bold tracking-[-0.01em] text-ink">{PLAN_DISPLAY_NAME[plan.plan]}</h2>
              <p className="mt-2 text-2xl font-extrabold tracking-[-0.01em] text-ink">
                {plan.available ? formatPrice(plan.monthlyPriceMinorUnits, offerings.currencyCode) : "—"}
                {plan.available && plan.monthlyPriceMinorUnits > 0 ? (
                  <span className="text-sm font-normal text-ink-tertiary">/mo</span>
                ) : null}
              </p>
              <ul className="mt-4 flex-1 space-y-2 text-sm text-ink-secondary">
                {PLAN_FEATURES[plan.plan].map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              {plan.available ? (
                <a
                  href="/vendors"
                  className="mt-6 rounded-button bg-brand px-4 py-2 text-center text-sm font-semibold text-white shadow-soft transition hover:bg-brand-dark"
                >
                  Upgrade
                </a>
              ) : (
                <p className="mt-6 text-center text-xs text-ink-tertiary">Temporarily unavailable</p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-16 border-t border-hairline pt-10">
        <h2 className="text-xl font-bold tracking-[-0.015em] text-ink">Pricing FAQ</h2>
        <div className="mt-4 space-y-5">
          {PRICING_FAQ.map((item) => (
            <div key={item.q}>
              <p className="font-semibold text-ink">{item.q}</p>
              <p className="mt-1 text-sm text-ink-secondary">{item.a}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
