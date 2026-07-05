# the platform Backend

Firebase backend for the the platform multi-vendor marketplace. This repository covers three completed milestones: Auth/Users/Vendors/Verification, Catalog/Orders/Inventory/Payments/Receipts, and Commerce Chat/Notifications/Blocks/Pickup Auto-Send/Support Tickets/AI Help Placeholder/Chat Moderation.

## Status

Status is described precisely rather than as a blanket "complete." Every row below reflects what has actually been run and verified, not what is assumed to work.

| Area | Status |
|---|---|
| **Milestone 1** — Auth, users, vendors, verification, admin, security rules | 67/67 acceptance tests passing in developer environment |
| **Milestone 2** — Catalog, cart pricing, orders, inventory, payment proofs, receipts | 61/61 acceptance tests passing in developer environment |
| **Milestone 3** — Commerce chat, notifications, blocks, pickup auto-send, support tickets, AI help placeholder, chat moderation | 130/130 acceptance tests passing in developer environment |
| App Check | Implemented in **monitor mode only** (see App Check Rollout below). Not yet enforced. |
| Frontend integration contracts | See `docs/frontend-contracts.md`, covering all three milestones |
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
```

The Storage emulator is required for all three suites. Milestone 1 exercises real file upload tests against Storage security rules (MIME allowlist, size limits, ownership, admin-only raw read). Milestone 2 and 3 use it for verification document setup during test provisioning.

Each suite provisions its own test accounts and vendor with a timestamped, unique identifier, so the three suites can be run independently and repeatedly without collisions.

## What each milestone covers

**Milestone 1** establishes identity and access: Firebase Auth with custom claims for `customer` / `vendor` / `admin` roles, vendor registration and the verification submission flow, a five-tier admin role system (`super_admin`, `verification_admin`, `support_admin`, `safety_admin`, `read_only_admin`), and the Firestore and Storage security rules that everything else depends on.

**Milestone 2** builds commerce on top of that identity layer: vendor catalog management with server-enforced plan limits, cart pricing that the backend computes authoritatively rather than trusting the client, the full order lifecycle from placement through completion, a 48-hour vendor acceptance SLA, payment proof submission with abuse limits, and receipt generation.

**Milestone 3** adds real-time communication and customer support capabilities: a single persistent commerce thread per customer/vendor pair (not per order — new orders inject context into the existing thread), in-app and push notifications with quiethours and critical-notification handling, a block system with a documented active-order exception, fully automatic pickup-details delivery with no manual send path anywhere in the system, support ticket workflows, an AI-help placeholder surface intended for future assistant integration, and a rule-based chat moderation layer (below) that flags rather than aggressively hard-bans.

Full request/response contracts for every callable across all three milestones are in `docs/frontend-contracts.md`.

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

## Security posture

No system should be described as fully secure without qualification, and this backend is not an exception. The following reflects an honest account of what has been verified against and what remains open.

**What has been verified:** every Firestore collection carrying business-critical or sensitive data denies direct client writes and routes exclusively through Cloud Functions. Sensitive fields use narrow, allowlisted update rules rather than broad ownership checks — a user can mark their own notification read but cannot rewrite its title or body, for example. Authentication is delegated entirely to Firebase Auth rather than a custom credential store. Server-side business logic (block enforcement, country availability, order-state transitions) is re-validated on every relevant call rather than trusted from client state. All 258 acceptance tests across the three milestones include denial-path cases, not just success-path cases.

**What remains open:** App Check enforcement, as described above, is not yet active. No independent, adversarial security audit has been performed on the deployed rules and Cloud Functions — everything here has passed rigorous self-review and automated testing, which is not equivalent to a third party whose sole objective is finding a way through it. One historical bug (a Firestore rules wildcard that unintentionally granted broader write access than intended to a subset of Milestone 3 settings documents) was found and fixed during Milestone 3 development; this raises the possibility, not yet ruled out, that a similar latent rule collision exists elsewhere in `firestore.rules`. A full manual pass through every `match` block, specifically checking for cases where a general wildcard and a more specific match both apply to the same path, is recommended before production launch. Request-size and payload-complexity limits are not uniformly enforced across every callable, which is a resource-exhaustion consideration even where it is not a data-integrity risk.

The two highest-priority items before general availability are App Check enforcement and an independent review of the Firestore rules file.

## Known gaps / explicitly deferred

- Production monitoring dashboards and alerting are not part of this code delivery.
- App Check enforcement is deferred per the rollout plan above.
- Admin MFA enrollment UI is not part of this milestone (the `adminUsers` schema reserves fields for it; enrollment flow is a later phase).
- Country availability management is currently manual (a single document seeded directly in Firestore for Nigeria). Full admin tooling for managing country rollout is deferred to a later phase.
- Typing indicators and swipe-to-reply are not implemented in this milestone. Typing indicators would require provisioning Firebase Realtime Database alongside Firestore, since that is a better fit for high-frequency, ephemeral presence data than Firestore's per-document billing model. Swipe-to-reply is primarily a frontend gesture-handling concern; the backend would need a small, additive extension to the message schema to carry a reply reference.
- A moderation admin review queue UI/tooling is not part of this milestone. The backend produces everything a queue would need (`moderationEvents`, per-thread `riskScore`), but building admin-facing screens to act on them is Phase 5 scope.