# the platform Subscription Pricing Data

**Status: scaffolding, not yet a canonical spec — and there are now competing draft numbers, not just a missing spec.** Unlike `location-data/` (governed by `THE PLATFORM LOCATION SPEC v1.5.md`), there is currently no approved pricing spec anywhere in either repo. This file was reverse-engineered from the frontend's existing pricing table (`rork-the platform/expo/constants/vendorPricing.ts`) so the client has a place to start adding/correcting prices. Since then, a second, differently-shaped pricing proposal has also been floated (see "Open questions" below) with yet another set of numbers. **Nothing in this folder should be treated as final until someone explicitly picks one schema and one set of numbers as canonical.**

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

1. **There are now THREE disagreeing sources for Nigeria Standard pricing, not two:**

   | Source | Nigeria Standard/month |
   |---|---|
   | `functions/src/subscriptions/planLimitsSeedData.ts` → `DEFAULT_PLAN_DISPLAY` (backend, explicitly commented "PLACEHOLDER... must be confirmed") | ₦5,000 |
   | `subscription-pricing/subscriptionPricing.json` (this file, current schema below, copied from the frontend's `vendorPricing.ts`) | ₦9,000 |
   | A separate proposal shared 2026-07-14 (flat `monthlyPrice` per tier, no founder split, `proPlus` camelCase key, Nigeria Standard = ₦9,900) — **not yet applied to this file** | ₦9,900 |

   None of these has been declared canonical. **Do not wire real checkout/billing logic to any of them until one is picked and the other two are deleted.**

2. **The 2026-07-14 proposal uses a different shape than what's currently in `subscriptionPricing.json`** — flat `plans.{tier}.monthlyPrice` instead of `{tier}: { regular, founder }`, no `band`, no `currencySymbol`, no `basic` entry, and `proPlus` (frontend camelCase) instead of `pro_plus` (the backend's actual `SubscriptionPlanId` value — see the naming note in the Schema section above). It also drops founder pricing entirely, which may be intentional (feature cut) or just an early draft — unconfirmed either way. **The file has not been changed to match this proposal** pending a decision on which schema and which numbers are correct.
3. **No monthly/yearly split** in the current file — the frontend's numbers are a single price per tier with no billing-interval dimension, while the backend already supports monthly/yearly billing (`monthlyPriceNGN`/`yearlyPriceNGN`, `billingInterval` on checkout). The 2026-07-14 proposal calls its field `monthlyPrice` explicitly, which at least answers "is this monthly" for that draft, but yearly pricing is still undefined everywhere.
4. **No founder-pricing cap/expiry data.** The frontend has `FOUNDER_PRICING_CAP_PER_COUNTRY = 300` (a flat number of founder slots per country) but nothing about when founder pricing starts/ends or how remaining slots are tracked. Not represented here, and the 2026-07-14 proposal drops founder pricing as a concept entirely — needs a decision.
5. **No `validate:pricing` / `import:pricing` scripts exist.** Same situation `location-data/` was in before those scripts were built — this is data-entry scaffolding only. Don't build automation against this shape until the open questions above are actually answered; the schema may still change.

## Adding a country

Add a new object to the array in `subscriptionPricing.json` following the schema above. `countryCode` should reference a country that already exists in `location-data/countries.json` (there's no automated check for this yet, but it's the intent). Currently 11 countries: NG, GH, KE, EG, ZA, MA, TR, GB, CA, AU, US.
