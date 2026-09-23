# Apple App Store & Google Play Subscription Plan

**Status: documentation-only.** Per the Founder (2026-08-09), the parts of this scope
that require an incorporated Platform legal entity (production Apple/Google
merchant accounts, banking/tax setup, live App Store Connect and Play Console
credentials) are paused until incorporation completes. This document is the
design to build against once that access is available. It is a first draft:
sections marked **[NEEDS FOUNDER]** are business/product decisions, not
engineering ones, and should be confirmed before implementation starts rather
than assumed.

Classification unchanged from the 2026-07-26 agreement: this is deferred,
already-paid Milestone 4 work, not new billable scope.

**One piece pulled forward, 2026-08-09:** the cross-provider guard in
Section 6 has actually been built and shipped
(`subscriptionFunctions.ts`, commit `3f2bd73`), ahead of everything else in
this document. It needed no Apple/Google credentials, no incorporation, and
no new dependencies, so there was no reason to wait on it, unlike everything
else here. Section 6 below now describes what's live, not a proposal.

## 1. Why this fits the existing architecture without a rewrite

Three things worth knowing before reading the rest of this doc, because they
change how big this build actually is:

1. **`SubscriptionProvider` already includes `"apple"` and `"google"`**
   (`functions/src/types4.ts`). The type system was built anticipating this
   from early on. This isn't a new enum to introduce, it's already there and
   unused.
2. **The webhook processing core is already 100% provider-agnostic.**
   `processNormalizedWebhookEvent()` in `subscriptionWebhookCore.ts` takes a
   `NormalizedWebhookEvent` (provider, normalized event type, plan, amount,
   provider IDs) and does everything else identically regardless of which
   provider sent it: staleness rejection, idempotency, distributed locking,
   out-of-order/priority resolution, the `vendorSubscriptions` mutation, and
   the audit log write. Adding Apple/Google means writing a new
   signature-verification file and a new raw-event → normalized-event mapping
   function, exactly the same shape as `paystackWebhook.ts` /
   `flutterwaveWebhook.ts` / `stripeWebhook.ts` already are. **This file does
   not change.**
3. **`vendorSubscriptions/{vendorId}` is already a single canonical doc per
   vendor with a `provider` field on it.** There is structurally only ever
   one active subscription record per vendor today. "One provider is the
   billing authority" is already the shape of the data. What's missing is
   enforcement at the point a new subscription is started (Section 6).

What genuinely doesn't exist yet and has to be built:
- Product ID mapping for Apple/Google (Section 2).
- A purchase-verification entry point for each store, since IAP has no
  "checkout URL" the way Paystack/Flutterwave/Stripe do. The purchase
  happens natively in the app, and the backend verifies it after the fact
  (Section 3).
- App Store Server Notifications V2 and Google Play RTDN handlers, feeding
  into the existing core (Section 4).
- Region/platform eligibility logic (Section 7).
- The Apple/Google side of the cross-provider guard (Section 6): the web
  side is done; `verifyApplePurchase`/`verifyGooglePurchase` need the same
  check once they exist.

## 2. Product IDs

Apple and Google each require product IDs to be created once in their
respective consoles and never renamed afterward (renaming breaks existing
subscribers' entitlement history on both platforms). Proposed scheme,
mirroring the plan IDs already used everywhere else in the codebase
(`SubscriptionPlanId`: `standard` | `pro` | `pro_plus`):

| Plan | Apple Product ID | Google Product ID |
|---|---|---|
| Standard | `com.platform.app.subscription.standard.monthly` | `platform_standard_monthly` |
| Pro | `com.platform.app.subscription.pro.monthly` | `platform_pro_monthly` |
| Pro+ | `com.platform.app.subscription.pro_plus.monthly` | `platform_pro_plus_monthly` |

Apple product IDs are conventionally reverse-DNS and must be unique per app;
`com.platform.app` matches the app's actual bundle ID/package name
(**confirmed 2026-08-09**: `multivendor-marketplace-mobile/expo/app.json` already sets both
`ios.bundleIdentifier` and `android.package` to `com.platform.app`, so this
table is settled, not a placeholder). Google product IDs are scoped to the
app already, so no prefix needed; using the same base spelling as Apple to
keep a human reading both consoles side by side from getting confused.

Both stores should be set up as **auto-renewing subscriptions**, monthly
billing period, matching `VendorSubscriptionDoc.billingInterval: "monthly"`
which is currently the only interval the backend supports. Google additionally
requires a "base plan ID" per product (Play Billing's newer subscription
model), proposed as `monthly` for all three, since there's only one interval
today.

## 3. Backend data model changes

### 3.1 `ProviderPlanMapping` (`types4.ts`, `providerPlanMapping/{countryCode}-{planId}`)

Currently:

```typescript
export interface ProviderPlanMapping {
  countryCode: string;
  planId: "standard" | "pro" | "pro_plus";
  paystack?: { monthlyPlanCode: string };
  flutterwave?: { monthlyPlanId: string };
  stripe?: { monthlyPriceId: string };
}
```

Add:

```typescript
  apple?: { productId: string };
  google?: { productId: string; basePlanId: string };
```

Note the difference from the web providers: Apple/Google product IDs are
**global**, not per-country. The same `com.platform.app.subscription.pro.monthly`
product is what every country's App Store purchases against, with the price
in each currency set inside App Store Connect's own per-territory price
matrix (same idea for Google's per-region pricing in Play Console). So in
practice every country's `apple`/`google` mapping entries will point to the
*same* three product IDs. The mapping still keys by country because that's
where `requireActiveCountryPricing`/`selectProvider` already look, but the
values themselves won't vary by country the way `paystack.monthlyPlanCode`
does. Worth deciding whether to actually duplicate the same product ID into
every country's mapping doc, or special-case Apple/Google to read from one
global config doc instead of per-country ones, leaning toward the latter to
avoid 190 documents holding an identical two values, but this is a genuine
implementation choice, not settled yet.

### 3.2 `VendorSubscriptionDoc`: no schema changes, but two derived fields to compute correctly

`provider: SubscriptionProvider` already accepts `"apple" | "google"`.
`providerSubscriptionId` becomes Apple's `originalTransactionId` or Google's
`purchaseToken`; `providerCustomerId` becomes a value derived from the vendor's
Firebase UID (never the raw UID itself, see Section 3.3 for why). Nothing in
the schema needs to change, but neither of these values can just be the raw
UID passed straight to the store, which the first draft of this doc got
wrong.

### 3.3 Linking a store purchase back to a Platform vendor

This is the one piece with no web-provider equivalent worth calling out
explicitly: Paystack/Flutterwave/Stripe checkout sessions are created
server-side, so the backend already knows the vendorId before the purchase
happens (Paystack's webhook literally receives it back in cleartext via
`data.metadata.vendorId`, see `paystackWebhook.ts`). Apple/Google purchases
are initiated client-side inside the app, so the vendorId has to be attached
at purchase time in a form each store actually accepts, then recovered from
it later. Neither store accepts a raw Firebase UID for this, for two
different reasons, corrected here after review flagged both:

- **Apple**: StoreKit 2's `appAccountToken` is typed as an actual `UUID`, not
  an arbitrary string. Firebase Auth UIDs are 28-character base62 strings,
  not RFC 4122 UUIDs, and critically, StoreKit 2 does not reject an invalid
  value with an error, it **silently drops it** and lets the purchase proceed
  with no `appAccountToken` at all. Passing the raw UID (what the first draft
  of this doc proposed) would have looked correct in testing and then
  silently broken vendor attribution in a way that's hard to notice until an
  actual renewal notification arrives with nothing to match it against.
  Fix: derive a deterministic UUID from the vendor's Firebase UID with
  **UUIDv5** (a fixed Platform namespace UUID, generated once and hardcoded as
  a constant, hashed together with the vendorId), e.g.
  `uuidv5(vendorFirebaseUid, PLATFORM_APPLE_NAMESPACE)`. Deterministic means
  the same vendor always produces the same token, so it can be recomputed for
  verification without storing anything extra.
- **Google**: Play Billing's `setObfuscatedAccountId()` documentation is
  explicit that this field must not contain PII in cleartext, and that Google
  Play actively scans it: "Storing PII in this field results in purchases
  being blocked." A Firebase UID isn't classic PII like an email, but it's
  still a real per-user identifier, and the documented safe pattern is
  encryption or a one-way hash, not passing an identifier through directly.
  Fix: `HMAC-SHA256(vendorFirebaseUid, PLATFORM_SERVER_SECRET)` using a
  server-held secret. Since this has to be computed *before* the purchase
  sheet opens (the client sets it when launching Play Billing, before any
  server round-trip happens as part of the purchase itself), the client can't
  compute it directly without the secret being shipped in the app binary,
  which defeats the point. A small new read-only callable,
  `getGooglePurchaseAccountId()`, returns the precomputed value for the
  signed-in vendor so the secret never leaves the server.

Both values are deterministic functions of `vendorId` alone (plus a fixed
server-held constant), which matters for two separate things:

1. **First-purchase validation**: on the *first* purchase-verification call
   (`verifyApplePurchase`/`verifyGooglePurchase`), recompute the expected
   value from `request.auth.token.vendorId` and confirm it matches what the
   store actually returned, before trusting the purchase belongs to that
   vendor (never trust the client's claimed vendorId alone, same App Check +
   Firebase Auth pattern every other callable in this codebase already
   uses).
2. **Resolving vendorId on later renewal notifications**: unlike Paystack,
   neither Apple's Server Notifications nor Google's RTDN payloads carry a
   Platform vendorId directly, they carry `appAccountToken` (Apple, echoed on
   every transaction, not just the first) or `purchaseToken` (Google). Once
   `providerCustomerId` is written to `vendorSubscriptions/{vendorId}` at
   first activation, a later notification resolves back to the vendor with a
   direct equality query against the existing collection:
   `db.collection("vendorSubscriptions").where("providerCustomerId", "==", incomingValue).limit(1)`.
   No new collection or index needed, this is a plain single-field equality
   query against a field that's already being written anyway.

## 4. Purchase and verification flow

Unlike the web providers, there is no `createSubscriptionCheckout` equivalent
that returns a URL. The flow is:

1. Client (Expo app, native build only, see Section 9) presents the
   StoreKit 2 / Play Billing purchase sheet directly, with the appAccountToken
   / obfuscatedAccountId set to the signed-in vendor's UID.
2. On successful purchase, the client receives a signed transaction (Apple:
   JWS `SignedTransaction`; Google: a purchase token) and calls a new callable
   (`verifyApplePurchase` / `verifyGooglePurchase`), passing that token.
3. The callable:
   - Verifies the signature/token server-side (Apple: verify the JWS against
     Apple's public keys via the App Store Server API; Google: call the Play
     Developer API's `purchases.subscriptions.get` with the service account).
   - Confirms the vendorId embedded in the token matches the authenticated
     caller.
   - Confirms the product ID matches one of the three known plan mappings.
   - Builds a `NormalizedWebhookEvent` (`normalizedEventType: "activation"`)
     and calls `processNormalizedWebhookEvent()`, **the exact same function
     every other provider's webhook uses.**
4. Renewals, cancellations, refunds, grace periods and billing retries arrive
   later as asynchronous server notifications (Section 5), not through this
   callable again. This callable only ever handles the *first* activation
   and the client-side "restore purchases" flow (same callable, re-verifying
   an existing transaction rather than a new one).

## 5. Server-to-server notifications

### 5.1 Apple: App Store Server Notifications V2

New file: `functions/src/subscriptions/appleNotifications.ts`, same shape as
`stripeWebhook.ts`. Apple POSTs a signed JWS payload to a configured HTTPS
endpoint. Verification: decode the JWS header's `x5c` certificate chain,
verify it chains to Apple's root CA, then verify the signature. Apple
publishes an official `app-store-server-library` (Node) that does this;
using it rather than a hand-rolled JWS verifier.

Relevant `notificationType` values to map (mirrors the existing
`normalize*EventType()` functions in `eventPriority.ts`):

| Apple `notificationType` | `subtype` | → `NormalizedEventType` |
|---|---|---|
| `SUBSCRIBED` | `INITIAL_BUY` | `activation` |
| `DID_RENEW` | n/a | `renewal` |
| `DID_FAIL_TO_RENEW` | `GRACE_PERIOD` | `past_due` |
| `EXPIRED` | `VOLUNTARY` / `BILLING_RETRY` | `cancelled` |
| `DID_CHANGE_RENEWAL_STATUS` | `AUTO_RENEW_DISABLED` | `cancelled` (soft, see note) |
| `REFUND` | n/a | `cancelled` |
| `GRACE_PERIOD_EXPIRED` | n/a | `cancelled` |

Note: `DID_CHANGE_RENEWAL_STATUS`/`AUTO_RENEW_DISABLED` is Apple's equivalent
of the existing `cancelSubscription` callable's "soft cancel, keep access
until period end", it is **not** the same as a hard `cancelled` in the table
above. This needs its own normalized event type distinct from a provider-side
hard cancellation, matching how the existing `cancelSubscription` callable
deliberately leaves `status: "active"` with `cancelAtPeriodEnd: true` rather
than cancelling outright (`subscriptionFunctions.ts`, referenced in
`subscriptionWebhookCore.ts`'s comment on webhook-driven vs vendor-initiated
cancellation). **[NEEDS ENGINEERING DECISION, not the Founder]**: flagged here so
it isn't missed, not because it needs her input.

### 5.2 Google: Real-time Developer Notifications (RTDN)

New file: `functions/src/subscriptions/googleRtdn.ts`. Google publishes
notifications to a Cloud Pub/Sub topic (configured in Play Console), which
this Cloud Function subscribes to as a push endpoint, a different transport
than Apple/Stripe/Paystack/Flutterwave's plain HTTPS POST, but the
verification is arguably simpler (Pub/Sub push requests carry a Google-signed
JWT that Firebase's own `google-auth-library` can verify directly, no
manual certificate chain walk).

| Google `notificationType` (numeric) | → `NormalizedEventType` |
|---|---|
| `SUBSCRIPTION_PURCHASED` (4) | `activation` |
| `SUBSCRIPTION_RENEWED` (2) | `renewal` |
| `SUBSCRIPTION_IN_GRACE_PERIOD` (6) | `past_due` |
| `SUBSCRIPTION_ON_HOLD` (5) | `past_due` |
| `SUBSCRIPTION_CANCELED` (3) | `cancelled` (soft, same caveat as Apple above) |
| `SUBSCRIPTION_EXPIRED` (13) | `cancelled` |
| `SUBSCRIPTION_REVOKED` (12) | `cancelled` |

Both files converge on the same `processNormalizedWebhookEvent()` call as
every existing provider. `NORMALIZED_EVENT_PRIORITY` in `eventPriority.ts`
needs no changes. Apple/Google notifications aren't ordering-guaranteed
either, so the existing out-of-order resolution logic applies unmodified.

## 6. Cross-provider single-subscription enforcement

**Web side: done (2026-08-09, `subscriptionFunctions.ts`, commit `3f2bd73`).
Apple/Google side: blocked on those callables not existing yet.**

`createSubscriptionCheckout`'s existing double-billing guard used to
automatically cancel a vendor's existing live subscription on whatever
provider it was on and immediately start a new one on a possibly-different
provider, with no gap. That was fine for Paystack/Flutterwave/Stripe
swapping among themselves (the frontend already treats those three as one
interchangeable "web billing" rail, so an immediate swap there isn't a
provider change from the vendor's point of view), but wrong for Apple/Google:
the Founder's rule is that an active Apple/Google subscriber should never be moved
to a web subscription automatically, since Apple/Google can't be cancelled by
a server-side call at all, only by the vendor in that store's own settings.
Silently starting a web subscription on top of a live Apple/Google one would
have double-billed them.

What's actually in `subscriptionFunctions.ts` now:

```typescript
export const ALREADY_SUBSCRIBED_VIA_STORE = "ALREADY_SUBSCRIBED_VIA_STORE";

// inside createSubscriptionCheckout, before any cancel-and-recheckout logic:
if (existing.provider === "apple" || existing.provider === "google") {
  const storeName = existing.provider === "apple" ? "the App Store" : "Google Play";
  throw new https.HttpsError(
    "failed-precondition",
    `Already subscribed to ${existing.plan} via ${storeName}. Cancel there first, keep access until the period ends, then subscribe again.`,
    { errorCode: ALREADY_SUBSCRIBED_VIA_STORE, provider: existing.provider, plan: existing.plan, currentPeriodEndMs: /* ... */ }
  );
}
// otherwise: unchanged, cancel-and-recheckout across paystack/flutterwave/stripe
```

Both the mobile app's upgrade screen and the vendor portal's subscription
page already surface `error.message` generically on a failed checkout, so
this degrades acceptably today with zero frontend changes, worth revisiting
with real UI once Apple/Google purchases exist (a plain alert isn't as good
as the portal actually showing "you're on Pro via the App Store" the way
Section 3.2's data already supports), but nothing broke or needed rework to
ship this now.

**Still to do, once `verifyApplePurchase`/`verifyGooglePurchase` exist
(Section 4)**: the same check, mirrored: a vendor with an active
Paystack/Flutterwave/Stripe subscription must be blocked from starting an
Apple/Google purchase too. The guard above only covers the web-checkout
entry point since that's the only one that exists today; it is not
symmetric yet.

The vendor portal's subscription page also still needs the display half:
when `existing.provider` is `apple` or `google`, show the plan/status/renewal
date (already have the data) but replace the upgrade/downgrade CTA with a
message pointing at the relevant store's subscription management screen,
since the portal itself cannot start or change an Apple/Google subscription.
This is UI work with no backend dependency, could be done anytime, just
hasn't been prioritized ahead of the rest of this pause.

## 7. Region and platform eligibility

Apple/Google availability is a fundamentally different axis than the existing
`SubscriptionProviderConfig.providerPriority`. That list is *merchant
choice* between web providers Platform has commercial relationships with, all
of which can be shown side by side. Apple/Google eligibility instead depends
on which app the vendor is actually running: an Android user cannot be
offered an Apple IAP purchase and vice versa, regardless of country. That's
why `SubscriptionProviderConfig.providerPriority` is typed to exclude
`"apple" | "google"` already (`Extract<SubscriptionProvider, "paystack" |
"flutterwave" | "stripe">`); it isn't an oversight, apple/google were never
meant to be prioritized the same way. Platform detection is implicit: a
purchase only ever reaches `verifyApplePurchase` from an iOS build or
`verifyGooglePurchase` from an Android build, so no new "platform" field is
needed on the vendor record.

Country eligibility for Apple/Google specifically is a separate lookup: does
that store support subscriptions for developers/accounts in that territory at
all. This is what the CSV research (separate task, in progress) is adding as
its own column, distinct from the existing Stripe/Paystack/Flutterwave
columns.

**[NEEDS FOUNDER / possibly legal]**: the mobile app's current web-provider
checkout (`upgrade-plan.tsx`) opens the provider's hosted checkout page via
the device's system browser (`Linking.openURL`), not an embedded in-app
WebView. Whether that's sufficient for Apple's App Store Review Guidelines
once Apple's own IAP also exists in the app is a live compliance question,
not a settled one. Apple's "external purchase" rules for digital
subscriptions have changed multiple times in the last few years (DMA in the
EU, the Epic v. Apple injunction in the US) and differ by region. Worth a
direct check against Apple's current guidelines (or legal counsel, given
incorporation is already in progress) at build time rather than assuming
today's `Linking.openURL` pattern is automatically fine once Apple IAP is
live in the same app.

## 8. Test / acceptance criteria

Mirrors the acceptance-test style already used for the other three providers
(`scripts/milestone*-acceptance-tests.js`), sandbox/internal-track only,
nothing production, consistent with the incorporation-gated pause.

**Apple (sandbox + TestFlight):**
- [ ] Sandbox purchase of each of the three plans activates the correct plan
      in `vendorSubscriptions` with `provider: "apple"`.
- [ ] `appAccountToken` correctly round-trips to the right vendorId on first
      purchase and on every subsequent notification.
- [ ] Sandbox renewal (Apple's sandbox renews every few minutes to simulate
      a monthly cycle) fires `DID_RENEW` and extends `currentPeriodEnd`.
- [ ] Cancelling auto-renew in sandbox settings fires
      `DID_CHANGE_RENEWAL_STATUS`/`AUTO_RENEW_DISABLED` and sets
      `cancelAtPeriodEnd: true` without dropping `status` from `active`.
- [ ] Letting a sandbox subscription actually expire fires `EXPIRED` and sets
      `status: "cancelled"`.
- [ ] Restore Purchases on a second device correctly re-links to the same
      vendor.
- [ ] A vendor with an active Apple subscription is blocked from starting a
      Paystack/Flutterwave/Stripe checkout (Section 6), and the portal shows
      the Apple plan/status correctly.
- [ ] Sandbox refund flow fires `REFUND` and revokes access appropriately.
- [ ] Duplicate/replayed notifications are idempotent (same
      `subscriptionEvents.idempotencyKey` dedup logic as the other three
      providers, no new code needed here, confirm it, don't rebuild it).

**Google (license testers, internal testing track):**
- [ ] Test purchase of each of the three plans activates the correct plan
      with `provider: "google"`.
- [ ] `obfuscatedAccountId` round-trips correctly.
- [ ] RTDN renewal, grace period, hold, cancellation, revocation, and expiry
      each produce the correct `vendorSubscriptions` state.
- [ ] Same cross-provider block and portal display checks as Apple.
- [ ] Play Console's test refund flow revokes access appropriately.
- [ ] Duplicate RTDN messages (Pub/Sub's at-least-once delivery guarantees
      redelivery) are idempotent.

**Cross-cutting:**
- [ ] A vendor cannot end up with two simultaneously-active
      `vendorSubscriptions` records under any interleaving of web-provider
      and Apple/Google actions (already structurally impossible today since
      it's one doc per vendor; this is confirming the guard in Section 6
      actually prevents the *attempt*, not just relying on the single-doc
      shape after the fact).
- [ ] **Symmetric guard, explicitly required, not optional**: the web-side
      half of this shipped 2026-08-09 (Section 6), a vendor with an active
      Apple/Google subscription is already blocked from starting a web
      checkout. The other direction does not exist yet and must be built
      alongside `verifyApplePurchase`/`verifyGooglePurchase`: a vendor with
      an active Paystack/Flutterwave/Stripe subscription must be blocked
      from starting an Apple/Google purchase too, same
      `ALREADY_SUBSCRIBED_VIA_STORE`-style rejection, checked before the
      purchase is ever verified/activated. This is not complete until both
      directions are confirmed working, one without the other is not the
      business rule that was asked for.
- [ ] `resolveEffectivePlan()` and every plan-limit enforcement point need no
      changes. Confirm this by running the existing plan-limit test suite
      against an Apple/Google-provisioned vendor, since those functions only
      ever read `plan`/`status`, never `provider`.

## 9. Dependencies still needed from the Founder (unchanged from 2026-07-26)

- **Apple**: Apple Developer Program account with Henry added as App
  Manager in App Store Connect (not Account Holder, see Section 10);
  subscription products configured matching the table in Section 2; the
  In-App Purchase key + issuer ID + key ID for the App Store Server API
  (the Founder generates the key herself, since it requires Account Holder or
  Admin, see the correction in Section 10, then hands Henry the key/issuer
  ID/key ID values, not broader account access); TestFlight access plus
  sandbox tester Apple IDs.
- **Google**: Google Play Console access (see minimum-permissions note,
  Section 10); subscription products configured matching Section 2; a Google
  Cloud service account with the Play Developer API enabled; internal
  testing track access plus license tester accounts.
- **Cross-cutting**: native in-app purchases cannot be tested in Expo Go;
  needs an actual EAS/dev build before any of this is testable end to end.

## 10. Her two specific access questions

**Apple, Account Holder vs. App Manager (corrected 2026-08-09, the first
draft got this wrong)**: the Account Holder is the legal entity/individual
who signed Apple's Developer Program License Agreement and is the only role
that can create the initial App Store Connect organization, agree to the
Paid Apps Agreement (required before any subscription product can go live),
and manage banking/tax info. That has to be the Founder (or whoever the
incorporated entity designates), not Henry, since it's tied to legal/
financial responsibility. App Manager is sufficient for most of what
engineering needs: creating and configuring the subscription products
themselves, and TestFlight management.

**The one thing App Manager cannot do**: generate the In-App Purchase key
that Section 4's server-side purchase verification actually needs. Apple's
own App Store Connect Help states this plainly: "Required role: Account
Holder or Admin." This is a different, more specific credential than a
general App Store Connect API key (which several roles, App Manager
included, can generate for build/metadata management), and it's easy to
conflate the two, which is what the first draft of this document did.
Since the Founder doesn't want to grant Admin access solely so Henry can generate
one key, the plan is: she generates the In-App Purchase key herself
(Account Holder can always do what Admin can), then hands Henry the key
file plus its issuer ID and key ID, the three values `verifyApplePurchase`
actually needs, without granting any broader account access. Everything
else in Section 2/3/4 remains App Manager-level work.

**Google, minimum permissions**: Play Console's permission model is
granular per-app. What's actually needed is "View app information" +
"Manage store presence" is not required, but "View financial data" *is*
needed specifically for verifying subscription purchases via the Play
Developer API (the API that validates a purchase token requires the calling
service account to have been granted access at the app level with at least
"View financial data, orders, and cancellation survey responses"; there
isn't currently a finer-grained permission that excludes financial data but
still allows purchase verification, since a purchase token's validation
response includes price/payment state, which Google classifies under that
permission). What is *not* needed: "Manage orders and subscriptions"
(refund-issuing capability) or "Admin" account-level access. The service
account should be scoped to just this one app, not the whole Play Console
account, and just the one permission above, not broader financial/account
access.