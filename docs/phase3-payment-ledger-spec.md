# Phase 3 — Payment ledger and invoice wiring

**Status: proposed. Not started, pending written approval.**

Scope frozen around a single canonical record of money received, with invoice
status derived from it rather than set by hand.

---

## 1. Why a ledger

An invoice and an order can each record the same payment today. A vendor raises
an invoice from an order, the customer pays it, and that money exists in two
places with nothing linking them.

The app currently avoids double-counting by skipping any invoice that carries an
`orderId` when it totals revenue. That works, but it is a rule about which list
to ignore rather than a single source of truth, and it means the two sides never
have to agree. It also cannot express a partial payment, because status is a
field somebody sets rather than a conclusion drawn from what was actually
received.

One list of payments, each linked to whatever caused it, removes both problems.
Revenue becomes the sum of that list. Status becomes a function of it.

---

## 2. Schema

### `payments/{paymentId}`

A top-level collection, not a subcollection, because a payment may relate to an
order, an invoice, or both, and nesting it under either would make the other a
second-class reference.

```typescript
interface PaymentDoc {
  paymentId: string;
  vendorId: string;                    // always present: payments belong to a vendor
  customerId?: string | null;          // absent for a walk-in recorded by the vendor

  amountMinorUnits: number;            // integer minor units, never a decimal
  currency: string;                    // ISO 4217, from the vendor's country

  // What this payment was for. At least one must be present. Both may be, and
  // that is precisely the case the ledger exists to handle.
  orderId?: string | null;
  invoiceId?: string | null;

  method: "cash" | "transfer" | "card" | "other";
  reference?: string | null;           // vendor's own reference, a transfer ref

  // Who recorded it. A customer submitting proof is not the same as a vendor
  // confirming receipt, and the distinction matters when money is disputed.
  recordedBy: string;                  // uid
  recordedByRole: "vendor" | "customer" | "admin" | "system";

  // A reversal is a row, never a deletion. See section 4.
  type: "payment" | "reversal";
  reversesPaymentId?: string | null;   // set only on a reversal
  reversalReason?: string | null;

  status: "recorded" | "reversed";     // a payment that has been reversed
  idempotencyKey: string;              // see section 3

  paidAt: Timestamp;                   // when the money moved, vendor-supplied
  createdAt: Timestamp;                // when we learned about it
  updatedAt: Timestamp;
}
```

**Amounts are integer minor units**, matching `subscriptionPricing`. A reversal
carries a positive amount and is subtracted by its `type`, rather than being
stored as a negative number — a negative amount in a financial record is a
mistake waiting to be summed incorrectly.

### What changes on `invoices/{invoiceId}`

`status` stops being written directly and becomes derived. The field remains, as
a cached projection for querying and display, but only the ledger writes it.

```typescript
  status: InvoiceStatus;               // derived, no longer client-settable
  amountPaidMinorUnits: number;        // sum of the ledger for this invoice
  balanceMinorUnits: number;           // total − amountPaid, may be negative
  lastPaymentAt?: Timestamp | null;
```

`paidAt` stays and means the moment the balance first reached zero.

---

## 3. Idempotency and duplicate prevention

Three separate problems, each needing its own answer.

**A retried request must not create a second payment.** Every write carries an
`idempotencyKey` supplied by the caller, and the document id *is* that key
hashed with the vendor id. A repeat is a write to the same document, which is
inherently idempotent. The callable returns the existing payment rather than an
error, so a client that retried after a dropped connection sees success.

**A vendor pressing "record payment" twice must not double-count.** The client
generates one key when the form opens, not when it submits. Two taps carry the
same key. This is the ordinary case and matters far more than the exotic ones.

**The same money arriving through two routes must count once.** This is the
double-counting problem the ledger exists for, and the key does not solve it,
because the two routes legitimately produce different keys. Instead:

- an invoice generated from an order carries that `orderId`
- a payment recorded against such an invoice is written with **both** ids
- revenue sums the ledger, so it is counted once regardless of which screen
  recorded it
- recording a payment against an order that already has a fully-paid linked
  invoice is refused with `failed-precondition`, naming the invoice

**What is deliberately not prevented:** a vendor recording two genuinely separate
payments of the same amount on the same day. That is real and common — two
customers paying ₦5,000 each. Only an identical idempotency key is treated as a
duplicate.

---

## 4. Corrections, reversals and refunds

**Nothing is ever deleted, and no amount is ever edited.**

A correction is a new row of `type: "reversal"` pointing at the payment it
undoes, carrying a reason. The original keeps its `status: "recorded"` history
but gains `status: "reversed"`, and both remain readable forever. The balance
recomputes from the sum, so the invoice returns to whatever state the remaining
payments imply.

Three cases, all the same mechanism:

| Case | What happens |
|---|---|
| Recorded in error | Reversal for the full amount, reason "recorded in error" |
| Refund to the customer | Reversal for the refunded amount, reason "refunded" |
| Wrong amount entered | Reversal of the original, then a new payment at the correct amount |

The last one is deliberately two rows rather than an edit. The history then
shows what was believed, and what corrected it, which is what an audit needs.

**A reversal cannot exceed what remains.** Reversing ₦5,000 of a ₦3,000 payment
is refused. A partial reversal is allowed, and a payment may be partially
reversed more than once, up to its original amount.

**Reversals are permitted by the vendor who owns the invoice, or an admin.** A
customer cannot reverse a payment; they can dispute it, which is a support
matter rather than a ledger write.

---

## 5. Partial and overpayments

Status is derived, never set:

```
paid       = balance <= 0 and at least one payment exists
partial    = amountPaid > 0 and balance > 0
unpaid     = amountPaid == 0
overpaid   = balance < 0
cancelled  = set by cancelInvoice, independent of payments
```

`overdue` stays a display concern: unpaid or partial, with a due date in the
past. It is not stored, because it changes with the clock rather than with an
event.

**In the UI:** an invoice showing `₦8,600` total with `₦3,000` paid displays a
balance of `₦5,600` and a status of Partial. The screenshot in the client's
message already shows this shape, so the display exists; the numbers behind it
do not.

**Overpayment is recorded, not rejected.** A customer paying ₦9,000 against an
₦8,600 invoice has really done so, and refusing to record it would make the
ledger disagree with the bank. The invoice shows Overpaid with a negative
balance, and resolving it — refund, or credit against the next invoice — is a
decision the vendor makes, recorded as a reversal or a payment against another
invoice.

---

## 6. Replacing "mark as paid"

**Confirmed.** `updateInvoiceStatus` currently accepts `paid` and writes it
directly. That path is removed.

- `updateInvoiceStatus` keeps `cancelled` only, which is a genuine status change
  rather than a financial event
- marking an invoice paid becomes `recordPayment` for the outstanding balance
- the existing button keeps its label but records a payment for the balance,
  so the common case stays one tap

Existing invoices carrying `status: "paid"` with no ledger rows are migrated
once: one payment row per paid invoice, at the invoice total, dated `paidAt`,
`recordedByRole: "system"`, `method: "other"`, reference noting it as migrated.
Without that, historical revenue would drop to zero on the day this ships.

---

## 7. Dashboard figures moving to the ledger

**Moving in Phase 3:**

| Figure | Becomes |
|---|---|
| Today's revenue | Sum of ledger payments dated today, minus reversals |
| Total revenue | Sum of the whole ledger for the vendor |
| Outstanding balance | Sum of unpaid and partial invoice balances |
| Invoice list totals and statuses | Derived from the ledger |

**Not moving, and reserved for later phases:** the Business Insights page,
platform versus external comparison, revenue by day charts, best seller, and
anything comparing periods. Those are Phase 5 and the existing
`getBusinessAnalytics`, and remain gated on the paid plan.

The line is: **Phase 3 delivers correct totals. Later phases deliver analysis of
them.**

---

## 8. The invoice screens and routes

**Correction to an earlier figure.** This was previously quoted as 21 screens.
The accurate number is **11 files**, listed below by name. The 21 came from a
count of import sites rather than of screens, and overstating the surface would
make this harder to check rather than easier.

**Fully wired in Phase 3:**

| Screen | Route |
|---|---|
| Invoice list | `app/vendor/settings/invoices.tsx` |
| Create invoice | `app/vendor/settings/create-invoice.tsx` |
| Send invoice | `app/vendor/settings/send-invoice/[invoiceId].tsx` |
| Invoice from order | `app/vendor/invoice/[orderId].tsx` |
| Public invoice view | `app/invoice-view/[shareCode].tsx` |
| Invoice card, vendor side | `features/chat/components/InvoiceChatCard.tsx` |
| Invoice card, customer side | `features/chat/components/CustomerInvoiceChatCard.tsx` |
| Vendor order chat | `features/chat/screens/VendorOrderChatScreen.tsx` |
| Vendor chat thread | `app/vendor/chats/[orderId].tsx` |
| Dashboard revenue figures | `app/vendor/(tabs)/dashboard/index.tsx` |

**Partially wired:** the dashboard reads real revenue from the ledger, but its
insight carousel and best-seller widget stay as they are — those belong to
Phases 5 and 6.

**Deferred:** `app/vendor/growth-insights.tsx` reads invoice data for analysis
rather than for totals. It is Business Insights, Phase 5, and stays on its
current source until then.

---

## 9. Callables

**New:**

| Callable | Purpose |
|---|---|
| `recordPayment` | Writes a payment. Idempotent. Recomputes invoice status |
| `reversePayment` | Writes a reversal against an existing payment |
| `listPayments` | The ledger for an invoice, an order, or a vendor |
| `getVendorRevenue` | Ledger-backed totals for the dashboard |

**Changed:**

| Callable | Change |
|---|---|
| `updateInvoiceStatus` | Accepts `cancelled` only. `paid` is refused with a message pointing at `recordPayment` |
| `createInvoice` | Initialises `amountPaidMinorUnits: 0` and a derived status |
| `listInvoices` | Returns the derived status, paid amount and balance |
| `getPublicInvoice` | Same, so a customer sees a true balance rather than a binary |

**Called by mobile:** `recordPayment`, `reversePayment`, `listPayments`,
`getVendorRevenue`, plus the existing `createInvoice`, `listInvoices`,
`duplicateInvoice`, `updateInvoiceStatus`, `downloadInvoicePdf`,
`getPublicInvoice`.

**Unchanged and not called by mobile:** `updateInvoiceBranding` is Phase 4
storefront work.

---

## 10. Acceptance

Every criterion the client set, as an automated check:

1. **The double-count test, as the client specified it.** Create an order.
   Raise an invoice from that order. Record one payment against the invoice.
   Confirm vendor revenue reports that amount **once**, not twice — asserted
   against `getVendorRevenue`, not against a screen, so it cannot pass by a
   display coincidence
2. Recording the same payment twice with one idempotency key produces one row
   and returns success both times
3. A partial payment derives the correct balance and a status of `partial`
4. Paying the remaining balance derives `paid` and stamps `paidAt`
5. An overpayment derives `overpaid` with a negative balance and is not refused
6. A correction writes a reversal; the original row still exists afterwards
7. A reversal larger than the remaining amount is refused
8. Reversing a payment on a paid invoice returns it to `partial` or `unpaid`
9. `updateInvoiceStatus` refuses `paid`
10. A customer cannot record or reverse a payment on another vendor's invoice
11. Migrated historical invoices produce the same revenue total as before
12. Every screen in section 8 reads the backend, with no mock import remaining

---

## 11. What this does not include

Stated so it is not assumed:

- Taking payments. Platform does not process money; the ledger records payments
  arranged directly between vendor and customer
- Payment provider integration for invoices, which is a different question from
  subscriptions
- Business Insights, comparisons and charts, which are Phase 5
- Multi-currency within one vendor. A vendor's payments are in their country's
  currency
- Automated reconciliation against a bank feed
