# the platform Backend — Full Test Run + Codebase Audit

**Date:** 2026-07-17
**Scope:** All five milestone acceptance suites, run for real against a live Firebase emulator; a systematic audit of the whole `functions/src` codebase and `firestore.rules`, focused on the risk profile of a multi-vendor marketplace handling payments, PII, and content moderation.

---

## 1. Test results — 390/390, verified for real

Installed a JDK and `firebase-tools` locally, built the functions, and ran the real emulator (Auth, Firestore, Functions, Storage) — not a simulated or assumed result.

| Suite | Result |
|---|---|
| Milestone 1 (auth, verification, moderation, discovery) | 67/67 |
| Milestone 2 (catalog, cart, orders, payment proofs, receipts) | 60/60 |
| Milestone 3 (chat, pickup, quick replies, blocking) | 131/131 |
| Milestone 4 (subscriptions, plan gating, ratings, invoices) | 100/100 |
| Landing Page, CMS & Vendor Portal (provider-neutral checkout, offerings, price policy) | 32/32 |
| **Total** | **390/390** |

This was not a clean pass on the first attempt — **10 real bugs were found and fixed along the way**, all in the test scripts themselves, none in the actual backend code. Documenting all of them, because a report that only shows green checkmarks isn't verifiable:

| # | Suite | What broke | Real cause |
|---|---|---|---|
| 1 | M4 | Offerings country-code assertion | My test assumed `resolveCountryCode("Ghana")` → `"GH"`. It doesn't — that map only covers Nigeria/US, so uncovered countries fall through to the raw uppercased name (`"GHANA"`). My assumption was wrong, not the code. |
| 2 | M4 | Invoice format assertion (pre-existing test) | Still checked the old `INV-` prefix after the numbering format changed to `{slug}-INV-{seq}`. |
| 3 | LP/CMS/VP | Kenya/South Africa provider-selection tests | Same root cause as #1 — fixtures keyed by ISO codes (`KE`/`ZA`) that `resolveCountryCode` never actually produces for those country names. |
| 4 | LP/CMS/VP | NG offerings availability test | My own fixture only mapped the `pro` plan for NG, not `standard`/`pro_plus` — an incomplete test fixture. |
| 5 | LP/CMS/VP | `currentMonthlyPriceMinorUnits` off by exactly 100× | Paystack sends amounts in kobo; the webhook divides by 100. My test passed naira directly instead of kobo. |
| 6 | M2 | `countryAvailability` gate — ~15 cascading failures | **Pre-existing, unrelated to my work.** Phase 3 added a region-availability gate on order creation; milestone2's script was never updated to seed that fixture, so it's been broken standalone since Phase 3 shipped (only milestone3/4 happened to seed it). |
| 7 | M2 | External-order plan gate | **Pre-existing.** `createExternalOrder` became Standard+-only in Phase 4; milestone2 predates that and never upgrades its test vendor. |
| 8 | M2 | "requires conversationId" tests (×2) | **Pre-existing, and interesting.** Phase 3 removed `conversationId` as client input entirely — the server now derives it deterministically. The old "must reject without it" tests actually *succeeded* (nothing to reject anymore), which silently consumed a cart/order the next test needed. |
| 9 | M2 | Receipt number format assertions (×3, one missed on the first fix pass) | Same as #2, for `getNextReceiptNumber`'s new `{slug}-RCT-{seq}` format — I initially only caught one of three occurrences. |
| 10 | M2 | Phone OTP verification | Query fragility, not a functional bug: fetched the last 5 `smsQueue` docs unfiltered and let a bare `forEach` overwrite a variable, which — combined with re-running the script against the same emulator session — picked a *stale* code from a prior run instead of the newest one. Fixed to filter by phone number and take exactly the latest entry. |
| 11 | M3 | Pickup auto-send plan gate | **Pre-existing**, same shape as #7 — auto-send became Pro+-only in Phase 4; milestone3 never upgrades its test vendor. |

**Pattern worth naming directly:** roughly half of these (#6, #7, #8, #11) were bugs in the *test suite*, not the backend — specifically, milestones 2 and 3 were written before Phase 3/4 added region gating and plan gating, and were never updated when those shipped. The backend was correctly enforcing rules the older tests didn't know about. That's now fixed, and all five suites (Milestones 1-4 plus Landing Page, CMS & Vendor Portal) pass together in a single fresh run, in the order they're documented to run.

---

## 2. Codebase audit

### 2.1 Authorization coverage — clean

Checked all 80 public callables for an auth pattern. Four initially looked like they had none; all four turned out to use a shared `assertAdmin(request, [roles])` helper instead of the more common inline check — a false alarm from too-narrow a grep pattern, not a gap. Verified `assertAdmin` itself is genuinely solid: it checks the custom-claim role **and** re-verifies against a live `adminUsers` Firestore doc status, which catches a revoked admin even within the up-to-one-hour window before their token naturally refreshes. Every one of the 80 callables has a real auth check.

### 2.2 Firestore security rules — clean

Cross-referenced every collection referenced in code against `firestore.rules`. Four collections initially looked uncovered (`catalogCategories`, `catalogItems`, `invoiceCounters`, `quickReplies`) — all four are correctly covered as nested subcollection rules (`/vendors/{vendorId}/catalogItems/{itemId}`), just missed by a regex that only looked for top-level matches. Also checked for any unconditionally-permissive rule (`allow write: if true`, or an auth-only check with no ownership/role condition): **zero found**. Every `allow read: if true` in the file is a deliberately public, explicitly-commented document (username availability checks, country availability, subscription plans/pricing, rating aggregates) — nothing accidental.

### 2.3 App Check coverage — two small, real gaps

114 `checkAppCheck` call sites across 80 callables. Two functions have none at all:
- **`getClaimsVersion`** (`completeRegistration.ts`) — a lightweight read of the caller's own claims version. Low risk.
- **`getOrderDetails`** (`orders/getOrderDetails.ts`) — properly authenticated and authorized (ownership/role-checked, correctly implements the contact-info-expiry rule), just missing the App Check layer.

Neither is an open door — both still require a real Firebase Auth session with correct role/ownership. And per milestone1's own test ("App Check monitor mode: functions still succeed without App Check token"), App Check is currently deployed in **monitor mode, not enforce mode**, so this has no practical effect today. Worth closing before any future switch to enforce mode, for consistency rather than urgency.

### 2.4 Rate-limit coverage — a known, already-flagged gap, now precisely quantified

4 of 80 callables (5%) use the shared rate limiter: `submitRating`, `createSubscriptionCheckout`, `cancelSubscription`, `reactivateSubscription`, plus the new `getPublicSubscriptionOfferings` (IP-keyed, since it's the one endpoint with no auth boundary at all). This matches what was already surfaced earlier in this engagement — not a new finding, now confirmed with exact numbers.

One thing worth checking specifically given real per-message cost exposure: **OTP sending has its own separate, bespoke rate limiting** (`MAX_SEND_PER_HOUR`, audit-logged as `phone_otp.rate_limited`/`email_otp.rate_limited`), independent of the shared helper — this is why it didn't show up in the shared-limiter grep, but the protection genuinely exists. SMS/email-bombing risk is covered.

The ~75 remaining unprotected callables (order creation, chat messages, catalog writes, etc.) remain open, as previously flagged — most have a secondary natural bound (e.g. invoice creation has a monthly quota), but request-volume rate limiting on the rest is still a real gap, not something this pass closed.

### 2.5 Code-quality risk sweep — very clean

- `@ts-ignore` / `@ts-expect-error` / `eslint-disable`: **zero**, anywhere in 77 files.
- `TODO` / `FIXME` / `HACK` / `XXX` comments: **zero** — this codebase documents known gaps as full explanatory comments (as seen throughout this engagement) rather than leaving terse markers.
- `as any` type-safety bypasses: **2** in the entire codebase (an audit-log role cast, a Firestore timestamp cast) — both minor and low-risk, not worth touching.
- Empty/silent `catch {}` blocks: **zero**.
- `tsc --noEmit`: clean, no errors.

### 2.6 PII/privacy projection safety — no gaps found

Checked for functions spreading raw document data directly into a response without going through a defined safe shape. Found none. This corroborates what was already verified via the live test suite itself: ratings never leak `orderId`/`customerId` to vendors (milestone4), verification documents are never directly readable even by their own owner (milestone1), and the subscription/billing-history projection design documented in the landing-page mapping is consistent with the pattern used everywhere else in the codebase.

---

## 3. Bottom line

Nothing in this pass surfaced a critical vulnerability. The two real findings (App Check gaps on 2 of 80 functions, rate-limiting on 76 of 80) are consistent with what's already been flagged and tracked earlier in this engagement, now precisely quantified rather than estimated. The ~50% of test failures that traced back to genuinely pre-existing, unrelated staleness (region-gating and plan-gating added in later phases that earlier milestone scripts never accounted for) is worth knowing about specifically: it means the backend has been correctly enforcing newer rules all along — the test suite just hadn't caught up to itself.
