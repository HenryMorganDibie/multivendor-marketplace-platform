# the platform — Subscription Alignment: Findings, Decisions & Status Correction

**Status:** Architectural decisions locked by the client (2026-07-15), reconciled against `LANDING_PAGE_CMS_VENDOR_PORTAL_MAPPING.md` (v5). Approved in principle, pending final adjustments below. Provider-priority config corrected to a private collection (Section 4.1) — never the public `subscriptionPricing` document. Pricing offerings split into an authenticated and a public callable (Section 5). Cost/scope resolved with a fixed boundary (Section 11). v5 must be corrected **before** Section 7 coding begins (Section 10). Backend prerequisite work (Section 7) must ship before the Rork frontend brief (Section 9) goes out.
**Repos reviewed:** `the platform-backend` (Firebase Functions/Firestore), `rork-the platform` (Expo frontend)

---

## 0. Correction to v5 — read this first

v5, Section 4, states: *"Payment provider neutrality: confirmed as already architecturally resolved... `createSubscriptionCheckout` is one generic callable. The frontend sends only `{ planId }`; the backend reads the vendor's `businessLocation.countryCode`, resolves the correct provider and provider-specific plan code server-side."*

v5, Section 10 (Dependencies table), lists Vendor Portal subscription/payment flow as **"✅ Already exists and tested."**

**Neither statement matches the current backend code**, verified directly against `the platform-backend/functions/src/subscriptions/`:

- `createSubscriptionCheckout` is **hardcoded to Paystack** (`requireProviderPlanMapping(countryCode, planId, "paystack")` is a literal string, not a resolved choice).
- Two more **public, separately-exported** callables exist — `createFlutterwaveCheckout`, `createStripeCheckout` — not internal helpers behind a single entry point.
- The country field actually read is the flat `vendors/{vendorId}.countryCode`. `businessLocation.countryCode` does not exist anywhere in the codebase yet — the backend's own documentation calls it out explicitly as unbuilt, future work.
- The request parameter used throughout (checkout functions, webhook handlers, `subscriptionEvents`, `resolveEffectivePlan`) is `plan`, not `planId`.

**Why this matters beyond code style:** v5 is a priced, client-facing scope document. If its dependency table tells the client the payment/checkout backend for the Vendor Portal is already built and tested, that assumption may be baked into the 100,000 NGN Vendor Portal estimate and timeline. The provider-neutral routing described in v5 Section 4 is the *right target* — it matches the decision below — but it is **new backend work**, not a rename of something already shipped. Recommend flagging this status correction back to the client directly, separate from the technical scope below, since it has cost/timeline implications she should see explicitly rather than infer from an engineering doc.

**Param naming:** this document uses `plan` (not v5's `planId`) as the request field, since `plan` is what's already implemented and tested end-to-end. Recommend correcting v5's wording to match rather than renaming a field that's threaded through checkout, webhooks, and event records.

---

## 1. Decision log (2026-07-15)

| Topic | Decision |
|---|---|
| Duplicate tree | `expo/` is live. **Approved.** |
| Mock behavior removal (local AsyncStorage upgrades, hardcoded prices, founder pricing, client-settable tiers) | Remove. **Approved.** |
| Migration plan (cache display-only, backend authoritative, wait for webhook, `getSubscriptionStatus` drives lifecycle) | **Approved.** |
| Country resolution | Backend resolves server-side: `vendor.businessLocation?.countryCode ?? vendor.countryCode`. Frontend never touches either field. |
| Provider routing | **Backend-owned.** One generic `createSubscriptionCheckout({ plan })` callable; provider-specific functions become internal, not publicly callable. Frontend dispatcher rejected as final architecture. |
| Pricing display | New public offerings callable required — `getCheckoutAvailability` doesn't return amounts. |
| `billingInterval` | Frontend stops sending it. Backend already rejects non-`"monthly"` values (`requireMonthlyBillingInterval` in `countryPricing.ts`) — no backend change needed here. |
| Username fields inside `VendorPlanContext` | Stay for this pass, **documented as technical debt**. Should move to a separate profile/account context later; no new subscription code should depend on it. |
| Request param name | Keep `plan` (matches tested code) everywhere, including both offerings callables' responses (Section 5) — no `planId`/`plan` split. |
| Provider priority order | **Country-specific, not global.** No single "Paystack → Flutterwave → Stripe for everyone" order — see Section 4.1. |
| Cost of Section 7 backend work | **No extra cost — a correction, not new scope.** v5 already priced the Vendor Portal assuming provider-neutral checkout was "already exists and tested." It wasn't built to that spec. Finishing it to match v5 completes already-agreed scope; see Section 11. |
| Pricing offerings contract | **Split into two callables**, not one — `getVendorSubscriptionOfferings()` (authenticated, Rork/Vendor Portal, server-resolved country only) and `getPublicSubscriptionOfferings({ countryCode })` (unauthenticated, marketing site, browsing only, never authorizes checkout). See Section 5. |
| Provider-neutrality test scope | Narrowed from a repo-wide string search to subscription-specific files only, checking for provider-selection logic rather than banning the words "paystack"/"flutterwave"/"stripe" from ever appearing anywhere in `expo/`. |

---

## 2. Duplicate-tree confirmation (unchanged, approved)

**`expo/` is the live tree.** Confirmed independently:

- `rork.json` declares `"path": "expo"` for both app entries.
- `expo/` is the only directory with a `package.json` / `app.json` — root-level `app/` isn't independently buildable.
- Git history: root-level `app/`, `contexts/`, `constants/` last touched 2026-06-08 or earlier; `expo/` equivalents have commits through 2026-07-12.
- The repo's own `README.md` states the root-level copies are a Rork platform sync/export artifact — "always edit inside `expo/`, never the root-level copies."

**Live paths:** `expo/contexts/VendorPlanContext.tsx`, `expo/constants/vendorPricing.ts`, `expo/services/subscriptionService.ts`, `expo/services/repositories/subscriptionRepository.ts`, `expo/services/mappers/subscriptionMapper.ts`, `expo/app/vendor/settings/upgrade-plan.tsx`, `expo/app/vendor/settings/subscription.tsx`.

**Root-level duplicate:** leave untouched — unclear whether Rork's export mechanism writes back to it.

---

## 3. Country resolution — decided

```ts
const countryCode = vendor.businessLocation?.countryCode ?? vendor.countryCode;
```

- Existing vendors keep working through the legacy flat `countryCode`.
- Newly migrated vendors resolve through `businessLocation.countryCode` once populated.
- Neither the mobile frontend nor the Vendor Portal reads or chooses between the two fields — both only ever receive a resolved country from backend responses, matching v5 Section 1.1's rule that post-authentication pricing has no manual override.
- The fallback is removable once the location migration is complete.

## 4. Provider routing — decided

`createSubscriptionCheckout({ plan })` becomes the **only public checkout entry point** for both the mobile app and the Vendor Portal — this is what v5 Section 4 describes as the target, corrected per Section 0 to reflect that it must still be built.

Backend responsibilities inside that single callable:
1. Authenticate the vendor.
2. Resolve the vendor's country (Section 3).
3. Load active pricing (`requireActiveCountryPricing`, exists today).
4. Determine supported provider(s) for that country+plan (`providerPlanMapping`, exists today).
5. Choose the provider via server-side priority/configuration (**new** — does not exist today).
6. Invoke the internal Paystack, Flutterwave, or Stripe implementation.
7. Return `{ success, authorizationUrl, reference }` (already identical across all three today — no response-shape change needed).

`createFlutterwaveCheckout` and `createStripeCheckout` become **internal helpers only**, not exported as public `https.onCall` functions. Neither Rork nor the Vendor Portal may import or select between them. Adding a fourth provider or reprioritizing requires a backend deploy only.

### 4.1 Provider priority — country-specific, not global

Step 5 above ("choose the provider via server-side priority/configuration") must not default to one universal order like Paystack → Flutterwave → Stripe applied to every country — that risks routing, say, a Canadian vendor through Paystack purely because Paystack happens to be configured first globally, even though Paystack has no real presence there.

Priority is configured **per country**:

```json
{ "countryCode": "NG", "providerPriority": ["paystack", "flutterwave", "stripe"], "status": "active" }
{ "countryCode": "CA", "providerPriority": ["stripe"], "status": "active" }
{ "countryCode": "GB", "providerPriority": ["stripe"], "status": "active" }
```

**Storage — corrected.** `subscriptionPricing/{countryCode}` is publicly readable (per `subscription-pricing/README.md`: "public read"), so `providerPriority` must **not** live there — that would expose which providers the platform uses per country, provider preference order, and future provider additions before they're announced, to any unauthenticated client. It also contradicts the rule that the frontend must never know Paystack/Flutterwave/Stripe exist at all.

Instead: a new **Admin-SDK-only** collection, `subscriptionProviderConfig/{countryCode}`, alongside the existing private `providerPlanMapping`:

```ts
type SubscriptionProvider = "paystack" | "flutterwave" | "stripe";

interface SubscriptionProviderConfig {
  countryCode: string;
  providerPriority: SubscriptionProvider[]; // non-empty, no duplicates, each value in SubscriptionProvider
  status: "active" | "inactive";
}
```

`createSubscriptionCheckout` reads all three private/public pieces server-side and combines them — public `subscriptionPricing` (amount/currency), private `subscriptionProviderConfig` (priority order), private `providerPlanMapping` (per-provider plan IDs) — then picks the first provider in that country's `providerPriority` list that also has an active `providerPlanMapping` entry for the requested plan. Validation on write must reject: any value outside `SubscriptionProvider`, duplicate entries, an empty `providerPriority` array, and (at checkout time) a provider present in the priority list but missing a `providerPlanMapping` entry for that country+plan combination. If a country has no active `subscriptionProviderConfig`, treat it as checkout-unavailable rather than silently guessing an order.

## 5. Pricing display contract — two callables, not one

`getCheckoutAvailability`'s actual response shape is `{ available, countryCode, availableProviders, reason? }` — no amounts, no currency. A vendor-facing offerings callable is needed for both Rork and the Vendor Portal's Pricing screens. But "vendor-facing" isn't the only case: v5 Section 1.1 documents a **public marketing Pricing page** with a manual country selector for unauthenticated visitors who have no vendor account at all — a single vendor-scoped callable can't serve that. These are two different trust boundaries and need two different callables, not one callable overloaded with an optional country parameter.

### 5.1 `getVendorSubscriptionOfferings()` — authenticated

Used by Rork and the Vendor Portal only.

- **Requires authentication.**
- Resolves country exclusively server-side via `vendor.businessLocation?.countryCode ?? vendor.countryCode` (Section 3) — **accepts no client-supplied country.** A vendor cannot submit a different country to get cheaper pricing than their actual registered business location.

```ts
// Response:
{
  countryCode: "CA",
  currencyCode: "CAD",
  plans: [
    { plan: "standard", monthlyPriceMinorUnits: 1999, available: true },
    { plan: "pro",      monthlyPriceMinorUnits: 3999, available: true },
    {
      plan: "pro_plus",
      monthlyPriceMinorUnits: 6999,
      available: false,
      unavailableReason: "PAYMENT_PROVIDER_NOT_CONFIGURED"
    }
  ]
}
```

### 5.2 `getPublicSubscriptionOfferings({ countryCode })` — unauthenticated

Used only by the public marketing website's Pricing page, matching v5 Section 1.1's visitor-facing country selector (browser-local, never authoritative, never defaults silently to NGN).

- **Does not require a vendor account.**
- Accepts a client-supplied `countryCode`, validated against `location-data/countries.json` — invalid codes rejected, not silently substituted.
- Returns the same response shape as 5.1.
- **Never authorizes checkout** — browsing only. A visitor calling this callable has no path from its response straight into `createSubscriptionCheckout`; that still requires an authenticated vendor.
- Must be rate-limited and App Check-protected (an unauthenticated, public callable is the one place in this contract with no auth boundary at all, so abuse protection has to do that job instead).

### Shared rules for both

Both use `plan` (not `planId`), matching `createSubscriptionCheckout({ plan })` exactly — a vendor can pass `offering.plan` straight into checkout with no field-name mapping. (Earlier drafts of this document used `planId`; corrected for consistency.)

`unavailableReason` reuses the two vendor-safe error codes that already exist in `countryPricing.ts` — `PRICING_NOT_CONFIGURED` and `PAYMENT_PROVIDER_NOT_CONFIGURED` — rather than inventing new ones. Neither code names a provider or exposes `providerPlanMapping` contents, so both are already safe to surface. The frontend maps each to the plain-language copy v5 Section 4.5 specifies: `PRICING_NOT_CONFIGURED` → *"Subscriptions are not available in your country yet"*; `PAYMENT_PROVIDER_NOT_CONFIGURED` → *"Subscriptions are temporarily unavailable. Please try again later."*

Both are backed by `subscriptionPricing/{countryCode}` — never `providerPlanMapping` or `subscriptionProviderConfig` (Section 4.1), both private, Admin-SDK-only, must stay that way. `available`/`unavailableReason` per plan reuses `checkCheckoutAvailability`'s existing logic, extended to also check `subscriptionProviderConfig`. Both callables privately combine public pricing with private provider priority and private provider mappings server-side, but return **only** country, currency, plan, monthly price, availability, and the vendor-safe `unavailableReason` — never provider names or priority, under any field name, in either callable.

No frontend (mobile, Vendor Portal, or the public marketing site) may read `subscriptionPricing`/`providerPlanMapping` directly or keep a local pricing table (`constants/vendorPricing.ts` is being removed — Section 7).

## 6. Monthly-only contract

No backend change needed — `requireMonthlyBillingInterval()` already accepts an omitted value or exactly `"monthly"` and rejects everything else with `invalid-argument`. Only the frontend needs to stop sending `billingInterval`.

---

## 7. Backend prerequisite work (blocking — must ship before Section 9)

All in `the platform-backend/functions/src/subscriptions/`:

| Change | File(s) | Notes |
|---|---|---|
| `resolveVendorCountry(vendorId)` helper implementing the Section 3 fallback | `countryPricing.ts` (or new file) | Replace the inline `vendorSnap.data()?.countryCode` reads in `subscriptionFunctions.ts` and `internationalCheckout.ts`. |
| New private `subscriptionProviderConfig/{countryCode}` collection (typed `SubscriptionProvider[]`, validated) + selection logic inside `createSubscriptionCheckout` | New collection, `firestore.rules` (Admin-SDK-only, matching `providerPlanMapping`'s existing `allow read, write: if false`), `subscriptionFunctions.ts` | New. Country-specific, per Section 4.1 — picks the first provider in that country's list with an active `providerPlanMapping` entry for the plan. No universal fallback order, never stored in the public `subscriptionPricing` document. |
| De-export `createFlutterwaveCheckout` / `createStripeCheckout` as public callables; keep as internal functions called by `createSubscriptionCheckout` | `internationalCheckout.ts`, `subscriptionFunctions.ts` | Safe — confirmed the frontend never calls these two directly today (no `httpsCallable`/`getFunctions` usage exists anywhere in `rork-the platform`), so this isn't a breaking change for any real client. |
| New `getVendorSubscriptionOfferings` (authenticated) and `getPublicSubscriptionOfferings` (unauthenticated, rate-limited) callables | New file, or added to `subscriptionFunctions.ts` | Per Section 5.1/5.2. Neither may ever expose `providerPlanMapping` or `subscriptionProviderConfig` contents. The public one is scoped for the marketing website, not Rork/Vendor Portal, but is still part of this backend prerequisite work since both share the same underlying pricing-resolution logic. |

---

## 8. Frontend subscription-alignment scope

### Files to remove or refactor (all inside `expo/`)

| File | Action |
|---|---|
| `constants/vendorPricing.ts` | **Remove.** Delete `COUNTRY_PRICING`, the `founder`/`regular` split, `FOUNDER_PRICING_CAP_PER_COUNTRY`. |
| `contexts/VendorPlanContext.tsx` | **Refactor.** Remove `updatePlan()`'s direct AsyncStorage write of `plan`. Remove `founderPricingEligible`. Username-related state stays for this pass — documented debt (Section 1). |
| `services/subscriptionService.ts` | **Refactor.** Remove `setTier()` / `setBackendTier()` (client-settable tier — billing-bypass risk). Replace `getSubscription()` / `getTier()` with calls through the repository to `getSubscriptionStatus`. |
| `services/repositories/subscriptionRepository.ts` | **Refactor.** Replace AsyncStorage read/write with calls to the five backend callables below. AsyncStorage becomes a cache layer only. |
| `services/mappers/subscriptionMapper.ts` | **Refactor.** Map the real `getSubscriptionStatus` response shape (`effectivePlan`, `planLimits`, `subscription`, `reason`, `pendingDowngrade`, `recentEvents`). Keep `toBackendTier` / `fromBackendTier` (`'pro+'` ↔ `'pro_plus'`) — still correct. |
| `app/vendor/settings/upgrade-plan.tsx` | **Refactor.** `handleUpgrade` calls `createSubscriptionCheckout({ plan })` directly — no dispatcher, no provider selection in this file. Remove founder/sale-price UI branch; source prices from `getVendorSubscriptionOfferings` (Section 5.1) — never the public callable, which has no auth context to gate on. |
| `app/vendor/settings/subscription.tsx` | **Refactor.** Remove founder-price display; source price/status from backend responses. |
| `types/domain/subscriptionTier.ts` | **Check/extend.** Confirm it represents the real backend `reason` enum (`vendor_suspended`, `admin_override`, `active`, `trialing`, `grace_period`, `cancelled_before_period_end`, `no_subscription`, `expired_or_other`) and `pendingDowngradePlan`. |

**No dispatcher file.** A v1 draft of this document proposed a frontend-side provider-priority dispatcher — rejected per Section 4. There is exactly one checkout call in the frontend.

### Backend callables/contracts the frontend uses

- **`getVendorSubscriptionOfferings()`** (Section 5.1) → country-resolved plans, prices, currency, availability. Rork/Vendor Portal only — never the public offerings callable, which has no vendor auth context.
- **`createSubscriptionCheckout({ plan })`** → `{ success, authorizationUrl, reference }`. The only checkout call — no `billingInterval`, no provider selection.
- **`getSubscriptionStatus({ vendorId? })`** → `{ subscription, effectivePlan, planLimits, reason, pendingDowngrade, recentEvents }`.
- **`cancelSubscription()` / `reactivateSubscription()`** — replace local AsyncStorage cancellation writes.

**Explicitly not used:** direct reads of `subscriptionPricing` / `providerPlanMapping`, the three provider-specific checkout callables (no longer public), and `getPublicSubscriptionOfferings` (Section 5.2 — that one belongs to the separate public marketing website, not this app).

### Migration plan from current AsyncStorage state (unchanged, approved)

1. Storage key becomes a **read-through cache only**: hydrate UI from cache on launch, then refetch `getSubscriptionStatus` and reconcile.
2. `plan`, `founderPricingEligible`, `cancellationScheduled`, `cancellationDate` stop being locally authoritative — mirror-only.
3. `updatePlan()` is deleted as a mutator. Plan changes only as a side effect of `getSubscriptionStatus` reflecting a real webhook-driven change.
4. Username fields stay local-only for this pass.
5. Migration guard: on first launch post-change, if the cache holds a paid plan with no corresponding real `vendorSubscriptions` record, treat the vendor as `basic` until `getSubscriptionStatus` says otherwise.

### UI states (`upgrade-plan.tsx` / `subscription.tsx`)

| State | Trigger | Behavior |
|---|---|---|
| **Loading** | `getVendorSubscriptionOfferings` / `getSubscriptionStatus` in flight | Skeleton; upgrade buttons disabled |
| **Unavailable** | Plan's `available: false` | Approved unavailable state; button never tappable |
| **Checkout in progress** | Vendor tapped upgrade, `authorizationUrl` not yet returned | Spinner on that button only |
| **Awaiting webhook** | Vendor returned from provider's hosted checkout, backend hasn't confirmed yet | "Confirming your subscription…" state; poll `getSubscriptionStatus`. **Plan must not visually change until this resolves.** |
| **Success** | `effectivePlan` matches what was purchased | Confirmation, then normal plan-gated UI |
| **Cancellation scheduled** | `reason: "cancelled_before_period_end"` | End-of-period date; offer reactivate |
| **Grace period** | `reason: "grace_period"` | Past-due banner with `gracePeriodEnd` |
| **Pending downgrade** | `pendingDowngrade` non-null | Upcoming plan change and effective date |
| **Admin override** | `reason: "admin_override"` | Informational only |
| **Failure** | Checkout throws, or webhook confirmation times out | Error state with retry — never a silent fallback to a locally-assumed plan |

### Tests proving a local write cannot grant paid entitlements

- Directly write a paid plan to the AsyncStorage cache key; assert plan-gated UI/logic still reflects a mocked `getSubscriptionStatus` returning `basic`.
- Assert `subscriptionService` exports no method that writes `plan` without going through a real backend callable.
- Assert `handleUpgrade` never mutates context/state directly — only re-renders from a fresh `getSubscriptionStatus` result.
- Assert the unavailable state renders correctly even against a stale cache claiming a paid plan.
- Assert no subscription service, repository, context, mapper, or subscription screen under `expo/` contains provider-selection logic or a provider-specific callable reference (`createFlutterwaveCheckout`, `createStripeCheckout`, or any per-provider branching). Scoped to subscription-related files specifically, not a repo-wide string search — the words "paystack"/"flutterwave"/"stripe" may legitimately appear elsewhere in the app (legal copy, support content, acknowledgements) without that being a violation of provider-neutrality.

---

## 9. What to tell Rork (blocked until Section 7 ships)

Do not send this brief until the backend prerequisite work in Section 7 is deployed — `getVendorSubscriptionOfferings` and the single-entry-point `createSubscriptionCheckout` don't exist in that form yet.

> Work only inside `expo/`. Remove `constants/vendorPricing.ts` and the "founder" pricing tier from the active MVP flow. Remove `updatePlan()`'s local AsyncStorage write of plan in `contexts/VendorPlanContext.tsx` — plan may only change from a backend `getSubscriptionStatus` response. Wire `subscriptionService` / `subscriptionRepository` / `subscriptionMapper` to five backend callables only: `getVendorSubscriptionOfferings`, `createSubscriptionCheckout({ plan })`, `getSubscriptionStatus`, `cancelSubscription`, `reactivateSubscription`. Do not call `getPublicSubscriptionOfferings` (that one belongs to the public marketing website, not this app), do not call any provider-specific checkout function, do not send `billingInterval`, and do not implement provider-selection logic anywhere. Render the loading / unavailable / checkout-pending / awaiting-webhook / success / cancelled / grace-period / pending-downgrade / failure states in `upgrade-plan.tsx` and `subscription.tsx`. Do not touch the root-level duplicate `app/`, `contexts/`, `constants/`.

**Target end-to-end flow (matches v5 Section 4's intent, corrected per Section 0 for current status):**

```
Rork / Vendor Portal render prices and status (getVendorSubscriptionOfferings, getSubscriptionStatus)
        ↓
One generic backend checkout callable (createSubscriptionCheckout)
        ↓
Backend selects provider (server-side priority/config)
        ↓
Webhook updates subscription (unchanged, already exists)
        ↓
Frontend refreshes backend status (getSubscriptionStatus)
```

---

## 10. v5 correction — blocking, before coding begins

**Update v5 before Section 7 implementation starts**, not after. v5's claim that provider-neutral checkout is "already architecturally resolved" and "already exists and tested" must be corrected in v5 itself first, so the priced mapping document and this implementation scope don't contradict each other once code is being written against both. The correction: v5 should state that provider-neutral checkout was outstanding work, now being completed as a correction to already-agreed scope (Section 11), not a description of something already shipped. (This is about v5's wording matching reality — the cost/who-pays question is resolved separately in Section 11.)

## 11. Cost and scope resolution

**Section 7 backend work ships at no extra cost — it's a correction, not additional paid scope.**

Reasoning: v5's Section 4 and Section 10 dependency table both stated, as an accepted premise of the priced 400,000 NGN package (specifically the 100,000 NGN Vendor Portal line), that provider-neutral checkout was "already architecturally resolved" and "already exists and tested." That was the basis the client priced against. Since it wasn't actually built to that spec, completing it — the country-fallback helper, server-side provider priority selection (Section 4.1, including the private `subscriptionProviderConfig` collection and its validation), internalizing the two provider-specific checkout functions, and the new offerings callables (Section 5) — is finishing already-agreed scope, not scope expansion. Had v5 correctly described this as outstanding work at the time it was priced, it would already be inside the 100,000 NGN Vendor Portal estimate; the fix here is to the document's accuracy, not to the invoice.

**The reasonable implementation required to complete all four Section 7 items — including private, country-specific provider-priority configuration and its validation — is included at no additional cost. Only genuinely new functionality beyond those four items requires separate written approval**, so this reasoning has a fixed boundary rather than remaining open-ended: it covers exactly the four rows in Section 7's table, nothing implied beyond them.
