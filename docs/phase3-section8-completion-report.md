# Phase 3 — Section 8 completion report

Requested against Section 8 and Acceptance Criterion 12 of
`phase3-payment-ledger-spec.md`.

## The correction first

The review is right and the earlier position from this side was wrong.

Section 8 of that spec lists Create invoice, Send invoice, both invoice chat
cards, Vendor order chat and Vendor chat thread under **"Fully wired in Phase
3"**. Criterion 12 states *"Every screen in section 8 reads the backend, with no
mock import remaining."* That document was written and pushed before Phase 3
work began.

Calling mobile invoice creation or the invoice chat cards "new build" therefore
contradicts a specification this side authored. It is unfinished Phase 3 work,
inside the ₦130,000 already paid, and no additional quote is being sought for
anything in Section 8. That framing is withdrawn.

Two items genuinely fall outside Section 8 and are noted at the end, but nothing
in this report is being billed again.

---

## File-by-file against Section 8

Status is judged by criterion 12: does the screen read backend data, and does it
still import mocks.

| # | Screen | File | Backend data | Mock imports | Status |
|---|---|---|---|---|---|
| 1 | Invoice list | `app/vendor/settings/invoices.tsx` | Yes, via `useInvoices()` | `mockVendor` (currency fallback) | **Nearly done** |
| 2 | Create invoice | `app/vendor/settings/create-invoice.tsx` | Yes, as of `f1535bf9` | 5 | **Nearly done** |
| 3 | Send invoice | `app/vendor/settings/send-invoice/[invoiceId].tsx` | Yes, via `useInvoices()` | 3 | **Nearly done** |
| 4 | Invoice from order | `app/vendor/invoice/[orderId].tsx` | Yes, via `useInvoices()` | 12 | **Partial** |
| 5 | Public invoice view | `app/invoice-view/[shareCode].tsx` | **No** — local `getInvoiceByShareCode`, never `getPublicInvoice` | 6 | **Not done** |
| 6 | Invoice card, vendor | `features/chat/components/InvoiceChatCard.tsx` | Partly — `useInvoices()` for the invoice, `mockVendor` for name and currency | 4 | **Partial** |
| 7 | Invoice card, customer | `features/chat/components/CustomerInvoiceChatCard.tsx` | Partly | 1 | **Partial** |
| 8 | Vendor order chat | `features/chat/screens/VendorOrderChatScreen.tsx` | **No** | 16 | **Not done** |
| 9 | Vendor chat thread | `app/vendor/chats/[orderId].tsx` | **No** — `getChatByOrderId`, `mockOrders`, `MOCK_VENDOR_ID` | 19 | **Not done** |
| 10 | Dashboard revenue | `app/vendor/(tabs)/dashboard/index.tsx` | Yes for revenue and insights | 7 | **Partial** |

**Four of ten meet criterion 12 in substance. Three do not read the backend at
all. Three read it but still carry mock fallbacks.**

---

## What is fully backend-wired

| Capability | Evidence |
|---|---|
| Invoice list and detail read | Live `onSnapshot` on `invoices where vendorId` — `2e38a55d` |
| Invoice creation persists server-side | `createInvoice` callable — `f1535bf9` |
| Customer and conversation binding stored | `createInvoice` accepts `customerId` / `conversationId` — this commit |
| Record payment | `recordPayment` callable — `2e38a55d` |
| Reverse payment | `reversePayment` callable — `2e38a55d` |
| Delete draft | `deleteInvoice` callable — this commit |
| Duplicate invoice | `duplicateInvoice` callable, restored to the menu — this commit |
| Derived paid status | Ledger-derived, `updateInvoiceStatus` refuses `paid` — `e3c405f` |
| Dashboard revenue | `getVendorRevenue` — `2e38a55d` |
| Currency | Derived from vendor country — `4383b3f` |

## What still uses AsyncStorage, mocks or local state

| Item | Where | Note |
|---|---|---|
| Draft editing | `updateInvoice` in `InvoiceContext` | AsyncStorage only. No `updateInvoice` callable exists — see below |
| Branding and logo | `InvoiceBrandingContext` | AsyncStorage only; `updateInvoiceBranding` exists and is uncalled |
| Public invoice view | `app/invoice-view/[shareCode].tsx` | Resolves locally; `getPublicInvoice` uncalled |
| PDF download | Nothing calls it | `downloadInvoicePdf` exists and is uncalled |
| Cancellation | Nothing calls it | `updateInvoiceStatus` exists and is uncalled |
| Vendor chat thread | `app/vendor/chats/[orderId].tsx` | `getChatByOrderId`, `mockOrders`, `MOCK_VENDOR_ID` |
| Vendor order chat | `features/chat/screens/VendorOrderChatScreen.tsx` | Mock message source |
| Invoice cards | Both chat card components | Invoice is real; vendor name and currency come from `mockVendor` |
| Vendor identity | Several Section 8 files | `mockVendor` fallback; `VendorContext` exists and should be the source |

## Remaining under existing Phase 3 scope

In the order they should be done, because each unblocks the next.

1. **Replace `mockVendor` with `VendorContext`** across Section 8 files. Small,
   and it clears criterion 12 for items 1, 3, 6, 7.
2. **Wire the public invoice view** to `getPublicInvoice`. The callable is
   finished; the screen resolves locally, so a customer opening a link on a
   device that did not create the invoice sees nothing.
3. **Wire PDF download and cancellation.** Both callables are finished and
   uncalled.
4. **Wire the chat thread and order chat screens** to real conversations.
   Largest remaining item and the prerequisite for anything invoice-in-chat.
5. **Post the invoice card into the conversation.** The binding is now stored,
   so this becomes possible; it was not while `customerId` was hardcoded `null`.
6. **`updateInvoice` callable** for draft editing. The only item here requiring
   backend work that does not exist. Section 8 lists Create invoice as wired and
   the app has always offered Edit Draft, so it belongs to this scope.

## Outside Section 8

Recorded for completeness, not billed here, and not claimed as done:

- The end-to-end ordering flow — `repriceCart`, promotion validation, the
  order-versus-payment status split. Not in the Phase 3 spec.
- `updateInvoiceBranding` wiring. The Phase 3 spec itself assigns branding to
  Phase 4 storefront work.

---

## Defects found and fixed while preparing this report

Listed because they affect Section 8 screens and were not raised in review.

- **`invoice.items` was undefined on every backend invoice.** `mapInvoiceDoc`
  produced `lineItems` while the `Invoice` interface and every screen use
  `items`. Opening a backend invoice threw on `.map` — a crash, not an empty
  list. Hidden by an `as unknown as Invoice` cast. Fixed in `f1535bf9`.
- **Delete Draft did nothing.** It filtered the local list while the screen
  rendered the backend list, so it neither deleted server-side nor removed the
  row. Now backed by a real `deleteInvoice` callable that refuses anything with
  history and requires cancellation instead.
- **Duplicate Invoice was hidden** behind a "post-MVP" comment while its
  callable was complete and quota-gated. Restored.
- **Ledger concurrency race** — raised in review, fixed in `23280fa`.
- **`firstSeenAt` reset on every occurrence** — raised in review, fixed in
  `23280fa`. The same defect applied to `resolved`, which silently reopened
  discrepancies an admin had closed; also fixed.
- **Currency defaulted to NGN** for invoices and catalogue items while orders
  derived it correctly from the vendor's country. Fixed in `4383b3f`.

## Test and deployment position

- 11 emulator suites, 121 checks, passing.
- `scripts/dev-smoke-test.js`, 14 checks against the deployed `platform-dev`
  project: registration, claims, seeded countries, catalogue, invoice creation,
  revenue counted once, ledger-derived status, replay not double-counting,
  dashboard figures.
- 122 functions deployed to `platform-dev` with rules, indexes and storage rules.
- **No device evidence.** The EAS build fails with `Entity not authorized`
  because the Expo app belongs to the Platform account. Nothing here has been
  exercised on a handset, and it cannot be until that access exists.
