"use client";

import { useEffect, useState } from "react";
import { callable } from "@/lib/firebase";
import { GetOfferingsResponse, PaidSubscriptionPlanId } from "@/lib/types";
import { PRICING_COUNTRIES, suggestCountryFromLocale } from "./countries";

const STORAGE_KEY = "the platform:pricing:countryCode";

// "Pro Plus" (with a space) must never appear in the UI (Section 1.1) —
// pro_plus displays as "Pro+" exclusively.
const PLAN_DISPLAY_NAME: Record<PaidSubscriptionPlanId, string> = {
  standard: "Standard",
  pro: "Pro",
  pro_plus: "Pro+",
};

// Entitlement copy is code-owned here rather than a second Firestore read
// against subscriptionPlans — getPublicSubscriptionOfferings intentionally
// returns only price + availability (Section 1.1), not feature lists.
const PLAN_FEATURES: Record<PaidSubscriptionPlanId, string[]> = {
  standard: ["Unlimited catalog items", "Direct customer chat", "Invoicing with PDF download"],
  pro: ["Everything in Standard", "Priority placement in search", "Pickup auto-send messaging"],
  pro_plus: ["Everything in Pro", "Highest search priority", "Priority support"],
};

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

  return (
    <div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Pricing</h1>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-gray-600 dark:text-gray-400">Country</span>
          <select
            value={countryCode ?? ""}
            onChange={(e) => handleCountryChange(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
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
        <p className="mt-8 rounded-2xl border border-gray-200 bg-gray-50 p-6 text-sm text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
          Select your country above to see pricing.
        </p>
      )}

      {loading && (
        <p aria-live="polite" className="mt-8 text-sm text-gray-500">
          Loading pricing…
        </p>
      )}

      {error && (
        <p role="alert" className="mt-8 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {offerings && allUnavailable && (
        <p className="mt-8 rounded-2xl border border-gray-200 bg-gray-50 p-6 text-sm text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
          Paid plans are not available in this country yet.
        </p>
      )}

      {offerings && !allUnavailable && (
        <div className="mt-10 grid gap-6 sm:grid-cols-3">
          {offerings.plans.map((plan) => (
            <div key={plan.plan} className="flex flex-col rounded-2xl border border-gray-100 p-6 dark:border-gray-800">
              <h2 className="text-lg font-semibold">{PLAN_DISPLAY_NAME[plan.plan]}</h2>
              <p className="mt-2 text-2xl font-bold">
                {plan.available ? formatPrice(plan.monthlyPriceMinorUnits, offerings.currencyCode) : "—"}
                {plan.available && plan.monthlyPriceMinorUnits > 0 ? (
                  <span className="text-sm font-normal text-gray-500">/mo</span>
                ) : null}
              </p>
              <ul className="mt-4 flex-1 space-y-2 text-sm text-gray-600 dark:text-gray-400">
                {PLAN_FEATURES[plan.plan].map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              {plan.available ? (
                <a
                  href="/vendors"
                  className="mt-6 rounded-full bg-brand px-4 py-2 text-center text-sm font-semibold text-white hover:bg-brand-dark"
                >
                  Become a Vendor
                </a>
              ) : (
                <p className="mt-6 text-center text-xs text-gray-500">Temporarily unavailable</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
