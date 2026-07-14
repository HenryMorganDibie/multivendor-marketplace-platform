# the platform Subscription Pricing Data

**Status: canonical schema, implemented and wired into checkout — real numbers not yet entered.** This supersedes every earlier draft in this folder's history (see "History" at the bottom). The schema and Firestore wiring below are locked and live in `functions/src/subscriptions/`; what's still missing is actual per-country prices and provider plan IDs, which are business decisions this file deliberately does not guess at.

## What this is

Two things, kept in two separate files and two separate Firestore collections because they have different sensitivity and different owners:

- **`pricing.json`** → `subscriptionPricing/{countryCode}` (Firestore, public read) — how much each paid plan costs per country, in that country's currency.
- **`providerPlanMapping.json`** → `providerPlanMapping/{countryCode}-{planId}` (Firestore, Admin SDK only, never client-readable) — which Paystack/Flutterwave/Stripe plan or price ID to actually charge for a given country+plan combination.

`basic` never appears in either file — it's free in every country and is never stored per-country.

## Schema — `pricing.json`

```typescript
interface SubscriptionPricingRecord {
  countryCode: string;        // must reference an existing location-data/countries.json entry
  currencyCode: string;       // ISO 4217, must match that country's currencyCode in countries.json
  plans: {
    standard: { monthlyPriceMinorUnits: number };
    pro: { monthlyPriceMinorUnits: number };
    pro_plus: { monthlyPriceMinorUnits: number };  // backend plan-tier naming — pro_plus,
                                                     // never proPlus, everywhere in this repo
  };
  status: "active" | "inactive" | "archived";
}
```

**Amounts are integer minor currency units, never decimals.** e.g. NGN 9,900.00 → `990000` (NGN has 2 minor-unit decimal places). This is **not** a flat "always multiply by 100" rule — some currencies have 0 decimal places (JPY, KRW, and most of the CFA franc zone) and a few have 3 (BHD, KWD, OMR, and a handful of other Gulf-region currencies). The exact exponent per currency is looked up, not assumed — see `currencyMinorUnitExponent()` in `functions/src/subscriptions/countryPricing.ts` for the lookup table. Storing minor units instead of decimals/floats avoids an entire class of floating-point rounding bugs in billing-critical numbers.

`createdAt`/`updatedAt` are never included in the source JSON — `import-pricing.js` sets them automatically, same convention as `location-data/`.

## Schema — `providerPlanMapping.json`

```typescript
interface ProviderPlanMapping {
  countryCode: string;
  planId: "standard" | "pro" | "pro_plus";
  paystack?: { monthlyPlanCode: string };
  flutterwave?: { monthlyPlanId: string };
  stripe?: { monthlyPriceId: string };
}
```

Document ID is `{countryCode}-{planId}` (e.g. `NG-standard`, `CA-pro_plus`). All three provider fields are optional — a country only needs an entry for whichever provider(s) actually serve it. A checkout call for a provider with no entry for that country+plan fails with `failed-precondition`, not a silent fallback to some other provider's ID.

## How checkout actually uses this (all three providers, identically)

`createSubscriptionCheckout` / `createFlutterwaveCheckout` / `createStripeCheckout` all follow the same sequence (shared helper: `functions/src/subscriptions/countryPricing.ts`):

1. Read `vendors/{vendorId}.countryCode` — **not** a `businessLocation.countryCode` field, because that field doesn't exist anywhere in this codebase yet (it's a Section 8 concept from the location spec, explicitly documented there as future, per-vendor onboarding work, not built). Every existing function that needs a vendor's country (`createOrder.ts`, `sendChatMessage.ts`, `createCommerceConversation.ts`) already reads this same flat field.
2. Fetch `subscriptionPricing/{countryCode}`. **If it doesn't exist or isn't `active`, the checkout call hard-fails with `failed-precondition`.** There is no fallback to NGN pricing and no currency-conversion attempt from another country's price — a missing country price is a deliberate stop, not a default.
3. Fetch `providerPlanMapping/{countryCode}-{planId}` for that specific provider's identifier. Missing document → `not-found`; document exists but that provider isn't configured for it → `failed-precondition`.
4. Monthly billing only for MVP. `billingInterval` is still accepted on the request for backward compatibility but is ignored — no yearly checkout path exists anywhere in this rollout. (`VendorSubscriptionDoc.billingInterval` as a persisted field on an *active* subscription record still exists and is always written as `"monthly"` today — that's unrelated, unchanged, and left alone.)

Checking out for `plan: "basic"` is rejected outright (`invalid-argument`) — there's nothing to check out for a free plan.

## Validating and importing

Same pattern as `location-data/`, in `scripts/`:

```bash
cd scripts
npm run validate:pricing   # read-only, checks both files against location-data/countries.json, never touches Firestore
npm run import:pricing     # validates first, then upserts subscriptionPricing + providerPlanMapping
```

`import:pricing` defaults to the local Firestore emulator; `--live --project <id>` for a real project. Rerun-safe: `createdAt` preserved, `updatedAt` only touched on a real change, nothing ever deleted (orphaned records are flagged in the summary, not removed).

Validation enforces: `countryCode` references an existing `location-data/countries.json` record, `currencyCode` matches that country's `currencyCode` exactly, all three paid plans present with a positive integer `monthlyPriceMinorUnits`, valid `status`, and (for the mapping file) at least one provider present per record with correctly-shaped sub-objects.

## What's genuinely still missing

**Both seed files are intentionally empty (`[]`) right now.** Three different sets of numbers were floated for this data across earlier drafts (₦5,000 / ₦9,000 / ₦9,900 for Nigeria Standard alone, from three different sources — see History below) and none of them was ever confirmed as correct. Rather than picking one, this implementation locks the *schema* and leaves the *numbers* for whoever actually owns pricing to enter deliberately. **Real per-country prices and real provider plan/price IDs (from each provider's dashboard) both still need to be added before checkout can work for any real (non-emulator) vendor, in any country.** The acceptance test suite seeds its own throwaway placeholder numbers directly in test setup for this exact reason — those are not real prices and were never meant to be copied into this folder.

## History (why this replaced two earlier drafts)

1. First draft: `subscriptionPricing.json`, one flat array, `{ regular, founder }` per tier, `proPlus` camelCase, keyed loosely — reverse-engineered from the frontend's `vendorPricing.ts` (Nigeria Standard ₦9,000/month) since no spec existed at all at that point.
2. A second, independently-proposed shape surfaced later — flat `monthlyPrice` per tier, no founder split, still `proPlus` camelCase (Nigeria Standard ₦9,900/month) — never applied to the file, just flagged as a third disagreeing number alongside the backend's own placeholder (₦5,000/month, in `planLimitsSeedData.ts`, explicitly marked "must be confirmed").
3. This version is the actual architecture decision: minor-unit integers (not decimals), no founder pricing (dropped, not carried forward — if founder/early-adopter pricing is still wanted, that's a new, separate decision to make and design for), `pro_plus` snake_case everywhere (matching the backend's real `SubscriptionPlanId`), split into pricing vs. provider-mapping with different Firestore visibility, and wired into all three checkout callables with a hard-fail-on-missing-country rule. The old `subscriptionPricing.json` was deleted rather than kept alongside this as a fourth disagreeing source.
