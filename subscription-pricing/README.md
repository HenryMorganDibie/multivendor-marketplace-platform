# the platform Subscription Pricing Data

**Status: scaffolding, not yet a canonical spec.** Unlike `location-data/` (governed by `THE PLATFORM LOCATION SPEC v1.5.md`), there is currently no approved pricing spec anywhere in either repo. This file was reverse-engineered from the frontend's existing pricing table (`rork-the platform/expo/constants/vendorPricing.ts`) so the client has a place to start adding/correcting prices — but the schema below should be treated as a draft until someone signs off on it the way the location spec was signed off on.

## What this is

Per-country subscription pricing: a currency, a "pricing band" (A–D, cheapest to most expensive), and a price for each plan tier, with a `regular` and discounted `founder` (early-adopter) price for every paid tier.

## Schema

```typescript
interface CountryPricingRecord {
  countryCode: string;        // ISO 3166-1 alpha-2, uppercase — must match an existing
                               // location-data/countries.json entry. Not the document ID
                               // here (this is one flat array, not per-country files) but
                               // still the join key back to the location catalogue.
  band: "A" | "B" | "C" | "D"; // pricing tier band — lower-cost markets are "A", highest-cost "D"
  currencyCode: string;        // ISO 4217, e.g. "NGN"
  currencySymbol: string;      // e.g. "₦"
  basic: number;               // Basic is free in every market seen so far — always 0
  standard: { regular: number; founder: number };
  pro: { regular: number; founder: number };
  pro_plus: { regular: number; founder: number };  // backend plan-tier naming (pro_plus, not
                                                     // proPlus) — see note below
}
```

All 11 countries currently in the file were copied directly from the frontend's `COUNTRY_PRICING` object, with two changes:
- Keyed by `countryCode` (`"NG"`) instead of country name (`"Nigeria"`), to match `location-data`'s convention and avoid string-matching country names.
- Plan tier key renamed `proPlus` → `pro_plus`, to match the backend's actual `SubscriptionPlanId` values (`basic` | `standard` | `pro` | `pro_plus`) rather than the frontend's internal camelCase.

## Open questions — not resolved by this scaffold

1. **These numbers don't match the backend's existing placeholder prices.** `functions/src/subscriptions/planLimitsSeedData.ts` → `DEFAULT_PLAN_DISPLAY` has its own flat, NGN-only, non-founder prices (e.g. Standard = ₦5,000/month) that don't agree with this file's Nigeria entry (Standard regular = ₦9,000). That file is explicitly commented as "PLACEHOLDER figures... must be confirmed" — so this isn't a new problem, but it means **two different sources of Nigeria pricing exist in the codebase right now**, and one of them needs to become the source of truth before either is wired up for real.
2. **No monthly/yearly split.** The frontend's numbers appear to be a single price per tier with no indication of billing interval, while the backend already supports monthly/yearly billing (`monthlyPriceNGN`/`yearlyPriceNGN`, `billingInterval` on checkout). This file doesn't yet have that dimension — needs a decision on whether every country needs monthly+yearly figures or whether yearly is a discount formula applied uniformly.
3. **No founder-pricing cap/expiry data.** The frontend has `FOUNDER_PRICING_CAP_PER_COUNTRY = 300` (a flat number of founder slots per country) but nothing about when founder pricing starts/ends or how remaining slots are tracked. Not represented here yet.
4. **No `validate:pricing` / `import:pricing` scripts exist.** Same situation `location-data/` was in before those scripts were built — this is data-entry scaffolding only. Don't build automation against this shape until the open questions above are actually answered; the schema may still change.

## Adding a country

Add a new object to the array in `subscriptionPricing.json` following the schema above. `countryCode` should reference a country that already exists in `location-data/countries.json` (there's no automated check for this yet, but it's the intent).
