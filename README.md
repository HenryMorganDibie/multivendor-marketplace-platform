# the platform Backend

Firebase backend for the the platform multi-vendor marketplace. This repository covers four completed milestones: Auth/Users/Vendors/Verification, Catalog/Orders/Inventory/Payments/Receipts, Commerce Chat/Notifications/Blocks/Pickup Auto-Send/Support Tickets/AI Help Placeholder/Chat Moderation, and Vendor Subscriptions/Plan Gating/Ratings/Invoices.

## Status

Status is described precisely rather than as a blanket "complete." Every row below reflects what has actually been run and verified, not what is assumed to work.

| Area | Status |
|---|---|
| **Milestone 1** — Auth, users, vendors, verification, admin, security rules | 67/67 acceptance tests passing in developer environment |
| **Milestone 2** — Catalog, cart pricing, orders, inventory, payment proofs, receipts | 61/61 acceptance tests passing in developer environment |
| **Milestone 3** — Commerce chat, notifications, blocks, pickup auto-send, support tickets, AI help placeholder, chat moderation | 130/130 acceptance tests passing in developer environment |
| **Milestone 4** — Vendor subscriptions (Paystack + Flutterwave for Nigeria, Stripe international), full plan-gating matrix, ratings, invoices/branding/PDF | 94/94 acceptance tests passing in developer environment |
| App Check | Implemented in **monitor mode only** (see App Check Rollout below). Not yet enforced. |
| Frontend integration contracts | See `docs/frontend-contracts.md`, covering all four milestones |
| Production monitoring/alerting | Structured operational logging exists (`functions/src/utils/operationalLogging.ts`), with documented Cloud Monitoring alert filter conditions in that file's comments. Dashboards and the alerting policies themselves are not yet provisioned — that is Google Cloud console configuration outside this codebase, not application code |
| Independent security audit | Not yet performed — see the Security Posture section below for an honest account of what has and has not been verified |

"Acceptance tests passing in developer environment" means: run against the local Firebase Emulator Suite, on this developer's machine, as of the date of the corresponding test run. It is not a substitute for independent review, staging deployment, or production verification.

## Running the acceptance tests

```bash
cd functions
npm install
npm run build
cd ..
firebase emulators:start --only auth,firestore,functions,storage --project demo-the platform
```

In a second terminal:

```bash
cd scripts
npm install
node milestone1-acceptance-tests.js
node milestone2-acceptance-tests.js
node milestone3-acceptance-tests.js
node milestone4-acceptance-tests.js
```

The Storage emulator is required for all four suites. Milestone 1 exercises real file upload tests against Storage security rules (MIME allowlist, size limits, ownership, admin-only raw read). Milestones 2-4 use it for verification document setup during test provisioning; Milestone 4 additionally uses it for invoice branding logo upload validation.

Each suite provisions its own test accounts and vendor with a timestamped, unique identifier, so the four suites can be run independently and repeatedly without collisions. Milestone 4's webhook-related tests additionally generate a per-run identifier (`RUN_ID`) baked into every simulated Paystack event ID, so re-running the suite against an already-live (not restarted) emulator never false-triggers idempotency dedup from a prior run.

## What each milestone covers

**Milestone 1** establishes identity and access: Firebase Auth with custom claims for `customer` / `vendor` / `admin` roles, vendor registration and the verification submission flow, a five-tier admin role system (`super_admin`, `verification_admin`, `support_admin`, `safety_admin`, `read_only_admin`), and the Firestore and Storage security rules that everything else depends on.

**Milestone 2** builds commerce on top of that identity layer: vendor catalog management with server-enforced plan limits, cart pricing that the backend computes authoritatively rather than trusting the client, the full order lifecycle from placement through completion, a 48-hour vendor acceptance SLA, payment proof submission with abuse limits, and receipt generation.

**Milestone 3** adds real-time communication and customer support capabilities: a single persistent commerce thread per customer/vendor pair (not per order — new orders inject context into the existing thread), in-app and push notifications with quiethours and critical-notification handling, a block system with a documented active-order exception, fully automatic pickup-details delivery with no manual send path anywhere in the system, support ticket workflows, an AI-help placeholder surface intended for future assistant integration, and a rule-based chat moderation layer (below) that flags rather than aggressively hard-bans.

**Milestone 4** adds vendor monetization: a provider-agnostic subscription engine — live on Paystack and Flutterwave for Nigeria, and Stripe for international vendors — where Firestore is the single source of truth and no application layer ever reads a payment provider's API directly, a full plan-gating matrix enforced server-side across catalog limits, external orders, pickup automation, vendor settings, dashboard widgets, and business analytics, a ratings system with strict vendor-side anonymity (a vendor never learns which order or customer a rating came from), and invoices with plan-gated branding and PDF generation. See the dedicated sections below for the architectural decisions behind each.

Full request/response contracts for every callable across all four milestones are in `docs/frontend-contracts.md`.

## App Check Rollout

App Check is implemented as a monitor-mode helper (`functions/src/utils/appCheck.ts`) that records whether a valid App Check token was present on every sensitive callable, without blocking requests, controlled by the `APP_CHECK_ENFORCE` environment variable.

Planned rollout:

- **dev**: monitor mode only. App Check status is logged and recorded in audit logs; no requests are blocked.
- **staging**: monitor mode initially, switched to enforcement once the mobile app and Admin Web Portal both have App Check providers registered and have been confirmed sending valid tokens in real traffic.
- **production**: enforcement (`APP_CHECK_ENFORCE=true`) only after staging enforcement has run cleanly for a defined soak period with no unexpected rejections.

This sequencing exists to avoid a scenario where enabling enforcement before the frontend is ready locks out legitimate users. This remains an open item and should be treated as a prerequisite for general availability, not an optional hardening step.

## Verification document storage path

Canonical path, used consistently across Storage rules, the `recordVerificationDocument` callable, and the acceptance tests:

```
verificationDocuments/{vendorId}/{docId}
```

Vendor owners may upload (PDF or image, 15 MB max) but cannot read raw files back. Only admins can read uploaded verification documents directly; vendors see document metadata via Firestore (`vendorVerification/{vendorId}/documents/{docId}`).

## Contact card architecture (Milestone 3 decision)

Customer contact cards are stored on-device only, not in Firestore. There is no `users/{uid}/contactCards` collection in this backend. When a customer wants a vendor to have delivery contact details for a specific order, the frontend submits those details inline through `submitDeliveryContact`, which attaches an immutable, order-scoped snapshot to that one order. This snapshot cannot be resubmitted or edited once set, and a vendor's access to it expires automatically once the order reaches a terminal status, enforced through the `getOrderDetails` callable rather than raw Firestore reads. See `docs/frontend-contracts-phase-1.md` for the full contract.

This was a deliberate minimal-data-collection decision: it removes an entire class of PII exposure risk from the backend at the cost of contact details not syncing across a customer's devices, a tradeoff considered acceptable for the current stage of the product.

## Chat moderation (P3-FB-021)

A rule-based moderation engine runs inside `sendChatMessage`, `updateVendorChatSettings`, the quick-reply callables, and `createCatalogItem`/`updateCatalogItem` before anything is saved. It is deliberately a **flagging system first, not an aggressive hard-ban system** for chat: the platform does not process in-app payments in MVP, so ordinary commerce phrases like "bank transfer" or "call me" are never flagged on their own — they only count as evidence when they co-occur with a genuine off-platform-avoidance phrase such as "pay outside the platform" or "DM for price" in the same message. Catalog listings are held to a stricter standard than chat: a prohibited-item match in a listing's name/description always blocks the write outright, since there is no ambiguous "context" for a firearm or drug listing the way there can be for a chat message.

Rules are backend-managed config in the `moderationRules` Firestore collection (admin-only read, never client-writable), not hardcoded pattern lists baked into a function, and are bootstrapped via the idempotent `seedDefaultModerationRules` callable (`super_admin` only). Beyond keyword/phrase matching, several rules are regex-based to catch PII and off-platform contact patterns (phone numbers, emails, `wa.me`/`t.me` links, bare URLs, `@handles`) — these never block on their own but weigh into a cumulative per-user trust score. That score escalates a user's `accountStatus` (reusing the same enum every other access check already respects) to `frozen` at 50 points and `banned` at 100, transactionally, so concurrent flagged messages can't race past a threshold uncounted — escalation never reverses itself automatically; only `reviewModerationRestriction` (`super_admin`/`safety_admin`) can clear it or confirm the ban after human review. Every match also writes a `moderationEvents` record (hash + redacted snippet only, never the raw message) and, for chat, contributes to a per-thread `riskScore`. See `docs/frontend-contracts.md` for the exact error shapes and severity/action table.

## Vendor subscriptions & plan gating (Milestone 4)

The mobile app, admin dashboard, and vendor portal read subscription status exclusively from Firestore — no application layer reads from any payment provider API. `resolveEffectivePlan` is the single function every gated callable reads `PlanLimits` from; nothing gates off a hardcoded constant or a legacy field directly. Provider plan codes live in a separate, fully private `providerPlanCodes` collection (`allow read, write: if false` — Cloud Functions only, via the Admin SDK), completely isolated from the publicly readable `subscriptionPlans` document so a vendor-facing pricing page can never leak them.

**Three payment providers are live: Paystack and Flutterwave for Nigeria (redundant by design — a Paystack account issue is never a single point of failure for the whole business), and Stripe for international vendors.** All three converge on the exact same subscription state machine: `subscriptionWebhookCore.ts` holds the one implementation of staleness rejection, idempotency, distributed locking, out-of-order/priority resolution, and the `vendorSubscriptions` mutation itself — shared verbatim across `paystackWebhook.ts`, `flutterwaveWebhook.ts`, and `stripeWebhook.ts`. Each provider file's only job is verifying that provider's own signature scheme and mapping its payload shape into one normalized event object before handing it to the shared core. This is the literal "Provider Abstraction Contract" the source spec calls for (Section 9): adding a provider means one new webhook handler, one new checkout callable (`createFlutterwaveCheckout`, `createStripeCheckout`), and new fields on `providerPlanCodes/{planId}` — zero changes to `vendorSubscriptions`, `resolveEffectivePlan`, `PlanLimits`, or any plan-enforcement logic.

The three providers authenticate their webhooks completely differently, each handled correctly in its own file: Paystack and Stripe both use HMAC (SHA-512 and SHA-256 respectively, the latter also timestamp-tolerance-checked as Stripe's own replay-protection layer on top of this codebase's generic 24-hour staleness check); Flutterwave uses a static secret-hash string compared directly rather than computed, which is its documented scheme, not a corner cut here. Every path still gets the same before-any-Firestore-access ordering and the same out-of-order protection via an event-priority table plus timestamp sequencing — an event only applies if it's higher priority than the last-applied event, or equal priority with a later sequence number. That guard resets whenever an activation event carries a different provider subscription ID than what's on file, so a vendor who cancels (or migrates providers) can still resubscribe later — without that reset, a cancellation (the highest-priority event in the table) would permanently block every future activation webhook from ever being accepted again, a real bug caught and fixed by the acceptance tests before this was generalized from Paystack-only to all three providers.

**Deliberate deviation from the written spec**, documented in `functions/src/types4.ts`: vendor suspension reuses the existing Phase 1 `vendors/{id}.vendorStatus` field rather than a duplicate `suspendedAt` field on `vendorSubscriptions`, avoiding two sources of truth for the same fact. `resolveEffectivePlan` checks `vendorStatus` first, ahead of admin override and subscription status, exactly matching the spec's intended priority order.

Rate limiting (5 requests/60s, scoped per vendor per function) applies to every billing-sensitive vendor callable: `createSubscriptionCheckout`, `createFlutterwaveCheckout`, `createStripeCheckout`, `cancelSubscription`, `reactivateSubscription`, `updateInvoiceBranding`. Admin actions (`cancelSubscriptionAdmin`, `applyManualSubscriptionOverride`) are not rate-limited but require a mandatory `reason` field and write a full before/after audit trail to `subscriptionEvents`, an immutable append-only log of every processed *and* ignored webhook event, tagged with which of the three providers sent it.

## Ratings & invoices (Milestone 4)

**Ratings** are star-only with an optional private feedback field, submitted once per completed order via `submitRating` and final upon submission — there is no customer-facing edit or delete path. The privacy model is strict: a vendor never receives `orderId`, `customerId`, or any order reference in any response, query, or export. The only identifier a vendor ever sees is a separately and randomly generated `displayId` (e.g. `R-K8F2M7`), not derived from any other identifier. This is enforced structurally, not just by convention — direct Firestore reads of `ratings` are denied to the vendor role entirely in `firestore.rules`, so the only way a vendor can read their own ratings at all is through `getVendorRatings`, a callable that projects the response shape server-side. `moderateRating` (admin-only) can hide or remove an abusive rating but never deletes the document, preserving a full audit trail and excluding it from `vendorRatingStats` recomputation going forward.

**Invoices** compute line-item totals server-side (a client-supplied total is never trusted), are gated by a monthly quota (`invoicesPerMonth`) tracked via a per-vendor-per-UTC-calendar-month counter sub-document — explicitly the UTC boundary, not the vendor's local timezone, to remove reset-logic ambiguity. Invoice branding (logo, brand color, thank-you message, footer, premium templates, QR code, print layout) is validated field-by-field against the vendor's plan before any write, with the logo checked against the real uploaded Storage object's content-type and size rather than trusting client-declared metadata. Marking an invoice paid captures a permanent `brandingSnapshot`, filtered through whatever plan was active at that exact instant — a later downgrade can never mutate a paid invoice's branding, matching the spec's explicit guarantee. `invoiceHistoryDays` governs `listInvoices` visibility only (`hiddenFromHistory`, flipped by a daily scheduled job), never a hard deletion deadline — paid invoices are financial records and are never automatically destroyed. Public "Share Invoice" links are served through `getPublicInvoice`, a callable rather than a direct Firestore query, since a raw client query by share token would let anyone enumerate the field and brute-force tokens against an open collection; the callable also revokes a cancelled invoice's public visibility before returning anything. PDF generation uses `pdfkit` (pure Node, no headless browser), a deliberate choice to avoid a full Chromium process's memory footprint in a Cloud Function for what's fundamentally a structured document.

## Security posture

No system should be described as fully secure without qualification, and this backend is not an exception. The following reflects an honest account of what has been verified against and what remains open.

**What has been verified:** every Firestore collection carrying business-critical or sensitive data denies direct client writes and routes exclusively through Cloud Functions. Sensitive fields use narrow, allowlisted update rules rather than broad ownership checks — a user can mark their own notification read but cannot rewrite its title or body, for example. Authentication is delegated entirely to Firebase Auth rather than a custom credential store. Server-side business logic (block enforcement, country availability, order-state transitions) is re-validated on every relevant call rather than trusted from client state. All 352 acceptance tests across the four milestones include denial-path cases, not just success-path cases.

**What remains open:** App Check enforcement, as described above, is not yet active. No independent, adversarial security audit has been performed on the deployed rules and Cloud Functions — everything here has passed rigorous self-review and automated testing, which is not equivalent to a third party whose sole objective is finding a way through it. One historical bug (a Firestore rules wildcard that unintentionally granted broader write access than intended to a subset of Milestone 3 settings documents) was found and fixed during Milestone 3 development; this raises the possibility, not yet ruled out, that a similar latent rule collision exists elsewhere in `firestore.rules`. A full manual pass through every `match` block, specifically checking for cases where a general wildcard and a more specific match both apply to the same path, is recommended before production launch. Request-size and payload-complexity limits are not uniformly enforced across every callable, which is a resource-exhaustion consideration even where it is not a data-integrity risk.

The two highest-priority items before general availability are App Check enforcement and an independent review of the Firestore rules file.

## Location data & subscription pricing (scaffolding, not a milestone)

Two data-only folders live at the repo root, separate from `functions/src/` because neither is application code — both are static seed data meant for one-time (or occasional) import into Firestore, not something bundled into the Cloud Functions deploy.

**`location-data/`** — the canonical Country/State/Area catalogue, governed by `location-data/THE PLATFORM LOCATION SPEC v1.5.md`. Current state: all 196 countries have a `countries.json` entry; **59 of those 196** additionally have complete, validated state and area data (1,304 states, 1,304 locations) — the rest are still being populated. `npm run validate:locations` and `npm run import:locations` (in `scripts/`) are implemented and tested against the local emulator; nothing has been imported into a real Firestore project yet. See `location-data/README.md` and `location-data/docs/Country Checklist.md` for per-country progress.

**`subscription-pricing/`** — per-country subscription pricing, **schema locked and fully wired into checkout, real numbers still pending.** This resolved what used to be three disagreeing draft pricing sources (see `subscription-pricing/README.md`'s History section). Two files, two Firestore collections: `pricing.json` → `subscriptionPricing/{countryCode}` (public read, integer minor-currency-unit amounts, no founder pricing) and `providerPlanMapping.json` → `providerPlanMapping/{countryCode}-{planId}` (Admin SDK only). `npm run validate:pricing` / `npm run import:pricing` exist and follow the same idempotent pattern as the location scripts. `createSubscriptionCheckout`, `createFlutterwaveCheckout`, and `createStripeCheckout` all now read a vendor's country from `vendors/{vendorId}.countryCode` and **hard-fail with `failed-precondition` if that country has no active pricing record** — never a silent fallback to NGN or currency conversion. Both seed files are intentionally still empty (`[]`): the schema is decided, but nobody has entered real prices or real provider plan IDs yet, and this deliberately doesn't guess at either.

## Known gaps / explicitly deferred

- Production monitoring dashboards and alerting are not part of this code delivery.
- App Check enforcement is deferred per the rollout plan above.
- Admin MFA enrollment UI is not part of this milestone (the `adminUsers` schema reserves fields for it; enrollment flow is a later phase).
- Country availability management is currently manual (a single document seeded directly in Firestore for Nigeria). Full admin tooling for managing country rollout is deferred to a later phase.
- Typing indicators and swipe-to-reply are not implemented in this milestone. Typing indicators would require provisioning Firebase Realtime Database alongside Firestore, since that is a better fit for high-frequency, ephemeral presence data than Firestore's per-document billing model. Swipe-to-reply is primarily a frontend gesture-handling concern; the backend would need a small, additive extension to the message schema to carry a reply reference.
- A moderation admin review queue UI/tooling is not part of this milestone. The backend produces everything a queue would need (`moderationEvents`, per-thread `riskScore`), but building admin-facing screens to act on them is Phase 5 scope.
- The following Milestone 4 items are explicitly deferred to post-launch, per the source spec's own scope table, not oversights: a subscription monitoring dashboard (active/past-due/grace-period/churn metrics), a disaster recovery runbook, a dedicated `subscriptionHistory` collection distinct from the append-only `subscriptionEvents` audit log, and an in-memory/Firestore-level cache for `resolveEffectivePlan` (deliberately uncached for now — a plan change or admin override is a rare action, not a hot path, and a per-process cache would reintroduce the exact cross-instance staleness bug already found and fixed in the moderation engine).
- Late-payment-after-expiry restoration (`handlePaystackWebhook`) uses a simplified rule: any signature-verified activation/renewal webhook restores an expired subscription to active. The stricter spec behavior — re-verifying against Paystack's own subscription-status API before restoring — is not yet implemented.
- AI Replies, AI Insights, Promotions, and Auto-Accept-Orders all have their `PlanLimits` fields reserved and returned correctly today, but the underlying features themselves (an AI reply engine, a promotions system, automated order acceptance) do not exist yet — those are future-phase scope per the source spec's own table. Only the *gate*, not the *feature*, is Milestone 4 work.
- Dashboard/analytics data computation (`getVendorDashboard`, `getBusinessAnalytics`) returns real data from actual order records where feasible today; any metric the spec itself defers to a future phase is marked explicitly rather than faked.