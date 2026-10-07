# Multi-Vendor Marketplace Platform — Backend & Web

A Firebase backend for a multi-vendor marketplace (location-based discovery for small businesses — food, fashion, beauty, electronics, and more), plus the Next.js frontend that consumes it: a public marketing site, a lightweight CMS, and a vendor-facing web portal. Built solo, end to end — Cloud Functions, Firestore security rules, the subscription/billing engine, real-time chat, and the frontends that sit on top of all of it.

This README documents what's actually built and verified, not what's assumed to work. Every status line reflects a real test run or a real deploy, and gaps are called out explicitly rather than glossed over — that distinction mattered enough during development that it's worth keeping visible here.

---

## Status

| Area | Status |
|---|---|
| **Auth, vendors, verification, admin, security rules** | 67/67 tests passing against the local emulator |
| **Catalog, cart pricing, orders, inventory, payment proofs, receipts** | 60/60 tests passing against the local emulator |
| **Commerce chat, notifications, blocks, pickup auto-send, support tickets, chat moderation** | 131/131 tests passing against the local emulator |
| **Vendor subscriptions (Paystack, Flutterwave, Stripe), plan-gating matrix, ratings, invoices** | 109/109 tests passing against the local emulator, including a full end-to-end vendor-journey walkthrough |
| **Public site, CMS, and vendor portal** — provider-neutral checkout, subscription offerings, invoice/receipt renumbering, price-change policy | 32/32 tests passing against the local emulator |
| **Vendor registration & onboarding** — progressive onboarding, legal consent versioning | 11/11 tests passing |
| **Catalog moderation** — approved-live plus pending-revision | 20/20 tests passing |
| **Location catalogue** — `listCountries`/`listStates`/`listAreas`, registration validation | 12/12 tests passing. 196 countries, replacing 17 that used to be hardcoded in the app |
| **Sales counting** — completed orders only, quantity not order count | 6/6 tests passing |
| **Rate limiting** — 14 write callables across chat, orders, invoices, support, catalog, blocks | 7/7 tests passing |
| **Registration recovery** — resumable registration, daily orphan sweep, admin cleanup | 10/10 tests passing |
| **Orders wiring** — the mobile app's order lifecycle running through the backend, not local state | 11/11 tests passing |
| **Vendor discovery** — customer-facing listing reading real vendors | 8/8 tests passing |
| **Country availability** — as a condition of discoverability, not only of ordering | 7/7 tests passing |
| Order/verification notifications | Deployed. Covered by manual verification, no dedicated suite yet |
| Malware scanning on uploads | Deployed — a Cloud Run service running ClamAV, triggered on every user-supplied file write |
| **Frontend** (`website/` and `vendor-portal/`) | Built, typechecked, production-build-verified (26/26 routes). Deployed to Firebase Hosting dev environments (landing site and vendor portal); production domains not yet live |
| Payment requests & payment instructions | Deployed. Manually verified end to end, including a security fix that moved payment data off a publicly-readable document |
| Admin MFA enrollment & enforcement backend | Built and deployed; enforcement held behind a flag pending an enrollment UI |
| Apple & Google in-app subscriptions | Scaffolded against the same provider abstraction as the three live providers, not yet exercisable end to end (needs real App Store Connect / Play Console setup) |
| App Check | Implemented in monitor mode only, not yet enforced |
| Independent security audit | Not yet performed — see Security posture below |

"Tests passing against the local emulator" means exactly that: run against the Firebase Emulator Suite on this machine, as of the date of the corresponding run. Not a substitute for staging or production verification.

## Running the tests

```bash
cd functions
npm install
npm run build
cd ..
firebase emulators:start --only auth,firestore,functions,storage --project demo-platform
```

In a second terminal:

```bash
cd scripts
npm install
node milestone1-acceptance-tests.js
node milestone2-acceptance-tests.js
node milestone3-acceptance-tests.js
node milestone4-acceptance-tests.js
node landing-page-cms-vendor-portal-acceptance-tests.js

# Everything built after the first four phases
node phase1-acceptance-tests.js        # registration and onboarding
node phase2-acceptance-tests.js        # catalog moderation
node location-endpoint-tests.js        # the location catalogue
node sales-counting-tests.js           # what counts as a sale
node rate-limit-tests.js               # write endpoint ceilings
node orphan-recovery-tests.js          # half-finished registrations
node orders-wiring-tests.js            # the order lifecycle end to end
node vendor-discovery-tests.js         # customer-facing vendor listing
node country-availability-tests.js     # availability reaching discovery
```

The Storage emulator is required for all suites — real file-upload tests run against Storage security rules (MIME allowlist, size limits, ownership, admin-only raw read). Each suite provisions its own timestamped test accounts, so they can all run independently and repeatedly without collisions. The subscription webhook tests generate a per-run identifier baked into every simulated payment-provider event, so re-running against an already-live emulator never false-triggers idempotency dedup from a prior run.

## Architecture & design decisions

### Identity & access

Firebase Auth with custom claims for `customer`/`vendor`/`admin` roles, vendor registration and verification submission, a five-tier admin role system (`super_admin`, `verification_admin`, `support_admin`, `safety_admin`, `read_only_admin`), and the Firestore/Storage security rules everything else depends on.

Registration is resumable rather than a dead end. It spans several writes, and the original `completeRegistration` rejected every retry as "already finalized" — a failure between assigning the role and writing the vendor record left an account holding a vendor role with no vendor record, unable to finish or restart, its email permanently occupied. Now: a finished account returns its existing record, a half-made one is completed, a daily sweep removes accounts that never came back after a 24-hour grace period, and an admin callable can free a specific address immediately.

### Commerce: catalog, cart, orders

Vendor catalog management with server-enforced plan limits, cart pricing the backend computes authoritatively (never trusting a client-supplied total), the full order lifecycle from placement through completion, a 48-hour vendor acceptance SLA, payment-proof submission with abuse limits, and receipt generation.

Placing an order is two calls, deliberately: `repriceCart` prices the basket against the live catalogue and persists it, then `createOrderFromCart` turns that priced cart into an order — there's no path that accepts a client-supplied total, because a total that arrived from a device is a suggestion, not a price. Order creation is also idempotent: the order document is keyed deterministically by `cartId`, so a lost-response retry or a genuine concurrent double-submit can't create two real orders from one cart.

Catalog moderation is approved-live plus pending-revision: editing a live item doesn't take it offline — customers keep seeing the approved version while a change is reviewed, and a rejected edit leaves the approved version untouched. Availability and stock apply immediately without review, since holding those for moderation would mean a vendor can't mark something sold out.

Country availability is a condition of *discoverability*, not just of being able to order — it used to only be checked at order/conversation creation, while a separate `isDiscoverable` flag came from publication and verification alone. That meant closing a country shut the front door and left the back one open: vendors there stayed listed and browsable, and a customer could fill a basket before being refused at checkout. Country is now one of four conditions computed in both the vendor's own write trigger and the sweep that runs on a country-availability change, so the two can't disagree.

### Real-time chat & moderation

A single persistent commerce thread per customer/vendor pair — not per order, so a new order injects context into the existing thread rather than starting a new one. In-app and push notifications with quiet-hours and critical-notification handling, a block system with a documented active-order exception, fully automatic pickup-details delivery, support ticket workflows, and a rule-based moderation layer.

The moderation engine is deliberately a flagging system first, not an aggressive hard-ban system, for chat: since the platform doesn't process in-app payments, ordinary commerce phrases like "bank transfer" are never flagged on their own — they only count as evidence alongside a genuine off-platform-avoidance phrase in the same message. Catalog listings are held to a stricter standard, since there's no ambiguous "context" for a prohibited-item match the way there can be for a chat message. Rules live in Firestore as backend-managed config (never client-writable), and beyond keyword matching, several are regex-based to catch PII and off-platform contact patterns, weighing into a cumulative per-user trust score that escalates account status transactionally — so concurrent flagged messages can't race past a threshold uncounted.

### Vendor subscriptions & multi-provider billing

The mobile app, admin dashboard, and vendor portal all read subscription status exclusively from Firestore — no application layer ever calls a payment provider's API directly to check status. One function (`resolveEffectivePlan`) is the sole source every gated callable reads plan limits from.

Three payment providers are live — Paystack, Flutterwave, and Stripe — and all three converge on the exact same subscription state machine: one shared implementation of staleness rejection, idempotency, distributed locking, and out-of-order-event resolution, with each provider's own file responsible only for verifying that provider's signature scheme and normalizing its payload before handing off. Provider selection isn't a frontend concern at all: a single `createSubscriptionCheckout({ plan })` callable resolves the vendor's country server-side and picks a provider from a private, country-specific priority list. Adding a new provider to a country means one new webhook handler plus a mapping entry — zero frontend changes.

The three providers authenticate completely differently (HMAC for two, a static secret-hash comparison for the third, per that provider's own documented scheme) but every path gets the same ordering guarantee: an event only applies if it's higher priority than the last-applied event, or equal priority with a later sequence number, which is what stops a stale, out-of-order webhook from ever winning a race against a newer one.

### Ratings & invoicing

Ratings are star-only with an optional private feedback field, final upon submission. The privacy model is structural, not just conventional: a vendor never receives an order or customer reference in any response, and direct Firestore reads of the ratings collection are denied to the vendor role entirely in the security rules — the only way a vendor can read their own ratings at all is through a callable that projects the response shape server-side.

Invoices compute totals server-side, are gated by a monthly quota tracked per UTC calendar month (the UTC boundary specifically, to remove reset-logic ambiguity across timezones), and validate branding assets against the vendor's plan before any write — a logo is checked against the real uploaded file's content type and size, not trusted client-declared metadata. Marking an invoice paid captures a permanent branding snapshot filtered through whatever plan was active at that instant, so a later plan downgrade can never retroactively change a paid invoice's appearance.

### Payment requests & payment instructions

A vendor sends a payment request through the order's chat thread, naming an amount (validated against the order's real total) while everything else — customer identity, which payment instructions to show — is assembled server-side, never trusted from the client. Any prior still-active request for the same order is automatically superseded, so a customer only ever sees one live request at a time.

Deliberately no structured payment-method system (bank name/account-number/type fields) here — a single free-text instructions field, gated by an explicit ownership-confirmation attestation on first save, activating immediately with no admin-approval queue. The design choice: don't call an unverified method "approved" in the product when nothing has actually verified ownership of the account — "active" or "confirmed" is what's accurate, and a vendor who hasn't set one up should be told to before Send Payment Request lets them try, rather than the button silently doing nothing.

**Security fix:** payment instructions were originally written directly onto the public vendor document — readable by anyone browsing a discoverable storefront, no authentication required, since Firestore rules can't filter individual fields on a document read. Moved to a private, owner-and-admin-only subdocument, matching the pattern already used for other vendor settings. Verified post-fix that an unauthenticated read of the public document no longer contains the field, and the full send-request flow still works exactly as before for the vendor.

### Promotions

A vendor manages promotions through create/update/delete/toggle callables; evaluation runs at checkout time as part of the same trusted server-side pricing path cart repricing already owns, rather than trusting a client-supplied discount.

### Apple & Google in-app purchases (scaffolded)

Structurally complete against the same provider-abstraction contract as the three live payment providers, but not exercisable end to end without real store-side setup (App Store Connect products, a Play Console service account).

Apple's integration verifies transactions directly against Apple's own signature-chain machinery rather than trusting the client, mints a real UUID token per vendor (StoreKit requires this — an internal database ID isn't a valid format), and tries the sandbox verifier before production so sandbox testing and a live listing can coexist. Google's mirrors that structure with one simplification (no UUID requirement, so the internal vendor ID is used directly) and fixed two real correctness bugs before ever touching live traffic: a "canceled" notification means auto-renew was turned off, not that access was lost — mapping it to a hard cancellation would have cut off a vendor mid-period they'd already paid for — and the provider reuses the same purchase token across an entire subscription's renewals, so idempotency had to key on the delivery ID instead.

### Admin MFA

TOTP-based enrollment and verification, with the secret stored in a Cloud-Function-only collection an admin console can never read directly. Enforcement is deliberately held behind a feature flag: every admin account already requires MFA in the schema, but none has actually enrolled yet, since no admin UI has ever called the enrollment flow — flipping enforcement on before that UI exists would lock every admin out with no way back in except a manual database edit.

### Location catalogue & subscription pricing

Two data-only folders at the repo root, kept separate from application code since both are one-time (or occasional) seed data for Firestore import, not something bundled into the deploy.

`location-data/` is the canonical country/state/area catalogue — all 196 countries have an entry, with roughly a third of those additionally having complete, validated state/area data. `subscription-pricing/` holds per-country subscription pricing with the schema fully wired into checkout — a vendor's checkout hard-fails with a clear precondition error if their country has no active pricing record, rather than silently falling back to a default currency.

## Security posture

No system should be described as fully secure without qualification, and this one isn't an exception.

**Verified:** every Firestore collection carrying business-critical or sensitive data denies direct client writes and routes exclusively through Cloud Functions. Sensitive fields use narrow, allowlisted update rules rather than broad ownership checks. Server-side business logic (block enforcement, country availability, order-state transitions) is re-validated on every relevant call, never trusted from client state. All 390-plus tests across the full suite include denial-path cases, not just success paths.

**Open:** App Check enforcement isn't active yet. No independent, adversarial security audit has been performed — everything here has passed rigorous self-review and automated testing, which is a different thing from a third party whose sole objective is finding a way through it.

**A pattern worth naming.** Two real defects, found in separate review passes, turned out to be the same underlying mistake: bespoke logic written where a house pattern already existed. One rules helper was a denylist rather than an allowlist, and a newer field (`countryCode`) simply wasn't added to it — once country availability became a condition of discoverability, that gap let a vendor hidden by a closed country write themselves back into an open one and evade the closure sweep entirely. Separately, one admin callable checked a role claim directly instead of calling the shared `assertAdmin()` helper every other admin function uses — which matters because revoking an admin's access can't revoke an already-issued token, and the shared helper is what re-checks live status on every call to close that window; this one callable didn't. Neither bug was subtle once found, and neither would have existed had the established helper been used instead of reimplemented. That's the actual review heuristic worth keeping: when reading new code in a codebase like this, check first whether it's quietly reimplementing something that already has a correct, shared implementation elsewhere.

The three highest-priority items before any real launch: App Check enforcement, an independent review of the Firestore rules file, and converting the remaining denylist-style update rules to allowlists.

## Known gaps / not yet built

- Production monitoring dashboards and alerting aren't part of this repo — structured logging exists, but dashboards/alert policies are cloud-console configuration, not application code.
- App Check enforcement is implemented but not turned on.
- Admin MFA enforcement is built but gated off pending an enrollment UI (see above).
- Country availability management is currently a single manually-seeded document; admin tooling for managing rollout is a later phase.
- Typing indicators and swipe-to-reply chat features aren't implemented.
- A moderation review-queue UI doesn't exist yet — the backend produces everything a queue would need, but the admin screens to act on it are unbuilt.
- A structured vendor payment-method system (bank/cash type selection, an approval workflow, change history) is unbuilt — see Payment requests above for what exists instead.
- Apple/Google in-app subscription sync is scaffolded but not live, blocked on real store-side product setup rather than a code gap.
- Several `PlanLimits` fields (AI replies, AI insights, auto-accept-orders) are reserved and gate correctly today, but the underlying features don't exist yet — only the gate is built.

## Frontend (`website/` and `vendor-portal/`)

Two Next.js apps: `website/` (public landing page and CMS editor) and `vendor-portal/` (vendor billing and subscriptions). See each folder's `README.md` for setup — in short, `npm install`, fill in a real Firebase Web App config, `npm run dev`. Both are deployed to Firebase Hosting dev environments; production domains are not yet live.
