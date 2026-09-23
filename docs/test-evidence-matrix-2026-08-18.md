# Test Evidence Matrix — Method-Honest

Three test methods used this session, not interchangeable:
- **UI** — Live click-through of the actual deployed app/portal via browser automation, screenshot evidence exists.
- **API** — Real account, real Firestore/Storage, the actual backend function called directly (not through the UI). Real execution, real data, but the frontend layer itself was not clicked through.
- **Code** — Verified by reading the source code and tracing the call chain. Not executed at all this session.

## Milestone 1 — Auth, users, vendors, verification, claims, rules

| Feature | Method | Test performed | Expected | Actual | Pass/Fail |
|---|---|---|---|---|---|
| Vendor registration | UI | Filled and submitted the real registration form on platform-dev.web.app | Account created, lands in vendor dashboard | Confirmed, screenshot on file | PASS |
| Customer registration | UI | Same, customer role | Account created, lands in customer home | Confirmed | PASS |
| Email OTP delivery | API | Checked `firebase ext:list` on platform-dev | Extension present if OTP can send | Zero extensions installed | FAIL (known, gate disabled as workaround). **the Founder is providing Resend credentials. Once wired, this stays FAIL/PENDING until a real OTP email is actually sent and received — not marked PASS on code correctness alone, per her instruction** |
| Contact-form email notification | Code | Read the `mail` collection write in `contactFormFunctions.ts` | Real notification email on submission | Code correct, same missing-extension blocker as OTP | Same status — **PENDING actual send/receive confirmation after Resend is wired, not PASS from code alone** |
| Change email during OTP step | Code | Read `verify-otp.tsx`, confirmed all 4 call sites use `router.push` not `.replace` | `router.back()` returns to a form with state intact | Logic confirmed sound, not re-clicked through the actual screen this pass | PASS (code), not re-verified via UI |
| Vendor verification submit | API | Called `submitVendorVerification` with a real account after uploading real documents | Submission succeeds | Succeeded; ran the backfill script against all 19 stuck accounts and confirmed via direct Firestore read | PASS |
| Verification copy accuracy | Code | Read the two changed files post-edit | Text no longer implies automated check | Confirmed by reading the deployed source | PASS (code, not screenshotted) |
| Sanctioned countries rejected | API | Called `validateLocationSelection` and `listCountries` directly for CU/IR/KP | Rejected / absent from list | Confirmed both | PASS |
| Vendor country immutable | Code | Read `updateVendorLocation.ts` in full | `country` never destructured from request | Confirmed | PASS (code) |
| Malware scanning | Code | Read the ClamAV trigger | Real Cloud Run call on document upload | Confirmed present, never uploaded a real infected file to trigger it live | PASS (code), not exercised with a real payload |
| Claims / rules | Code | Explore-agent read of claims code + Firestore/Storage rules | Real versioning, real deny-by-default rules | Confirmed present and specific | PASS (code only) |

## Milestone 2 — Catalog, cart, orders, pricing

| Feature | Method | Test performed | Expected | Actual | Pass/Fail |
|---|---|---|---|---|---|
| Catalog item + photo upload | API | Created a real item with a real photo via a real vendor account | A real `firebasestorage.googleapis.com` URL lands in Firestore | Confirmed, URL returned HTTP 200 | PASS |
| Catalog moderation (admin approve) | API | Created a real admin account, called `approveCatalogItem` on a real pending item | Item flips pending→approved, becomes orderable | Confirmed | PASS |
| Cart (`repriceCart`) | API | Called with an unapproved item, then an approved one | Rejected / correctly priced | Both confirmed | PASS |
| Trusted pricing (change-request fix) | API | Vendor proposed a change with a manipulated ₦1 line for a real ₦5,000 item, customer accepted | Server re-validates and corrects the price | Order total came back ₦5,000, not ₦1 | PASS |
| Order creation from cart | API | Called `createOrderFromCart` with a real priced cart | Order document created correctly | Confirmed | PASS |
| Order events log | API | Checked `orders/{id}/events` after creation and a status change | `ORDER_CREATED` + `STATUS_CHANGED` entries exist | Confirmed | PASS |
| Order status lifecycle | API | Walked a real order requested→accepted→in_progress→completed via `updateOrderStatus` | Each transition succeeds, receipt generated on completion | Confirmed | PASS |
| **External Order — full vendor journey** | **UI** | Real vendor account, real approved catalog item. Clicked through the actual deployed app: Record External Order → Add Item → Select from Catalog → Save → Orders list → tap the real order card → Order Detail | Order recorded, visible in Orders list at the correct amount, opens correctly on tap | **2 real bugs found and fixed mid-test:** (1) Orders list showed the order's total divided by 100 (₦45.00 instead of ₦4,500.00) — `formatPriceCents` was applied to a value already in major units, affecting every order in the list, not just external ones. (2) Order detail screen showed the line item at ₦0.00 while the total was correct — it read `price_at_order`/`price`, fields that don't exist on a real order document. Both fixed, redeployed, and re-verified live with a fresh in-app click — Orders list and detail now both show ₦4,500.00 correctly | **PASS after fix — was FAIL, live-verified before and after** |
| External Order — schedule/upcoming visibility | UI + Code | Same test; checked the order card and detail screen for the fulfillment date/time set in the form | Expected the picked date/time to appear somewhere | **Found: the "Fulfillment Date & Time" field in the form is never sent to `createExternalOrder` at all — no such field exists in its accepted payload.** No schedule/upcoming visibility exists because the data never reaches the backend. Not fixed — flagged as a product decision (every other similarly-unwired field on this screen blocks save with a warning; this one field was missed from that pattern) | **FAIL — real gap, not yet fixed** |
| External Order — analytics visibility | UI | Visited Business Insights (`growth-insights.tsx`) after recording the order | Real data or an honest empty state | Confirmed honest: "No data yet — start sharing your storefront link..." shown correctly for a vendor with no completed/qualifying orders. (Separately noticed hardcoded example insight text elsewhere on the same page — checked the render logic, confirmed it only shows inside a paywall preview for non-Pro plans, not presented as real data. Not a bug.) | PASS |

## Milestone 3 — Chat, notifications, contact cards, pickup

| Feature | Method | Test performed | Expected | Actual | Pass/Fail |
|---|---|---|---|---|---|
| Vendor support chat | API | Real account, `createSupportTicket` → `sendChatMessage` → Firestore read | Message lands in a real thread | Confirmed | PASS |
| Customer support chat | API | Same, customer role | Message lands, `markChatRead` works | Confirmed | PASS |
| Support chat FCM | Code | Read `createNotificationInternal` → `messaging.send()` | Real push dispatch, not just a Firestore write | Confirmed via code; did not receive an actual push on a real device this session | PASS (code + trigger confirmed real), not device-confirmed |
| Support chat attachments | — | N/A, confirmed missing | — | No `onPress` handler on the attach button | FAIL (known, not built) |
| Report a Problem | API | Called the real backend after the fix | Ticket created, not console.log | Confirmed live | PASS |
| Commerce chat, contact cards, pickup auto-message | Code | Traced each call chain screen→hook→callable in the source | Real, non-decorative wiring | Confirmed by reading the code | **Not independently live-tested — flagged in the original checklist and still true** |

## Milestone 4 — Subscriptions, analytics, ratings, invoices

| Feature | Method | Test performed | Expected | Actual | Pass/Fail |
|---|---|---|---|---|---|
| Plan entitlement enforcement | API | Called `createCatalogItem` past a real vendor's plan limit | `resource-exhausted` error | Confirmed | PASS |
| Subscription checkout | API | Called `createSubscriptionCheckout` for a real vendor, real plan | — | The rejection-when-unconfigured path is confirmed working. The successful-payment path cannot be exercised by anyone until real provider credentials exist | **PARTIALLY VERIFIED / BLOCKED ON PROVIDER CONFIGURATION** (relabeled per the Founder's instruction — not "PASS") |
| Ratings | API | Real customer, real completed order, `submitRating` | Vendor's `ratingAverage`/`ratingCount` update via the real trigger | Confirmed | PASS |
| Invoices | API | Real vendor, `createInvoice` with real line items | Invoice created with correct numbering | Confirmed | PASS |
| Vendor analytics | API | Called `getVendorDashboard` for a real vendor | Live-computed real numbers, `dataPending` where genuinely unmeasured | Confirmed | PASS |

## Mobile Phases 1-8

| Phase | Method | Test performed | Expected | Actual | Pass/Fail |
|---|---|---|---|---|---|
| 1, Registration/onboarding | UI | Full live registration run | Succeeds without the OTP gate, area picker works | Confirmed | PASS |
| 2, Catalog moderation | API | Same as Milestone 2's moderation test | — | — | PASS |
| 3, Invoice ledger/mobile | Code | Explore-agent code trace of the invoice screens | Real Firestore listener, real callables | Confirmed by reading the code | PASS (code), not clicked through the app |
| 4, Storefront sharing | Code | Explore-agent code trace | Real working share link | Confirmed by reading the code | PASS (code), not clicked through the app |
| 5, Business Insights | Code | Explore-agent code trace | Real backend data, honest `dataPending` | Confirmed by reading the code | PASS (code), not clicked through the app |
| 6, Dashboard Insight engine | UI | Loaded the real dashboard in a browser after the index fix | 500 error gone | Confirmed, real data rendered | PASS |
| 7, Chat action sheets / Quick Note | API + Code | Confirmed `createQuickReply`/`saveChatDraft` are real deployed callables, called from real screens; confirmed the "+" action grid is live in the current vendor chat screen source | Both real and wired | Confirmed — corrects the earlier wrong "defective" finding | PASS (mixed API+code, not independently clicked through) |
| 8, Username cooldown | Code | Read the transaction-based cooldown check | Server-enforced, not just a UI cache | Confirmed | PASS (code) |

## Landing Page, CMS & Vendor Portal

| Feature | Method | Test performed | Expected | Actual | Pass/Fail |
|---|---|---|---|---|---|
| 14 landing pages, pricing, contact form, CMS, SEO | Code | Explore-agent full code trace against the exact approved spec doc | Matches spec | Confirmed by reading the code | PASS (code), **not clicked through the live site this pass** |
| Vendor Portal login/access authorization | Code | Explore-agent code trace | Server-side gate per account state | Confirmed | PASS (code), not clicked through |
| **Suspended-vendor billing restriction** | **UI** | Registered a real vendor, flipped it to `suspended` in Firestore, logged into the real deployed portal | Billing actions blocked with a clear message | **Confirmed live: "Your account is suspended, so billing actions are restricted." shown on both Subscription and Invoices pages, Upgrade/New Invoice buttons absent** | **PASS — screenshot evidence** |
| **Cancelled vs. expired distinction** | **UI** | Same portal, manually set a real subscription doc to each state in turn, reloaded | Visibly different plan/status per state | **Confirmed live: "cancelled" state kept Standard-plan features with a Cancelled badge; "expired" state dropped to Basic-plan features with an Expired badge** | **PASS — screenshot evidence** |
| "No provider route" vs "no country pricing" copy | UI (partial) | Same test surfaced this by accident — Nigeria currently has no active `subscriptionPricing` entry on platform-dev | Exact spec copy: "Subscriptions are not available in your country yet." | Confirmed rendering verbatim, live | PASS — screenshot evidence, though the "no provider route" (as opposed to "no country pricing") branch specifically wasn't separately forced |
| Billing history, invoices (portal) | Code | Explore-agent code trace | Real vendor-safe projection, real invoice callables | Confirmed | PASS (code), not clicked through |

---

## What this means, plainly

**Genuinely solid (real execution, real data, real screenshots or real API responses):** the vast majority of Milestone 1-4 backend functionality, all order/cart/rating/invoice/moderation flows, and — as of this pass — 2 of the 3 vendor portal fixes with actual screenshots from the live site.

**Real but not through the UI (API-tested):** most backend correctness claims. These are genuine tests against genuine live data — not the same as "the function exists," but not the same as clicking through the app either. I'm flagging every one rather than letting "WORKING" imply more than it means.

**Code-trace only, not executed at all this session:** the entire landing page, CMS, and most of the vendor portal beyond the 2 items just UI-confirmed; commerce chat, contact cards, and pickup auto-message on mobile; several mobile phase items (3, 4, 5). These are the honest gap against her standard. Nothing here is known to be broken — but "confirmed by reading the code" and "confirmed by using it" are different claims, and I was treating them as equivalent in places. That's what she caught.

## Update — External Orders, actually UI-tested (her specific ask)

Ran the full vendor journey live: recorded a real external order through the actual deployed app, then followed it through the Orders list, the order detail screen, and the analytics page. This is exactly the kind of test that a code-read or a direct backend call would not have caught, and it justified the scrutiny — **it found two real bugs**, both now fixed and re-verified live:

1. Every order's total in the Orders list was displaying at 1/100th its real value (a ₦4,500 order showed ₦45.00) — a wrong price-formatting function was applied to a value already in major units. This affected internal orders too, not just external ones.
2. The order detail screen's line-item price showed ₦0.00 (aggregate total was correct) — it was reading fields that don't exist on any real order document.

Both fixed, redeployed, and re-confirmed live with a fresh click-through — screenshots on file.

**One real gap found and not fixed:** the fulfillment date/time picker on the external-order form is decorative — collected, never sent to the backend, no schedule/upcoming visibility exists anywhere as a direct result. Every other unwired field on that same form correctly warns the vendor before save; this one was missed. Needs a decision (wire it for real, or add the same warning), not a quick patch.

**Checked and cleared:** the seemingly-fabricated "6% conversion" example text on Business Insights turned out to be a legitimate paywall preview (only renders behind a lock for non-Pro plans), with the honest "No data yet" empty state rendering correctly above it for this vendor's real (empty) data. Verified via the render logic and a screenshot before reporting it either way.

## Subscription checkout — reclassified

Per instruction, no longer reported as PASS. **Status: PARTIALLY VERIFIED / BLOCKED ON PROVIDER CONFIGURATION.** The rejection-when-unconfigured path is confirmed working; the successful-payment path cannot be tested by anyone until real provider credentials exist.

## Email — awaiting the Founder's Resend credentials

Both OTP and the contact-form notification remain FAIL/PENDING. Once the Resend integration is wired, neither gets marked PASS until a real email is actually sent and received — confirmed receipt, not just a clean function call.
