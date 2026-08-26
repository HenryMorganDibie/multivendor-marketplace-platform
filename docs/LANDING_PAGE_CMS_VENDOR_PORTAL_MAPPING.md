# LANDING_PAGE_CMS_VENDOR_PORTAL_MAPPING.md (v6 — Approved)

**Scope:** Frontend package agreed after Phase 4 — public landing page (14 pages), CMS layer, and vendor web portal (login-only for MVP). Package total: 400,000 NGN — Landing page 250,000 / CMS 50,000 / Vendor portal 100,000, unchanged.

**Approved cost for this revision: 145,000 NGN** — 100,000 NGN original package balance (Vendor Portal line item) + 45,000 NGN for new work identified during this revision (Section 12.1.4's double-billing prevention, Section 12.3's reduced-scope Price Change & Existing Subscriber Policy, and Section 13 item 17's CMS concurrent-edit handling). Approved; implementation proceeding.

**Revision note (v6):** Applies six blocking corrections — invoice numbering format (`{VENDORSLUG}-INV-{sequentialInvoiceNumber}`, no zero-padding, immutable across slug changes), provider-neutral checkout status corrected from "already exists" to "approved target, being completed as agreed no-extra-cost correction," `plan` field name (not `planId`), migration-safe country resolution (`businessLocation?.countryCode ?? countryCode`), Dependencies table corrected to reflect partial completion, and the two new offerings callables (`getVendorSubscriptionOfferings`, `getPublicSubscriptionOfferings`) documented. Adds three new sections: Performance Notes (11), Subscription Lifecycle Business Rules (12 — upgrades, downgrades, and the Price Change & Existing Subscriber Policy), and Edge Cases & Business Rules (13, 32 documented scenarios). Explicitly separates what's included in the original 400,000 NGN package from genuinely new work identified during this revision — priced separately, not silently folded in.

**Final decision on price-change notice enforcement (locked after negotiation):** Option 1 for MVP — price-change notice is a **manual administrative process**, not a backend-enforced rule. The backend stores an `effectiveFrom` field on pricing records for record-keeping, but does not itself block, delay, or verify that adequate notice was given before a price change is published. See Section 12.3 for the full operational policy. Automated notice-period enforcement is explicitly deferred to a future subscription-management enhancement, not part of this approved scope.

**Document approved. Standing implementation practice for this phase:** implementation should match this specification exactly. If a situation arises where this document doesn't define the expected behavior, or following it exactly would create a technical problem, that specific part is paused and discussed before an implementation decision is made unilaterally — not resolved silently and reported after the fact. One such item already flagged and left open rather than silently decided: the vendor business-country-change approval mechanism (Section 13, item 6).

---

## 0. What This Is (and Isn't)

For MVP, the Vendor Portal is **login-only for existing vendors**. New vendor registration and full onboarding remain **mobile-only**. The landing page's "Become a Vendor" CTA (within the Vendors page and navigation, not a standalone page) directs prospective vendors to download the mobile app. Once registered on mobile, vendors log into `vendor.theplatform.com` with the same Firebase Auth credentials.

**Post-MVP:** full web registration once the portal reaches onboarding feature parity with mobile.

**Not this:** the Admin Web Portal (Phase 5) is separate — internal team only, verification review, moderation, support queue.

---

## 1. Landing Page — Confirmed 14 Pages

| # | Page | Purpose | Backend dependency |
|---|---|---|---|
| 1 | Home | Hero, value proposition, primary navigation | `siteContent/home` |
| 2 | Features | Full feature breakdown, maps to MVP feature matrix | `siteContent/features` |
| 3 | Pricing | **Country-specific pricing — see Section 1.1 below** | `subscriptionPlans` + `subscriptionPricing/{countryCode}` |
| 4 | Vendors | Vendor value prop. Includes the "Become a Vendor" CTA (app-download buttons, not a form) | `siteContent/vendors` |
| 5 | Customers | Customer value prop, app download links | `siteContent/customers` |
| 6 | FAQ | Common questions | `siteContent/faq` |
| 7 | Contact | Public contact form — see Section 3 | `contactSubmissions` |
| 8 | About | Company story, mission | `siteContent/about` |
| 9 | Privacy Policy | Legal | `siteContent/privacy-policy` |
| 10 | Terms of Service | Legal | `siteContent/terms-of-service` |
| 11 | Vendor Terms | Legal, vendor-specific | `siteContent/vendor-terms` |
| 12 | Customer Terms | Legal, customer-specific | `siteContent/customer-terms` |
| 13 | Cookie Policy | Legal — see Section 6.3 for what it must actually say | `siteContent/cookie-policy` |
| 14 | Acceptable Use Policy | Legal | `siteContent/acceptable-use-policy` |

Confirmed final list. Blog, Waitlist, How It Works, standalone Become-a-Vendor page are not included.

### 1.1 Pricing Page — Corrected Data Source

The Pricing page **cannot** read prices from `subscriptionPlans` alone — that collection now holds only entitlements and limits (per the Phase 4 mapping doc). Actual monthly prices live in the separate `subscriptionPricing/{countryCode}` collection, keyed by country.

**Country selection for unauthenticated visitors:**
- Browser locale or coarse IP-based lookup may **suggest** an initial country, but is never treated as authoritative.
- A visible country selector lets the visitor change it manually at any time.
- The chosen country is stored locally in the browser (not tied to any account, since the visitor isn't authenticated).
- **Never default every visitor to Nigeria/NGN.** If no country signal is available, show a neutral prompt to select a country rather than silently picking one.

**Missing pricing behavior:** if `subscriptionPricing` has no active record for the visitor's selected country, the page displays *"Paid plans are not available in this country yet"* and does **not** show an enabled Subscribe/CTA button — never fall through to showing another country's price.

**Scope of the country selector:** this manual selector exists **only** on the public Pricing page, for unauthenticated visitors browsing before they have any account. Once a vendor is authenticated (in the Vendor Portal or mobile app), pricing is resolved server-side via `vendor.businessLocation?.countryCode ?? vendor.countryCode` — the migration-safe fallback that lets existing vendors with only the legacy flat `countryCode` field keep working while newly migrated vendors resolve through the structured `businessLocation` field. There is no manual country override anywhere post-authentication, and the frontend never reads or chooses between the two fields — it only ever receives an already-resolved country from backend responses. The two flows are deliberately different: browsing is exploratory, billing must always reflect the vendor's actual registered business location.

**Naming:** `pro_plus` stays the backend identifier everywhere; the Pricing page displays it as **"Pro+"** exclusively — "Pro Plus" (with a space) must not appear anywhere in the UI.

---

## 2. CMS Layer

`siteContent/{sectionId}` per the architecture doc — one document per editable section across all 14 pages.

### 2.1 Draft / Publish Workflow (new in v4)

Public visitors must only ever receive **published** content — an in-progress edit must never be live. Every `siteContent` document uses this shape:

```typescript
{
  draftContent: { /* structured fields, see 2.3 */ };
  publishedContent: { /* same shape, last-published snapshot */ };
  status: "draft" | "published";
  version: number;              // increments on every publish
  publishedAt: Timestamp | null;
  publishedBy: string | null;   // admin uid
  updatedAt: Timestamp;
  updatedBy: string;            // admin uid, set on every save (draft or publish)
}
```

- **Save Draft** — writes `draftContent`, does not touch `publishedContent`, does not affect the live page.
- **Preview** — the editor can render `draftContent` in a preview view before publishing.
- **Publish** — copies `draftContent` into `publishedContent`, increments `version`, sets `publishedAt`/`publishedBy`. Only this action changes what visitors see.
- **Legal pages specifically** retain the previous `publishedContent` snapshot (minimum: the immediately prior version, ideally a short history) so an accidental bad publish can be rolled back rather than requiring a manual re-edit under pressure.
- The public-facing landing page render path reads only `publishedContent` — it has no code path that can accidentally read `draftContent`.

### 2.2 CMS Save/Publish Path — Server-Enforced, Not Client-Trusted

The browser never writes to `siteContent` directly, even from an authenticated Super-Admin session. Flow: **CMS editor → authenticated callable → verify Super-Admin custom claim → validate/sanitize content → write draft/published content → audit log entry.** This applies equally to text edits and to image reference updates.

### 2.3 Rich-Text Content Format

Structured JSON, not raw HTML. Allowed node types: `heading` (levels 1–3), `paragraph`, `bulletList`, `orderedList`, `listItem`, `link`, `bold`, `italic`. The renderer rejects or strips: `<script>`, `<iframe>`, arbitrary raw HTML, inline event handlers, and any URL scheme other than `https:`, `mailto:`, and `tel:` (specifically rejecting `javascript:` and similar). This applies to all 14 pages; the six legal pages simply use the full node set, while shorter marketing sections may only need headings/paragraphs/links.

### 2.4 Image Upload

- Upload flow: CMS editor → Firebase Storage (under a dedicated `siteContent/` path) → editor writes the **Storage object path** (not a long-lived download-token URL) into the relevant field. Public rendering resolves the path to a servable URL at render time. Storing the path rather than a token URL avoids stale/broken references when an image is replaced.
- Allowed formats: JPEG, PNG, WebP. SVG is **not** permitted (XSS risk via embedded scripts in SVG markup).
- Maximum file size and pixel dimensions are enforced server-side at upload time, with automatic compression/resizing to a standard web-appropriate size.
- Each upload gets a unique object name (no overwrite-in-place); replacing an image in the CMS uploads a new object and updates the reference, it does not mutate the old file. An orphan-cleanup consideration (removing unreferenced old uploads) is a nice-to-have, not required for MVP, but the object-naming scheme should not make future cleanup harder.
- Upload permission: Super-Admin only, enforced server-side.
- Every image field requires accompanying alt text, entered by the admin at upload/edit time — not auto-generated, not optional.
- Images are publicly readable via Storage rules (they're used on public pages), but only writable through the validated callable path in Section 2.2.

---

## 3. Contact Form — Complete Backend and Abuse Model

Collection: `contactSubmissions/{submissionId}`, separate from `supportTickets` (in-app support stays exclusively on `supportTickets`, no merging).

```typescript
{
  submissionId: string;
  name: string;
  email: string;
  subjectCategory: string;
  message: string;
  status: "new" | "reviewed" | "closed" | "spam";  // server-owned, never client-settable
  source: "public_website";
  createdAt: Timestamp;   // server timestamp only
}
```

**Write path:** public create only, through a validated Cloud Function — never a direct client write, and the client cannot set `status`, `createdAt`, or any admin/assignment field.

**Abuse protection:**
- Server-side rate limiting by IP/device/session signal.
- Firebase App Check where practical.
- CAPTCHA or equivalent challenge triggered after suspicious submission velocity.
- Field length limits on name/email/subject/message.
- Email format validation.
- A honeypot field (hidden from real users, if filled indicates a bot).
- Basic duplicate/spam detection (e.g. identical message content submitted repeatedly in a short window).
- No file attachments for MVP.

**Where submissions actually get seen (this was previously undefined — real operational gap):** since the Admin Web Portal is Phase 5 and doesn't exist yet, every new `contactSubmissions` write triggers an **email notification to a designated the platform support inbox** (the client to confirm which inbox). This is included in the 400,000 NGN scope as the MVP monitoring mechanism — without it, submissions would silently accumulate in Firestore with nobody watching. Whether the visitor also receives an acknowledgement email is the client's call — default assumption for MVP is **no visitor acknowledgement email**, only the internal notification, unless specified otherwise.

---

## 4. Vendor Web Portal — Confirmed Scope

**Payment provider neutrality:** provider-neutral checkout is the **approved target architecture** and is being completed as the agreed no-extra-cost correction before the Vendor Portal subscription screens are implemented — it is not yet fully built as of this revision. Once complete, `createSubscriptionCheckout` is one generic callable. The frontend sends only `{ plan }` (not `planId` — `plan` is the canonical field name, already threaded through checkout, webhooks, and event records); the backend reads the vendor's resolved country (Section 1.1), resolves the correct provider and provider-specific plan code server-side via a private, country-specific `subscriptionProviderConfig`, and returns a generic checkout redirect. **The frontend never selects between Paystack/Flutterwave/Stripe callables and contains no provider-specific branching.** Initial provider: Paystack. Future: Stripe, Flutterwave, etc. — adding one requires zero frontend changes.

### 4.1 Account Access Authorization (new in v4 — was previously just "existing vendor accounts")

Enforced **server-side**, not by hiding UI in the frontend:

| Account state | Portal behavior |
|---|---|
| Active vendor (verified or unverified) | Full portal access |
| Pending verification | Portal access allowed |
| Suspended vendor | Read-only account/status view; billing actions restricted |
| Deactivated vendor | No normal portal access |
| Customer / non-vendor account | Access denied |
| Incomplete vendor registration | Redirected to mobile app download/onboarding instructions, no portal access |
| Deleted user | Access denied |

### 4.2 Confirmed Scope

| Screen/Feature | Backend dependency | Status |
|---|---|---|
| Login (existing vendor accounts only, per 4.1 rules) | Firebase Auth, `users`, `vendors` | ✅ Included |
| Subscription management (view current plan) | `vendorSubscriptions`, `subscriptionPlans`, `subscriptionPricing` | ✅ Included |
| Subscription Payment Flow (new/upgrade) | `createSubscriptionCheckout` (provider-neutral, per above) | ✅ Included |
| Upgrade / downgrade / cancel / reactivate | Existing Phase 4 functions, extended per Section 12 | ✅ Included |
| Billing history | Vendor-safe projection of `subscriptionEvents` — see 4.3 | ✅ Included |
| **Invoice management — see exact scope in 4.4** | `invoices` and related functions | ✅ Included (scoped) |
| Dashboard (orders, revenue) | — | ❌ Explicitly excluded, per the client's decision — see 4.4 |
| Storefront settings | — | ❌ Excluded unless separately priced |
| Vendor registration / onboarding | — | ❌ Mobile-only, per Section 0 |

### 4.3 Billing History — Vendor-Safe Projection

The portal never reads raw `subscriptionEvents` documents directly — those may contain webhook payloads, provider IDs, internal error detail, admin override notes, and other operationally-private metadata. A dedicated vendor-facing callable/projection returns exactly these fields per entry, nothing else:

- **Payment date**
- **Amount**
- **Currency**
- **Plan**
- **Payment status** (plain-language, not a raw backend status string)
- **Provider reference**, where applicable and safe to show (e.g. a transaction ID a vendor could reference in a support conversation) — never the full raw webhook payload or internal provider metadata

Provider webhook internals stay private, never surfaced to any vendor under any field name.

### 4.4 Invoice Scope — Exact, Per the client's Decision

The portal stays a **focused vendor utility** (subscriptions + invoices), not a second full vendor app. Dashboard, order management, analytics, catalog, and storefront editing are explicitly excluded from this package.

**Included:**
- View invoice list — each row shows invoice number, **created date**, customer/recipient, amount, and status at minimum
- Create invoice
- View invoice details
- Share/send invoice via the existing backend share flow
- Download PDF, where the vendor's plan allows it (same gate as mobile — Basic cannot download PDF)
- Display current invoice status

**Invoice numbering format (corrected):** every invoice is assigned a consistent, human-readable number at creation, format `{VENDORSLUG}-INV-{sequentialInvoiceNumber}` (e.g. `SPICYREST-INV-1`, `SPICYREST-INV-2`, `SPICYREST-INV-25`) — the number grows naturally with no zero-padding, matching the existing order-numbering convention. Generated server-side, sequence maintained per vendor, never reused. The number remains **immutable** once issued — if the vendor later changes their storefront slug, previously issued invoice numbers do not change to reflect the new slug. **The sequence only ever increases — no yearly reset, no monthly reset, and no reuse of a number after an invoice is deleted.** `1, 2, 3, ... 999999, 1000000` continuing indefinitely for a given vendor.

**Search — explicitly deferred, not built for MVP, but documented so it isn't forgotten:** once the invoice list grows, the portal should support search by invoice number and by customer name. Not required for initial launch; noted here as a known near-term follow-up rather than an open question.

**Excluded from this package** (not built at all, not just hidden): duplicate invoice, edit draft invoice, cancel invoice, mark-paid, invoice branding editing (branding is set once via existing settings, not re-editable per-invoice in the portal specifically unless already covered elsewhere).

**Hard requirement:** the web portal uses the **exact same** invoice records, plan gates, monthly quotas, branding rules, and public share-link mechanism as the mobile app and existing Phase 4 backend. There is no separate web-only invoice system — same Firestore documents, same Cloud Functions, same entitlement checks (Basic's 3/month cap, PDF gating, etc. apply identically on web).

### 4.5 Subscription State UI Coverage

The portal cannot show only "current plan" — it must have a defined UI state for each of these, each with its own visible status, permitted actions, correct call-to-action, and relevant date. **All copy shown to vendors uses plain, non-technical language — internal backend terms like "provider mapping" or "country pricing" are never exposed in the UI**, even when they're the underlying cause of the state:

| State | UI requirement | Vendor-facing copy |
|---|---|---|
| `active` | Plan name, renewal date, upgrade/downgrade/cancel actions available | — |
| `past_due` / grace period | Clear "payment issue" messaging, grace period end date, retry/update-payment action | "There's an issue with your last payment" |
| `cancel_at_period_end` | "Cancelling on [date]" messaging, reactivate action available | — |
| `cancelled` | Clear inactive-plan messaging, resubscribe action | — |
| `expired` | Clear inactive-plan messaging, resubscribe action | — |
| Pending downgrade | "Downgrading to [plan] on [date]" messaging | — |
| Admin override active | Reflects the overridden plan; no self-service billing actions available during override, matching mobile behavior | — |
| Payment failed (initial) | Distinct from grace period — immediate failure messaging with retry action | "Your payment didn't go through" |
| No usable provider route for this plan/country (internal: provider mapping missing) | Generic unavailable state, no broken checkout attempt, no internal terminology surfaced | **"Subscriptions are temporarily unavailable. Please try again later."** |
| No pricing configured for vendor's country (internal: country pricing missing) | Same treatment as the Pricing page's unavailable state (Section 1.1), phrased for an already-registered vendor | **"Subscriptions are not available in your country yet."** |

**`cancelled` vs. `expired` — precise distinction (clarified per review), matching the already-implemented backend logic exactly:**
- **`cancelled`** is set *immediately*, only in two cases: a payment provider's webhook reports a cancellation directly, or an admin performs an *immediate* cancellation (`cancelSubscriptionAdmin` with `immediate: true`). It's a point-in-time termination.
- **`expired`** is set only by the scheduled renewal-sweep job, once `currentPeriodEnd` actually passes — covering a vendor's own self-service cancellation (which leaves them `active` with `cancelAtPeriodEnd: true` until the period genuinely ends), a renewal that never happened, or an exhausted grace period.
- **A vendor's own "Cancel my subscription" action in the Vendor Portal or mobile app does not immediately produce `cancelled`** — they remain on `active` (with a "Cancelling on [date]" banner) until their period ends, at which point the scheduled job moves them to `expired`. `cancelled` is reserved for provider- or admin-driven immediate terminations.

No separate "pending price increase" UI state is required for MVP — per Section 12.3's Option 1 decision, price changes are not tracked as a per-vendor pending record; a vendor simply pays whatever price is currently published at their renewal, per the manual-notice operational policy. If automated notice enforcement is added post-MVP, this table gains a new row at that time.

The vendor portal has no manual country selector at any point — post-authentication pricing is always derived server-side from `vendor.businessLocation?.countryCode ?? vendor.countryCode` (see Section 1.1's scope note). If that country has no pricing or provider route configured, the vendor sees the unavailable states above, never a fallback to a different country's pricing.

### 4.6 Cross-Surface Consistency — Explicit Test Requirement

Since shared backend state is the entire premise of having both a mobile app and a web portal, this must be proven with explicit tests, not assumed:

- Portal creates invoice → invoice appears in vendor mobile app
- Portal cancels subscription → mobile entitlement updates correctly
- Mobile upgrades subscription → portal reflects the new plan
- Admin override applied → portal and mobile both reflect the overridden effective plan
- Vendor logs out or has token revoked → protected portal routes become immediately inaccessible

---

## 5. Content Responsibility

This package covers page templates, CMS editing, and rendering. It does **not** include drafting legal or marketing copy. the client provides all approved legal text (Privacy Policy, Terms of Service, Vendor Terms, Customer Terms, Cookie Policy, Acceptable Use Policy) and marketing copy for the other pages. Each legal page displays effective date, last-updated date, version number, and contact information; longer pages include a table of contents/section anchors. Editing a legal page's content does not retroactively imply existing users re-accepted the new version — formal version-acceptance/re-consent tracking is explicitly **post-MVP**, documented here as a known limitation rather than a silent gap.

---

## 6. Marketing Site — Production Completeness

### 6.1 SEO and Social Sharing
Unique page titles and meta descriptions per page, Open Graph metadata, a social preview image, canonical URLs, `sitemap.xml`, `robots.txt`, favicon/app icons, clean URLs, and a custom 404 page. Structured data (schema.org) where straightforwardly applicable (e.g. Organization on the homepage) — not an exhaustive structured-data audit.

### 6.2 Accessibility
Practical WCAG 2.1 AA-level behavior: keyboard navigation, visible focus states, semantic heading structure, form labels, image alt text (ties to Section 2.4), adequate color contrast, reduced-motion consideration, screen-reader-friendly error messaging, responsive text sizing. This is acceptance-criteria-level coverage, not a formal accessibility audit/certification.

### 6.3 Cookies
**Default assumption for MVP, pending the client's explicit confirmation:** no analytics or marketing cookies/trackers (no Google Analytics, Meta Pixel, etc.) are added without an explicit decision. If MVP uses only essential storage, the Cookie Policy page explains that and **no consent banner is needed.** If analytics/advertising cookies are added, a consent mechanism becomes necessary depending on target region, and that's a scope addition to flag separately, not assumed as already included.

### 6.4 CMS Ownership Boundary
Not everything on the page is CMS-editable — that would make the CMS far more complex than its scoped 50,000 NGN. Split: **code-owned** (layout, components, navigation structure, safety constraints) versus **CMS-owned** (headings, paragraphs, images, CTA copy/links, FAQ entries, legal content). Arbitrary layout configuration is not stored in Firestore for MVP.

### 6.5 Deployment and Environments
Domains: `www.theplatform.com` (landing page) and `vendor.theplatform.com` (vendor portal). Scope includes: hosting (Firebase Hosting or equivalent), SSL, custom-domain setup, dev/staging/production environment separation matching the existing the platform convention, environment variable configuration, necessary redirects, and basic deployment documentation. Error monitoring, analytics, and performance monitoring are included at a basic level (e.g. Firebase's built-in tooling), not a dedicated observability stack.

---

## 7. Acceptance Criteria

### Landing Page
- All 14 pages live, reachable via navigation, rendering from `siteContent` (published content only).
- `#FF7A28` applied consistently.
- Pricing page correctly resolves country (suggested, changeable, never silently defaulted to NGN), shows the unavailable state when appropriate, never shows an enabled CTA without a working provider route.
- "Become a Vendor" is a CTA only, no web registration form exists anywhere.
- Contact form writes to `contactSubmissions`, triggers the internal email notification, enforces all listed abuse protections.
- SEO, accessibility, and cookie requirements (Sections 6.1–6.3) are met.
- `sitemap.xml`, `robots.txt`, custom 404 page exist.

### CMS
- Super-Admin-only authenticated editor, no direct Firestore console editing as a fallback.
- Draft/publish separation works exactly as Section 2.1 — a draft save never affects the live page; only publish does.
- All writes (content and images) go through a validated callable, never a direct client write, per Section 2.2.
- Rich-text editor enforces the allowed-node schema and strips/rejects disallowed content per Section 2.3.
- Image upload enforces format/size/dimension limits, requires alt text, stores Storage paths not token URLs.
- Legal pages retain at least the immediately prior published version for rollback.
- Concurrent-edit handling (Section 13, item 17) is implemented: newest publish wins, both edit attempts are recorded in the audit log.

### Vendor Web Portal
- Account access authorization (Section 4.1) is enforced server-side for every listed account state, verified by attempting access as each state.
- Checkout uses the single generic `createSubscriptionCheckout` callable with zero provider-specific frontend logic.
- All ten subscription states (Section 4.5) have a working, correct UI, including the `cancelled` vs. `expired` distinction rendered from the correct backend status, not conflated in the UI layer.
- Billing history uses the vendor-safe projection, never exposes raw webhook/provider data.
- Invoice actions match exactly the list in Section 4.4 — nothing more, nothing less. Every invoice has a `{VENDORSLUG}-INV-{sequentialInvoiceNumber}` number assigned server-side, no zero-padding, immutable even if the vendor later changes their slug.
- No provider name, and no internal terms like "provider mapping" or "country pricing," appear anywhere in vendor-facing portal copy — only the plain-language messages specified in Section 4.5.
- Billing history returns exactly the fields listed in Section 4.3 — payment date, amount, currency, plan, payment status, provider reference where applicable — nothing else.
- The portal has no country selector anywhere; pricing is always derived server-side from `vendor.businessLocation?.countryCode ?? vendor.countryCode`.
- All five cross-surface consistency tests (Section 4.6) pass.
- No dashboard, storefront settings, or registration screens exist in this build.
- A vendor can never be billed on two simultaneous recurring plans during an upgrade (Section 12.1.4).
- Existing subscribers' billed price never changes except at a renewal that occurs on or after the price's `effectiveFrom` date (Section 12.3).

---

## 8. Future Expansion

This architecture deliberately separates plan definitions, country pricing, provider mappings, CMS content, and invoice functionality precisely so that future additions don't require breaking existing APIs or rewriting the frontend. Specifically, this design already accommodates, without structural changes:

- **New payment providers** — adding one is a new `providerPlanMapping` entry per country/plan plus backend routing logic; zero frontend changes, per Section 4.
- **Annual billing** — MVP is monthly-only by explicit decision, but the `subscriptionPricing` schema's per-plan structure can accept a parallel yearly price field later without restructuring the collection.
- **Additional countries** — adding a country is a new `subscriptionPricing`/`providerPlanMapping` entry, following the same seed/import pattern already established for the location catalogue; no code changes required.
- **Expanded Vendor Portal capabilities** — dashboard, storefront settings, and full onboarding are excluded from this package by choice, not by architectural limitation; adding them later is new scope, not a rebuild.
- **Automated price-change notice enforcement** — Section 12.3 deliberately defers this to MVP's manual process; the `effectiveFrom` field already being stored means a future automated version has the data it needs without a schema migration.

## 9. Cross-Document Consistency Requirement

This document is now one of several canonical architecture references for the platform's backend, alongside the Phase 4 mapping doc, the Location Specification, and the Subscription Pricing schema. Where the same field, collection, or workflow is described in more than one of these documents, **all of them must match exactly** — there is one source of truth per contract, not one per document. Before this package is implemented, a short consistency pass confirms there's no contradiction between this document and the other three (e.g. `pro_plus`/`Pro+` naming, `businessLocation.countryCode` field naming, `subscriptionPricing` schema shape). Any discrepancy found is corrected in all affected documents together, not just the one being actively worked on.

---

## 10. Dependencies

| Part | Depends on | Status |
|---|---|---|
| Landing Page (all 14 pages) | `siteContent` collection, rules, draft/publish logic | New — this package |
| Pricing page | `subscriptionPlans` (✅ exists) + `subscriptionPricing/{countryCode}` (✅ exists, built during pricing work) | Both sides now exist — page just needs to combine them correctly |
| CMS Editor | Firebase Auth + Super-Admin claim (✅ exists) | New editor UI, existing auth model |
| CMS image upload | Firebase Storage, dedicated path/rules | New — this package |
| Contact form | `contactSubmissions` + validated Cloud Function + email notification | New — this package |
| Vendor Portal — Login, authorization | Firebase Auth, `users`/`vendors` (✅ exists) | ✅ Already exists |
| Vendor Portal — Subscription/payment flow | `subscriptionPricing`, `providerPlanMapping`, `subscriptionProviderConfig`, `createSubscriptionCheckout` | ⚠️ Partially exists. Provider-neutral routing, country fallback, private country-specific provider configuration, and the subscription-offerings callables (below) are being completed as an included correction before portal implementation |
| Vendor Portal — Subscription offerings display | `getVendorSubscriptionOfferings()` — authenticated, country resolved server-side only, no client-supplied country | New — part of the same correction above |
| Public Pricing page — offerings display | `getPublicSubscriptionOfferings({ countryCode })` — unauthenticated, accepts visitor-selected country, never authorizes checkout | New — part of the same correction above |
| Vendor Portal — Invoices | `invoices` and related functions (✅ exists, Phase 4) | ✅ Already exists and tested |
| Vendor Portal — Billing history | New vendor-safe projection callable over `subscriptionEvents` | New — thin wrapper over existing data |
| Vendor Portal — Price change policy | `currentMonthlyPriceMinorUnits` on `vendorSubscriptions`, `effectiveFrom` on `subscriptionPricing`, extended renewal job | New — approved, Section 12.3 |

**Sequencing implication unchanged:** portal invoice screens remain the fastest to build since their backend is fully done and tested. Payment/subscription screens (including the price-change policy) proceed once the provider-neutral correction and Section 12 work land.

---

## 11. Performance Notes

**Known scalability trade-offs:** none specific to this package's own new work (landing page, CMS, contact form) at MVP scale — page/content volume is small and fixed (14 pages, a bounded set of `siteContent` documents). The Vendor Portal's subscription and invoice screens inherit whatever performance characteristics the underlying Phase 4 backend already has, including the documented MVP trade-off in ratings aggregation (full recompute, by design, at current low volume — see the separate hardening plan) — this package doesn't introduce new hotspots, it displays existing backend state.

**Expected Firestore read/write pattern:** `siteContent` reads are cheap and cacheable (small, mostly-static document set, public read). `contactSubmissions` writes are rate-limited at the function level (Section 3), bounding write volume regardless of traffic spikes. Vendor Portal billing history and invoice list reads use the same bounded/paginated patterns already established in the mobile app — no new unbounded queries introduced by this package. The renewal job's price re-fetch (Section 12.3) is a single document read per renewing subscription — no new query shape, bounded by daily renewal volume.

**Monitoring/hardening recommended later:** standard Firebase Hosting/Functions monitoring (Section 6.5) covers this package adequately at MVP scale; no dedicated additional monitoring is required specifically for the landing page or CMS beyond what's already scoped.

**New indexes required:** none beyond what's already listed in the location catalogue and Phase 4 specs — this package doesn't introduce new query shapes requiring composite indexes.

---

## 12. Subscription Lifecycle Business Rules

This section locks the MVP behavior for plan changes, price changes, and safe subscription transitions — new product rules that govern the Vendor Portal's (and mobile app's, since the backend is shared) subscription screens, not previously documented anywhere.

### 12.1 Upgrades

1. An upgrade becomes effective only after successful provider payment **and** webhook confirmation — never optimistically on the client.
2. The vendor pays the target plan's **current published country price** at the moment of upgrade, not a historical price from when they first subscribed.
3. The new billing period begins on the upgrade date.
4. **The previous subscription must be safely stopped/replaced so the vendor is never billed for two recurring plans simultaneously.** Confirmed via direct code review that `createSubscriptionCheckout` currently has no logic to detect or cancel an existing subscription before starting a new checkout — this is a required build item, not an assumption of existing behavior. **Approved as part of the 145,000 NGN scope.**
5. No prorated credit or refund for unused time on the previous plan for MVP — cross-provider proration consistency (Paystack/Flutterwave/Stripe) is not attempted at this stage. This must be disclosed to the vendor before checkout confirmation (e.g. *"Your Pro plan will begin immediately and your new monthly billing date will be [date]. Unused time on your current plan is not refundable."*).
6. If payment fails or checkout is abandoned, the existing plan remains unchanged.

### 12.2 Downgrades

1. Downgrades take effect at the end of the current paid billing period, not immediately.
2. The vendor keeps their current (higher) plan's features until that date.
3. At the effective date, the vendor pays the **target plan's current published price at that time** — not a price captured when the downgrade was requested.
4. The vendor may cancel a pending downgrade at any point before it becomes effective, remaining on the current plan.

### 12.3 Price Change & Existing Subscriber Policy — Final, Approved

**Locked product rules:**

1. New subscribers always use the current published country price.
2. Existing subscribers keep their price for the billing period they've already paid for.
3. Upgrades use the current published price immediately after successful payment confirmation.
4. Downgrades take effect at the end of the current billing period, at that plan's price at the effective date.
5. Existing subscribers are **not permanently grandfathered by default.**
6. Existing subscribers pay the new price at their first renewal that occurs **on or after** the price's `effectiveFrom` date.

**Decision: Option 1 for MVP — manual administrative process, not backend-enforced.** The backend does not check, block, or delay a price change based on how much notice vendors have received. Compliance with the notice period is an **operational responsibility**, not a system guarantee, for MVP. Automated enforcement is deferred to a future subscription-management enhancement.

**MVP-required backend implementation:**

- Each vendor's `vendorSubscriptions` document stores its own currently-billed amount (`currentMonthlyPriceMinorUnits`) — set at subscription creation, upgrade, or downgrade, and **never silently changed** by a later edit to the country pricing config. This satisfies rules 1–2: a pricing config change only affects *new* checkout calls, never an already-stored subscription value.
- `subscriptionPricing/{countryCode}` gains an `effectiveFrom` field per plan:
  ```json
  {
    "effectiveFrom": "2026-09-05T00:00:00Z"
  }
  ```
  This is **record-keeping metadata, not an enforcement gate** — the backend does not compare it against the current date to decide whether to apply a price. It exists so the effective date is documented alongside the price itself, and so a future automated-enforcement version has the data it needs without a schema migration.
- The existing renewal-processing function (`expireStaleSubscriptions` or equivalent) is extended to re-fetch the current active country price at each renewal and update `currentMonthlyPriceMinorUnits` to match. This is the actual mechanism that satisfies rule 6 — "current active price" is whatever is published in `subscriptionPricing` at the moment of renewal, which is why the operational policy below requires the admin not to publish a price change until vendors have already had their notice window.
- Upgrade/downgrade logic reads the current price at the moment the change becomes effective (immediately for upgrades, at period-end for downgrades) rather than a value captured at request time. Satisfies rules 3–4.
- Rule 5 (no permanent grandfathering) requires no new code — it's the natural result of the above.

**MVP Operational Policy (manual — not enforced by the backend):**

Administrators must provide **at least 60 days'** advance notice before activating a subscription price increase. The exact procedure:

1. **60 days before the increase:**
   - Email all affected vendors.
   - Send an in-app notification (if available).
   - Update the public pricing page to announce the upcoming change, showing the future effective date.
2. **Wait** until the notice period has actually passed.
3. **On the effective date:** publish the new price in `subscriptionPricing` (with `effectiveFrom` set to that date). From this point:
   - New subscribers pay the new price immediately.
   - Existing subscribers pay the new price at their first renewal on or after the effective date (via the renewal job's price re-fetch, above).

**Never publish a price increase before vendors have already been notified with adequate lead time.** This is the operative rule administrators must follow — the backend will not catch a violation of it for MVP.

**Operational note (no technical implementation required, worth stating anyway):** because a pricing mistake is expensive and, per Option 1, nothing in the backend double-checks a published price, the admin should personally review a pricing change (amount, currency, `effectiveFrom` date) before publishing it — a second look before publish, not a system-enforced approval step.

**Example:**

```
July 5      → Email vendors: "Standard plan increasing from ₦9,900 to ₦12,900 on September 5."
September 5 → Price becomes active in subscriptionPricing (effectiveFrom = Sept 5).
Sept 6 renewal → Vendor pays ₦12,900.
Sept 28 renewal → Vendor pays ₦12,900.
```

**Explicitly deferred to a future enhancement (not built for MVP, not part of this approved scope):**

| Deferred piece | What it would add | MVP consequence of deferring |
|---|---|---|
| Automated advance-notice enforcement (system checks the 60-day window and holds old price if too close to renewal) | The system automatically protects against an admin announcing a price change too close to a vendor's renewal | Manual process discipline only — an admin must personally plan price changes with enough lead time. |
| Automated notification workflow (scheduled email + in-app reminder ahead of a price change) | Vendors get proactively, automatically notified | Notifying vendors is a manual admin action (e.g. a manual email send) rather than automatic. |
| Full price versioning / audit history (`priceVersion`, a complete record of every price a vendor has ever been billed) | A queryable history of pricing changes over time | Only the current price is tracked, not a full historical ledger. Not required by any locked rule above. |
| `pendingPriceChange` shown ahead of time in the Vendor Portal / mobile app UI | Vendor sees "your price is changing to X on [date]" before it happens | The vendor's price simply updates at renewal with no advance UI preview (see Section 4.5's note that no extra UI state is needed for MVP). |
| Provider-side price/plan versioning and automated migration tooling | New provider price objects created and existing subscriptions automatically migrated at renewal | An admin manually creates the new price/plan in each provider's dashboard (Paystack/Flutterwave/Stripe) and updates the mapping — acceptable given price changes are infrequent events. |

**Approved cost:** this section (Section 12.3) plus Section 12.1.4's double-billing prevention plus Section 13 item 17's CMS concurrent-edit handling total **45,000 NGN**, combined with the 100,000 NGN original package balance for **145,000 NGN total** — approved, implementation proceeding.

---

## 13. Edge Cases & Business Rules

Documented situation → expected behavior, at the same level of precision already established for Phase 4's orders/chat/invoice edge cases. Several of these are already true by construction of the existing backend (idempotency, transaction safety); a few describe behavior that isn't built yet and is called out explicitly below.

| # | Situation | Expected behavior |
|---|---|---|
| 1 | Vendor upgrades before renewal | Charged using currently active pricing (Section 12.1) |
| 2 | Vendor downgrades while a future price increase is pending | Downgrade uses the current active price of the downgraded plan at its effective date, not a future increased price |
| 3 | Vendor cancels | No future price migration applies |
| 4 | Vendor re-subscribes months later | Receives current published pricing, not their historical price |
| 5 | Admin manually changes a vendor's plan | Admin override controls entitlements; billing does not change silently as a side effect |
| 6 | Vendor changes business country | Treated as an approved business-location change (per the client's confirmation). Current paid period is unaffected; the new country's pricing applies from the appropriate renewal after the change is approved. **Open item, not yet defined:** the actual approval mechanism (self-service vendor change vs. admin-reviewed request, and any frequency limit) still needs to be specified before this is implementable — flagged for a decision before this edge case is built, not assumed. |
| 7 | A country's pricing is deactivated *or deleted outright* | Identical behavior either way — already true by construction: `requireActiveCountryPricing` treats "no document" and "document exists but not `active`" the same, both returning `PRICING_NOT_CONFIGURED`. Existing subscriptions continue until renewal; no new subscriptions accepted; the Vendor Portal and Pricing page show *"Subscriptions are not available in your country yet"*; admin decides case-by-case whether existing subscriptions continue past that. |
| 8 | Preferred payment provider is down for a country | Backend automatically attempts the next provider in that country's priority order (Section 4); vendor never sees which provider was used |
| 9 | Every configured provider fails | Vendor sees the plain-language unavailable message (Section 4.5) — never an internal error |
| 10 | Checkout opened but never completed | Subscription state remains unchanged |
| 11 | Payment succeeds, webhook delayed | Portal shows "Confirming your subscription…" — never shows the plan as active until the backend confirms |
| 12 | Provider retries a webhook | Backend's existing idempotency (`providerEventId` checks, already in Phase 4) prevents double-processing — *already true by construction, not new work* |
| 13 | Vendor is deleted | Their invoice numbers are never reused |
| 14 | Vendor changes their storefront slug | Already-issued invoice numbers remain unchanged (Section 4.4) — issued invoices are immutable |
| 15 | Contact form receives a spam burst | Rate limiting accepts the first requests within the window, rejects the rest (Section 3) |
| 16 | Duplicate contact form submission | May be flagged `spam` per the duplicate-detection rule (Section 3) |
| 17 | Two admins edit the same CMS page concurrently | *New work, approved:* newest publish wins; the audit log records both edit attempts, not just the winner |
| 18 | Admin saves a CMS draft | Never appears on the public page — only `publish` affects what visitors see (Section 2.1) |
| 19 | A referenced CMS image is deleted from Storage | The published page continues showing the previously published image reference; nothing breaks visibly |
| 20 | Invalid SVG uploaded to CMS | Rejected outright — SVG is not an allowed format at all (Section 2.4) |
| 21 | Vendor's subscription expires | Invoice history remains visible in the portal |
| 22 | Vendor is suspended | Cannot start a new subscription or create invoices; can still view account status (Section 4.1) |
| 23 | Vendor is deactivated | Portal login blocked entirely (Section 4.1) |
| 24 | Visitor changes country on the public Pricing page | Prices refresh without a full page reload |
| 25 | Visitor's selected country has no pricing configured | Shows the unavailable message (Section 1.1); no enabled Subscribe button |
| 26 | A new plan tier is introduced later (e.g. "Enterprise") | Does not require altering any existing vendor's already-active subscription record |
| 27 | Dashboard rollups aren't built yet for a given vendor | Live calculation is used as the current MVP fallback; once rollups exist for that data, reads switch automatically — the frontend contract does not change either way |
| 28 | A Firestore transaction is retried | Never creates a duplicate invoice, subscription, or order — *relies on the same idempotency pattern already used throughout Phase 4* |
| 29 | PDF generation fails | The invoice itself still exists; retrying PDF generation does not create a second invoice |
| 30 | A vendor's account is deleted while they hold a valid session token | Backend rejects the token on next use |
| 31 | An auth token expires mid-session | Standard refresh-and-continue, no special handling needed |
| 32 | Vendor has two browser tabs open, cancels a subscription in one | The other tab reflects the updated state on its next refresh/read, not automatically pushed — no real-time sync is required for MVP |

Items 17 and 32 (concurrent-edit handling and confirming no cross-tab stale-state bug) are the only genuinely new work surfaced by this table, and both are included in the approved 45,000 NGN. Everything else in this table is either already true by construction of the existing Phase 4 backend, or already covered by rules documented elsewhere in this document (cited inline above).

---

## 14. Explicitly Out of Scope

**Included in the original 400,000 NGN package:**
- Admin Web Portal (Phase 5)
- Vendor Portal dashboard, storefront settings, registration/onboarding
- Country/location catalogue work (separate item, already delivered independently)
- Mobile app changes
- Blog, Waitlist, How It Works pages
- Formal accessibility audit/certification (acceptance-criteria-level only, per 6.2)
- Analytics/marketing cookie implementation (unless explicitly added as a scope change, per 6.3)
- Legal/marketing copywriting (the client supplies content, per Section 5)
- Terms version-acceptance/re-consent tracking (documented limitation, post-MVP)
- Invoice actions not listed in Section 4.4 (duplicate, edit draft, cancel, mark-paid, per-invoice branding editing)

**New work approved during this revision, priced at 45,000 NGN (part of the 145,000 NGN total):**
- Section 12.1.4 — upgrade-safe-replace logic (preventing simultaneous double-billing during an upgrade)
- Section 12.3 — Price Change & Existing Subscriber Policy, MVP-required implementation only (Option 1: manual notice process, not automated enforcement)
- Section 13, item 17 — CMS concurrent-edit handling with audit trail

**Explicitly deferred, not part of this or any approved scope yet:**
- Automated price-change notice enforcement, automated notification workflow, full price versioning/audit history, `pendingPriceChange` UI preview, automated provider-side price migration tooling (Section 12.3's deferred table) — a future subscription-management enhancement, to be scoped and priced separately if/when needed
