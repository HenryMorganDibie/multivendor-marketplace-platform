# Phase 3 — implementation matrix

Answers the ten questions raised in review, verified against the code at commit
time rather than from memory. Where something is not built, it says so plainly
and does not describe intent as delivery.

**Summary:** the backend is complete and deployed. The mobile side is wired for
reading invoices, creating them, and recording and reversing payments. Branding,
PDF download, the public link, cancellation and internal chat delivery are not
wired — four of those have working backend callables that nothing in the app
calls, and one (chat delivery) was never built on either side.

---

## 1. Which mobile invoice files read real backend data

Twelve files touch invoices. Four read or write real backend data.

| File | State | What it does |
| --- | --- | --- |
| `contexts/InvoiceContext.tsx` | **Wired** | Live `onSnapshot` on `invoices where vendorId`; `createInvoice`, `recordPayment`, `reversePayment` call real callables |
| `app/vendor/settings/invoices.tsx` | **Wired** | Lists from the context, so backend invoices |
| `app/vendor/settings/create-invoice.tsx` | **Wired** | Creation now persists server-side |
| `app/vendor/settings/send-invoice/[invoiceId].tsx` | **Wired** | Reads the backend invoice |
| `app/vendor/invoice/[orderId].tsx` | Reads context | Backend data, but its own actions (edit, delete, cancel) are local |
| `app/invoice-view/[shareCode].tsx` | **Not wired** | Uses `getInvoiceByShareCode` from local context, not `getPublicInvoice` |
| `contexts/InvoiceBrandingContext.tsx` | **Not wired** | AsyncStorage only |
| `app/vendor/settings/invoice-branding.tsx` | **Not wired** | Writes to the local branding context |
| `lib/invoices/mapInvoiceDoc.ts` | Mapper | Firestore document → app shape |
| `components/InvoiceRenderer.tsx` | Presentational | — |
| `components/invoice-templates/InvoiceTemplateParts.tsx` | Presentational | — |
| `contexts/InvoiceLayoutContext.tsx` | Presentational | — |

The review referred to 11 files; the actual count is 12. Earlier correspondence
from this side said "21 screens", which was wrong and was corrected.

## 2. Are SEED_INVOICES, AsyncStorage and mock vendor data excluded for real accounts?

**Yes for invoices, no for branding.**

`SEED_INVOICES` is only written when `!stored && DEV_LOCAL_AUTH_ENABLED`, and
`DEV_LOCAL_AUTH_ENABLED` is `__DEV__`, which is false in every release build
including EAS preview and production. A shipped build cannot seed fixtures.

The context exposes `backendInvoices ?? invoicesQuery.data ?? []` — the backend
list wins whenever the listener has resolved, including when it resolves empty.
A real vendor therefore never sees fixture invoices.

AsyncStorage persistence still exists behind that, for the demo logins that have
no backend account. It is unreachable for a real account but it has not been
deleted.

`InvoiceBrandingContext` is AsyncStorage only, with no backend path at all — see
question 8.

## 3. Does create invoice persist server-side and survive reinstall or a second device?

**Yes, as of the current commit. It did not before.**

`createInvoice` previously generated an id locally and wrote to AsyncStorage
without calling the backend. It now calls the `createInvoice` callable, and the
canonical copy arrives through the Firestore listener. Nothing is written to
local storage on that path, so there is no duplicate under a second id.

Because the invoice is a Firestore document, it survives reinstall and appears
on a second device at login.

Two things were fixed alongside it, both of which affected reading and not just
creating:

- `mapInvoiceDoc` produced `lineItems`, but the `Invoice` interface calls the
  field `items` and every screen does `invoice.items.map(...)`. A backend
  invoice therefore arrived with `items` undefined and opening one threw. Not an
  empty list — a crash, already live in the read path. The mapper's
  `as unknown as Invoice` cast is why the compiler never flagged it.
- Currency was taken from the request and defaulted to `NGN`. It is now derived
  server-side from the vendor's country. See question 10 of the separate
  currency note.

**Verified** by an automated end-to-end run against the deployed `platform-dev`
project. **Not yet verified on a device** — see question 9.

## 4. Do internal customer invoices store real customer and conversation IDs and post a card into chat?

**No. This is not built, on either side.**

`createInvoice` writes `customerId: null` as a literal and does not accept a
customer id in its payload. No code path anywhere posts an invoice card into a
conversation, and nothing writes `chatId` onto an invoice.

The invoice detail screen shows an "Open chat" action when `chatId` exists.
Since nothing ever sets it, that action cannot fire. The review described this
as unproven; it is more accurate to call it absent.

This is new build, not a wiring gap.

## 5. Does draft editing call a real backend update function?

**No, and no such function exists.**

The invoice callables are exactly: `createInvoice`, `listInvoices`,
`downloadInvoicePdf`, `duplicateInvoice`, `updateInvoiceStatus`,
`getPublicInvoice`, `updateInvoiceBranding`, `cleanupExpiredInvoiceVisibility`.

There is no general-purpose `updateInvoice`. `updateInvoiceStatus` changes
status only and, by design under the ledger, refuses `paid`.

The app's `updateInvoice` writes to AsyncStorage. For a real account, where the
backend list wins, an edit therefore has no visible effect.

## 6. Is Delete Draft backend-backed or local?

**Local, and for a real account it does nothing at all.**

`deleteInvoice` filters the AsyncStorage list. The displayed list comes from
`backendInvoices`. So deleting a backend invoice neither removes it server-side
nor removes it from the screen.

This is worse than "local only" and is worth treating as a defect rather than a
deferral.

## 7. Why was Duplicate Invoice removed from the mobile menu?

It was **deliberately hidden as post-MVP**, with an explicit comment at
`app/vendor/invoice/[orderId].tsx`: *"Duplicate Invoice is a post-MVP feature and
is never shown."*

The backend `duplicateInvoice` callable exists, works, and is gated by
`canDuplicateInvoice` with its own quota consumption.

Since it was in the agreed Phase 3 scope and the backend half is done, hiding it
was the wrong call. Restoring it is a small change: surface the action and call
the existing callable.

## 8. Is branding — logo upload, retrieval, plan gating — wired end to end?

**No. None of it.**

`InvoiceBrandingContext` reads and writes AsyncStorage only. It never calls
`updateInvoiceBranding`, and there is no upload to Firebase Storage anywhere in
the app, so `logoUrl` is never populated by a real upload.

The backend side is complete: `updateInvoiceBranding` exists,
`filterBrandingByPlan` enforces plan gating, and a paid invoice freezes its
`brandingSnapshot` so a receipt keeps the look it had when it settled.

So branding is a fully built backend feature with no client calling it.

## 9. Have public links, cancellation revocation and PDF sharing been tested from the app?

**No, and none of the three are wired.**

Searching the whole app for `downloadInvoicePdf`, `getPublicInvoice` and
`updateInvoiceStatus` returns nothing. All three callables are deployed and
unused.

`app/invoice-view/[shareCode].tsx` resolves via `getInvoiceByShareCode` from the
local context rather than `getPublicInvoice`, so the public view renders local
data and would show nothing for an invoice the device did not create.

No device testing has been performed on any of this, for the reason in
question 10.

## 10. Automated tests and device evidence

**Automated, backend, against the emulator** — 11 suites, 121 checks, all
passing: phase1 11, phase2 20, phase3-ledger 12, price-reconciliation 11,
sales 6, location 12, rate-limit 7, orphan 14, orders 13, discovery 8,
country-availability 7.

Phase 3's twelve cover the sequence set in review: an order, an invoice raised
from it, one payment, and revenue reporting it once. Also idempotent retry,
partial payment, overpayment, reversal, reversal exceeding the remainder,
`updateInvoiceStatus` refusing `paid`, and a vendor being refused another
vendor's invoice.

**Automated, against the deployed project** — `scripts/dev-smoke-test.js`, 14
checks against real `platform-dev`: registration through the deployed callable,
custom claims, seeded countries, category and item creation, invoice creation,
revenue moving by exactly the amount paid, ledger-derived `paid` status, zero
balance, a replayed payment not double-counting, and the dashboard returning
real figures rather than the previously hardcoded ones.

**Device evidence: none.**

No build has been installed on a device. The EAS build fails with
`Entity not authorized` because the Expo app belongs to the Platform account and
the contractor account is not a member of it. Until that access exists, or a
build is produced from the owning account, nothing here can be exercised on a
handset. Everything in this document was verified by reading code and by
automated runs against the live project.

---

## Correction to the Phase 3 acceptance document

The original scope said invoices are marked paid through `updateInvoiceStatus`.
That is no longer true and should not be reinstated.

- Payment state is **derived** from the payment ledger. `recordPayment` and
  `reversePayment` write rows; `recomputeInvoiceFromLedger` derives
  `unpaid | partial | paid | overpaid | cancelled` from their sum.
- `updateInvoiceStatus` handles **cancellation only** and explicitly rejects
  `paid` with `invalid-argument`.
- Corrections are reversal rows, never edits or deletions, so the history stays
  intact and auditable.

A concurrency defect raised in review has been fixed: the ledger sum was
computed above the transaction and closed over, so a Firestore retry re-ran with
a stale total and two concurrent payments could overwrite one another's figure.
The query is now read through the transaction.

---

## What remains

| Item | Backend | Mobile | Classification |
| --- | --- | --- | --- |
| Create invoice | Done | **Done** | Complete |
| List / read invoices | Done | **Done** | Complete |
| Record / reverse payment | Done | **Done** | Complete |
| Delete draft | — | Broken | **Defect** |
| Duplicate invoice | Done | Hidden | **Defect** — in scope, backend done |
| Branding + logo upload | Done | Not wired | **Wiring** |
| PDF download | Done | Not wired | **Wiring** |
| Public invoice link | Done | Not wired | **Wiring** |
| Cancellation | Done | Not wired | **Wiring** |
| Edit draft | **Missing** | Local only | **New build** |
| Internal chat delivery | **Missing** | Not built | **New build** |

Six items have a working backend and no client calling it. Two need backend work
that does not exist. Two are defects in delivered work and are being fixed
without further discussion.
