# Platform — architecture review

Written after wiring Phases 3-6 and closing Section 8, so this is a view from
inside the code rather than a read of it. Findings are ranked by what will
actually cause harm, not by how untidy they look.

Scope: `this repo` (99 TypeScript files, ~14k lines) and `multivendor-marketplace-mobile`
(~170k lines across app, components, contexts, features, services).

---

## 1. Architecture as it stands

### Backend — sound

```
functions/src/
  auth/  vendors/  catalog/  orders/  invoices/  payments/
  chat/  subscriptions/  moderation/  admin/  locations/  utils/
```

One folder per domain, callables at the edge, shared helpers in `utils/`. Money
is integer minor units throughout. Ownership is resolved from the stored
document rather than the request, consistently — the pattern is followed even in
functions written months apart.

The payment ledger is the strongest part: one canonical record, corrections as
reversal rows rather than edits, and invoice status derived from the sum rather
than stored. That design is why a concurrency bug found in review was a
three-line fix rather than a data migration.

**Nothing here needs restructuring.** The problems are in specific queries, below.

### Mobile — two data layers, one switch

```
app/ (226 files, 103k lines)   screens
contexts/ (56)                 state, one per concern
services/ (39)                 chatService, orderService, …
mocks/ (8, 4.8k lines)         fixtures + types + some real logic
lib/                           backend mappers and calls
```

The significant fact is that **two complete data layers coexist**: a fixture
layer the paid frontend was built against, and a Firestore layer added during
wiring. `DEV_LOCAL_AUTH_ENABLED` picks between them at ~15 call sites.

That was the right call for delivery — it let screens ship before the backend
existed, and it keeps demo logins working. It is now the single largest source
of defects in this codebase, and every bug found in review traces to it:

- invoice creation wrote to the fixture layer while the screen rendered the real one
- Delete Draft filtered a list nobody was looking at
- branding saved to a device the PDF renderer cannot read
- `mapInvoiceDoc` produced `lineItems` while every screen read `items`

None of those were logic errors. They were **two sources of truth disagreeing
about which one was authoritative**.

---

## 2. Critical problem areas

### 2.1 Unbounded reads on the money path — highest risk

`readLedger.ts:89` — `getVendorRevenue`:

```ts
const snap = await db.collection("payments").where("vendorId", "==", vendorId).get();
```

Every payment the vendor has ever received, loaded into function memory, on
every dashboard open. No limit, no date bound.

At 200 payments this is invisible. At 50,000 it is a slow, expensive function
that will eventually exceed its memory allocation — and it fails at exactly the
moment the vendor is most valuable. The same pattern is in
`dashboardInsights.ts:40` for orders.

**This is the one thing in this review I would fix before more features.** It is
not a style problem; it is a function that gets slower forever.

### 2.2 A scheduled job that scans the whole collection

`cleanupExpiredInvoiceVisibility.ts:17` reads every non-hidden invoice **across
all vendors**, not one vendor's. It works now because there are few invoices.
It has no natural ceiling and will time out silently at some point, and nobody
will notice because the symptom is old invoices not being hidden.

### 2.3 A 4,817-line screen

`app/vendor/chats/[orderId].tsx`. Order chat, invoice preview, payment proof
review, pinned order cards, change requests and a composer in one file. Six
screens over 2,000 lines each sit behind it.

This is a maintainability problem rather than a correctness one, but it is why
that file was the last to come off mock data: nobody could see what it touched.

### 2.4 Currency formatting duplicated across 58 files

Every screen re-derives how to display money. That is how invoices and
catalogue items ended up defaulting to NGN while orders correctly read the
vendor's country — the rule existed in one place and was re-implemented in
another.

---

## 3. Refactoring strategy

Ordered by value per unit of risk. Each is independently shippable.

### Priority 1 — bound the money queries

Two changes, both contained:

1. **Cache running totals on the vendor document.** `recomputeInvoiceFromLedger`
   already runs on every payment; have it increment
   `vendors/{id}.revenueTotalMinorUnits` in the same transaction. Revenue then
   becomes one document read instead of a full collection scan.
2. **Bound the remaining queries by date.** The dashboard needs today and this
   week; it does not need every order ever placed.

Do not do this by adding a `limit()` — a truncated sum is worse than a slow
correct one. The total has to become a maintained figure.

### Priority 2 — collapse the two data layers

The fixture layer has done its job. Now that every Section 8 screen reads real
data, `DEV_LOCAL_AUTH_ENABLED` branching can be removed one context at a time,
leaving a single authoritative source.

Doing it per context keeps each change reviewable. Doing it all at once produces
the sort of diff that hides a regression, which matters while every commit is
being read.

### Priority 3 — one currency module

A single `resolveDisplayCurrency(entity, vendor)` with the fallback rule stated
once. The backend already did this — `vendors/vendorCurrency.ts` — after the
same duplication caused a real bug. The client needs the same treatment.

### Priority 4 — split the largest screens

Extract by feature boundary, not by line count: payment proof review, invoice
preview and the pinned order rail are three independent things sharing a file.

---

## 4. What is already good and should not be touched

Worth stating plainly, because reviews tend to list only faults:

- **The ledger design.** Reversals rather than edits, derived status, integer
  minor units. It survived a concurrency bug, a migration and a client audit
  without a schema change.
- **Server-side authority on money.** Currency, invoice numbers, share tokens
  and card contents are all decided by the backend. A client cannot state an
  amount. That is why "post an invoice into a chat" could be added safely.
- **Plan gating lives on the server.** Every attempt to re-derive it client-side
  has produced a bug — Basic vendors seeing Standard widgets, Pro capped at a
  third of its real limit. The rule of letting the server refuse and showing its
  message is correct and should stay.
- **Domain folders in the backend.** Ninety-nine files and no ambiguity about
  where anything belongs.

---

## 5. Honest limits of this review

- **No profiling was run.** The performance findings are from reading queries,
  not from measurement. They are structural claims — an unbounded scan is
  unbounded regardless of current volume — but the actual cost is unmeasured.
- **No device testing informs this.** The APK was only buildable at the end of
  this work.
- **The mobile codebase is ~170k lines and this review read a fraction of it.**
  The findings are real; the list is not exhaustive.
