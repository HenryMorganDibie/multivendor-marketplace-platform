# Platform Subscription Pricing Data

**Status: canonical schema, implemented and wired into checkout, real numbers not yet entered.** This supersedes every earlier draft in this folder's history (see "History" at the bottom). The schema and Firestore wiring below are locked and live in `functions/src/subscriptions/`; what's still missing is actual per-country prices and provider plan IDs, which are business decisions this file deliberately does not guess at.

## What this is

Three things, kept in separate files and separate Firestore collections because they have different sensitivity and different owners:

- **`pricing.json`** → `subscriptionPricing/{countryCode}` (Firestore, public read): how much each paid plan costs per country, in that country's currency.
- **`providerPlanMapping.json`** → `providerPlanMapping/{countryCode}-{planId}` (Firestore, Admin SDK only, never client-readable): which Paystack/Flutterwave/Stripe plan or price ID to actually charge for a given country+plan combination.
- **`providerConfig.json`** → `subscriptionProviderConfig/{countryCode}` (Firestore, Admin SDK only, never client-readable): which provider(s) serve a country, in priority order.

**All three are required before a plan is purchasable in a country.** A country with a price and plan codes but no provider config is reported as `PAYMENT_PROVIDER_NOT_CONFIGURED` and shows as unavailable, because `selectProvider()` has no priority list to choose from. `providerConfig.json` was added late: the collection existed and checkout read it, but no import path wrote it, so this was a real trap: everything could look configured and still refuse to sell.

`basic` never appears in any of these files, it's free in every country and is never stored per-country.

## Schema: `providerConfig.json`

```typescript
interface SubscriptionProviderConfig {
  countryCode: string;                              // must exist in location-data/countries.json
  providerPriority: ("paystack"|"flutterwave"|"stripe")[];  // non-empty, no duplicates
  status: "active" | "inactive";                    // note: no "archived", unlike pricing
}
```

Document ID is the bare `{countryCode}` (e.g. `NG`). Order matters: checkout takes the **first** provider in the list that also has a usable `providerPlanMapping` entry for the requested plan, and never falls back to a provider outside the list. So `["paystack", "flutterwave"]` means "Paystack normally, Flutterwave only where Paystack has no plan code for that plan".

The same rules are enforced server-side by `validateProviderPriority()` in `functions/src/subscriptions/countryPricing.ts`, which is exported for exactly this purpose; `validate-pricing.js` mirrors them so bad data is caught before it reaches Firestore rather than at a vendor's checkout.

## Cross-file checks

`validate-pricing.js` also reports, as **warnings** rather than errors, configuration that imports cleanly but cannot sell:

- a country priced and `active` with no active `providerConfig`
- a country+plan where no provider in the priority list has a plan code
- a `providerConfig` or `providerPlanMapping` for a country with no pricing record

These are warnings deliberately: loading the three files in stages is a normal workflow, since prices are usually agreed long before a payment provider account exists. The import is not blocked, but nothing is left to be discovered through a failed checkout either.

## Schema: `pricing.json`

```typescript
interface SubscriptionPricingRecord {
  countryCode: string;        // must reference an existing location-data/countries.json entry
  currencyCode: string;       // ISO 4217, must match that country's currencyCode in countries.json
  plans: {
    standard: { monthlyPriceMinorUnits: number };
    pro: { monthlyPriceMinorUnits: number };
    pro_plus: { monthlyPriceMinorUnits: number };  // backend plan-tier naming: pro_plus,
                                                     // never proPlus, everywhere in this repo
  };
  status: "active" | "inactive" | "archived";
}
```

**Amounts are integer minor currency units, never decimals.** e.g. NGN 9,900.00 → `990000` (NGN has 2 minor-unit decimal places). This is **not** a flat "always multiply by 100" rule. Some currencies have 0 decimal places (JPY, KRW, and most of the CFA franc zone) and a few have 3 (BHD, KWD, OMR, and a handful of other Gulf-region currencies). The exact exponent per currency is looked up, not assumed: see `currencyMinorUnitExponent()` in `functions/src/subscriptions/countryPricing.ts` for the lookup table. Storing minor units instead of decimals/floats avoids an entire class of floating-point rounding bugs in billing-critical numbers.

`createdAt`/`updatedAt` are never included in the source JSON. `import-pricing.js` sets them automatically, same convention as `location-data/`.

## Schema: `providerPlanMapping.json`

```typescript
interface ProviderPlanMapping {
  countryCode: string;
  planId: "standard" | "pro" | "pro_plus";
  paystack?: { monthlyPlanCode: string };
  flutterwave?: { monthlyPlanId: string };
  stripe?: { monthlyPriceId: string };
}
```

Document ID is `{countryCode}-{planId}` (e.g. `NG-standard`, `CA-pro_plus`). All three provider fields are optional; a country only needs an entry for whichever provider(s) actually serve it. A checkout call for a provider with no entry for that country+plan fails with `failed-precondition`, not a silent fallback to some other provider's ID.

## How checkout actually uses this (all three providers, identically)

`createSubscriptionCheckout` / `createFlutterwaveCheckout` / `createStripeCheckout` all follow the same sequence (shared helper: `functions/src/subscriptions/countryPricing.ts`):

1. Read `vendors/{vendorId}.countryCode`, **not** a `businessLocation.countryCode` field, because that field doesn't exist anywhere in this codebase yet (it's a Section 8 concept from the location spec, explicitly documented there as future, per-vendor onboarding work, not built). Every existing function that needs a vendor's country (`createOrder.ts`, `sendChatMessage.ts`, `createCommerceConversation.ts`) already reads this same flat field.
2. Fetch `subscriptionPricing/{countryCode}`. **If it doesn't exist or isn't `active`, the checkout call hard-fails with `failed-precondition` + `error.details.errorCode: "PRICING_NOT_CONFIGURED"`.** There is no fallback to NGN pricing and no currency-conversion attempt from another country's price. A missing country price is a deliberate stop, not a default.
3. Fetch `providerPlanMapping/{countryCode}-{planId}` for that specific provider's identifier. Missing document, or document exists but that provider isn't configured for it: either way, `failed-precondition` + `errorCode: "PAYMENT_PROVIDER_NOT_CONFIGURED"`.
4. Monthly billing only for MVP. `billingInterval` is kept on the request shape for forward compatibility with an eventual yearly rollout, but is **strictly validated, not silently ignored**: omitted (defaults to monthly) or exactly `"monthly"` is accepted; anything else (`"yearly"` included) is rejected outright with `invalid-argument` via `requireMonthlyBillingInterval()`: the API fails clearly on an unsupported value rather than accepting it and quietly doing something else. (`VendorSubscriptionDoc.billingInterval` as a persisted field on an *active* subscription record still exists and is always written as `"monthly"` today; that's unrelated, unchanged, and left alone.)

Checking out for `plan: "basic"` is rejected outright (`invalid-argument`); there's nothing to check out for a free plan.

**`getCheckoutAvailability({ plan })`** is a fourth, read-only callable that runs the same pricing+mapping checks without attempting a real checkout, so the frontend can decide whether to render a working "Subscribe" button *before* the vendor ever taps it. An active `subscriptionPricing` record with zero configured providers is reported as unavailable, not available. Returns `{ available: boolean, availableProviders: (...), reason?: "PRICING_NOT_CONFIGURED" | "PAYMENT_PROVIDER_NOT_CONFIGURED" }`. See `docs/frontend-contracts.md` for the full shape.

## Safeguards: confirmed, and what's still manual

Five specific safeguards, addressed individually and honestly rather than blanket-confirmed:

1. **"Pricing active + provider mapping active, both required, or no working Subscribe button": done.** Checkout itself has always enforced both (pricing checked first, then the mapping). What was missing until now was a way for the *frontend* to know this in advance rather than discovering it from a failed checkout call. That's exactly what `getCheckoutAvailability` is for, added specifically in response to this requirement.
2. **Structured, machine-readable unavailable responses instead of message-string parsing: done.** `error.details.errorCode` is now `"PRICING_NOT_CONFIGURED"` or `"PAYMENT_PROVIDER_NOT_CONFIGURED"` on every relevant `failed-precondition`, alongside the existing human-readable message. Never a fallback to NGN pricing or currency conversion, in either case; this was already true and remains true.
3. **Verifying a provider's actual configured plan (currency + amount) matches the `pricing.json` record before production activation: not automated, and can't be yet.** This would require making a real, authenticated API call to Paystack/Flutterwave/Stripe to read back what each plan ID is actually configured to charge, which needs real provider credentials that don't exist in this repo (per the note below, those are being set up separately). Until that's possible, this has to be a **manual step in the go-live checklist**: whoever creates a provider plan ID and adds it to `providerPlanMapping.json` should manually re-open that plan in the provider's dashboard immediately before flipping a country's `pricing.json` `status` to `"active"` in production, and confirm the currency and amount shown there match the `pricing.json` entry exactly. If/when real provider API credentials exist, this can become an actual automated cross-check script (`verify-provider-pricing.js` or similar), worth building at that point, not guessed at now.
4. **Provider plan/product IDs never exposed via public documents: already true, confirmed.** `providerPlanMapping` has `allow read, write: if false` in `firestore.rules` (Admin SDK only), and neither `subscriptionPlans/{planId}` nor `subscriptionPricing/{countryCode}` (the two publicly-readable documents) contain any provider-specific field. This was true before this round of changes and nothing here altered it.
5. **Existing subscriptions vs. new subscriptions when a price changes: true by construction, now documented explicitly (previously implicit, not written down anywhere):** `vendorSubscriptions/{vendorId}` stores `providerSubscriptionId`, `providerPlanId`, `plan`, and `amountPaid` as captured at checkout/webhook-activation time. Nothing in this codebase re-reads `subscriptionPricing` or `providerPlanMapping` after that point. Renewals are driven by each provider's own recurring-billing engine acting on the *provider-side* plan the vendor was originally subscribed to, not by this codebase re-checking Firestore pricing on every renewal. So: **editing `pricing.json` or `providerPlanMapping.json` and re-importing only affects future `createXCheckout` calls (new subscriptions).** Existing subscribers keep renewing at whatever price their original provider-side plan is configured for, until an explicit migration moves them.
   **One operational rule this depends on, and that this codebase cannot enforce**: a price change must always be done by creating a **new** provider-side plan (new plan ID) and pointing `providerPlanMapping.json` at it, never by editing the price on an *existing* provider-side plan ID in the provider's dashboard. If an existing plan's price is mutated in place on the provider's side, every subscriber already on that plan ID is repriced immediately by the provider's own billing engine, silently, regardless of anything in this repo. This is a process/discipline rule for whoever manages the provider dashboards, not something Firestore rules or this codebase can technically prevent.

I understand the Paystack/Flutterwave/Stripe accounts and plan/product IDs will be owned and configured directly. `providerPlanMapping.json` entries just need real plan IDs dropped in once those exist; nothing else in this repo needs to change for that.

## How to add a country's price

Add one object per country to the array in `pricing.json`, not a new file, just a new entry in this one file. `countryCode` must match a country already in `location-data/countries.json`, and `currencyCode` must match that country's `currencyCode` exactly (validation will reject it otherwise).

**Copy-paste template:**
```json
{
  "countryCode": "XX",
  "currencyCode": "XXX",
  "plans": {
    "standard": { "monthlyPriceMinorUnits": 0 },
    "pro": { "monthlyPriceMinorUnits": 0 },
    "pro_plus": { "monthlyPriceMinorUnits": 0 }
  },
  "status": "active"
}
```

**Worked example: Nigeria (NGN, 2 decimal places, the normal case):** ₦9,900.00/month for Standard → multiply by 100 → `990000`.
```json
{
  "countryCode": "NG",
  "currencyCode": "NGN",
  "plans": {
    "standard": { "monthlyPriceMinorUnits": 990000 },
    "pro": { "monthlyPriceMinorUnits": 2500000 },
    "pro_plus": { "monthlyPriceMinorUnits": 4000000 }
  },
  "status": "active"
}
```

**Watch out for currencies that don't use 2 decimal places** (most do, but not all):
- **0 decimal places** (whole-number currency, don't multiply by 100 at all): JPY, KRW, VND, and most CFA franc currencies (XAF/XOF). ¥1,500/month → `1500`, not `150000`.
- **3 decimal places** (multiply by 1,000, not 100): BHD, KWD, OMR, and a few other Gulf-region currencies. 9.900 KWD/month → `9900`.
- Everything else: 2 decimal places, multiply by 100, same as the Nigeria example.

If unsure which bucket a currency falls into, check `currencyMinorUnitExponent()` in `functions/src/subscriptions/countryPricing.ts`. That's the exact list the validator checks against, so getting it wrong there will be caught immediately by `validate:pricing` rather than silently overcharging or undercharging a country by 100x.

**`plans.basic` should never be added**: Basic is free everywhere and isn't part of this schema. `validate:pricing` will flag it as an error if present.

After adding entries, always run `npm run validate:pricing` before committing (see below); it catches wrong currency codes, non-integer amounts, missing plans, and the minor-unit mistake above before anything reaches Firestore.

**Note:** entering a country’s price here alone doesn’t make real checkout work for that country yet. Two further entries are needed:

- `providerPlanMapping.json`, with real Paystack/Flutterwave/Stripe plan IDs, these must be created in each provider’s dashboard *first*, then their codes pasted here.
- `providerConfig.json`, naming which provider serves the country.

Both require provider account access, so they’re likely not the Founder’s to do. All three files can be filled independently and don’t need to land at the same time. `validate-pricing.js` warns about the incomplete combination rather than blocking the import.

One thing to avoid while staging: don’t add a *placeholder* provider plan code just to silence that warning. It makes plans render as purchasable and then fail at the provider when a vendor taps Subscribe, which is worse than showing “coming soon” honestly.

To confirm a country actually went live, call `getVendorSubscriptionOfferings` as a vendor in that country: every plan should come back `available: true`.

## `provider-by-country.csv`: the country-launch worksheet

This is a separate, human-facing worksheet (not imported into Firestore, not
validated by `validate-pricing.js`), built for deciding which countries to
launch and with which provider. It's an input to filling in `pricing.json`
etc., not a replacement for them.

As of 2026-08-09 it has two extra columns beyond the original
Stripe/Paystack/Flutterwave suggestion: **Apple App Store (subs)** and
**Google Play (subs)**, Y/N per country. These come from Apple's own "App
Store pricing and availability start times by country or region" page and
Google's own "Developer and merchant registration" table (merchant column
specifically, not the broader developer-registration column), fetched
directly on that date, not guessed. Same caveat as the original
Stripe/Paystack/Flutterwave column: transcribed from a real source, but
worth a spot check against the live pages before treating any single row as
final, especially since these lists do shift over time.

**Why this matters for the launch decision the Founder is making**: of the 113
countries with no confirmed web payment provider, 101 are reachable through
Apple and/or Google IAP once that's built (see
[apple-google-subscription-plan.md](../docs/apple-google-subscription-plan.md)).
Only 12 have no path through any provider or store at all right now:
Andorra, Comoros, Djibouti, Vatican City, Monaco, Samoa, San Marino, South
Sudan, Sudan, Syria, Timor-Leste, Tuvalu, several of which (Syria, Sudan,
South Sudan) are likely to stay excluded on compliance grounds regardless,
similar to the Cuba/Iran/North Korea exclusion already in
`countryAvailability`.

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

**Both seed files are intentionally empty (`[]`) right now.** Three different sets of numbers were floated for this data across earlier drafts (₦5,000 / ₦9,000 / ₦9,900 for Nigeria Standard alone, from three different sources, see History below) and none of them was ever confirmed as correct. Rather than picking one, this implementation locks the *schema* and leaves the *numbers* for whoever actually owns pricing to enter deliberately. **Real per-country prices and real provider plan/price IDs (from each provider's dashboard) both still need to be added before checkout can work for any real (non-emulator) vendor, in any country.** The acceptance test suite seeds its own throwaway placeholder numbers directly in test setup for this exact reason. Those are not real prices and were never meant to be copied into this folder.

## History (why this replaced two earlier drafts)

1. First draft: `subscriptionPricing.json`, one flat array, `{ regular, founder }` per tier, `proPlus` camelCase, keyed loosely, reverse-engineered from the frontend's `vendorPricing.ts` (Nigeria Standard ₦9,000/month) since no spec existed at all at that point.
2. A second, independently-proposed shape surfaced later: flat `monthlyPrice` per tier, no founder split, still `proPlus` camelCase (Nigeria Standard ₦9,900/month), never applied to the file, just flagged as a third disagreeing number alongside the backend's own placeholder (₦5,000/month, in `planLimitsSeedData.ts`, explicitly marked "must be confirmed").
3. This version is the actual architecture decision: minor-unit integers (not decimals), no founder pricing (dropped, not carried forward; if founder/early-adopter pricing is still wanted, that's a new, separate decision to make and design for), `pro_plus` snake_case everywhere (matching the backend's real `SubscriptionPlanId`), split into pricing vs. provider-mapping with different Firestore visibility, and wired into all three checkout callables with a hard-fail-on-missing-country rule. The old `subscriptionPricing.json` was deleted rather than kept alongside this as a fourth disagreeing source.
