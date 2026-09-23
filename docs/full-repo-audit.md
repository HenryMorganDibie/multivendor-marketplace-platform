# Full repository audit

Requested after the observation that things listed as done are still missing.
That is correct, and this is the honest inventory rather than a defence.

Method: every callable exported by the backend, checked against whether the
mobile app references it anywhere. Then the findings verified individually,
because an automated cross-reference produces false positives and a wrong audit
is worse than none.

---

## The headline finding

**The dashboard's revenue figure does not come from the payment ledger.**

`getVendorDashboard` computes `todayRevenue` by summing **orders**
(`dashboardAnalytics.ts:68-76`). `getVendorRevenue`, the ledger-backed function,
is **not called by anything in the app**.

This matters for three reasons:

1. **The Phase 3 spec says otherwise.** Section 8 lists "Dashboard revenue
   figures" under *Fully wired in Phase 3*, and Section 9 lists
   `getVendorRevenue` under *Called by mobile*. Neither is true.

2. **It reintroduces the exact problem the ledger was built to remove.** Revenue
   derived from orders cannot express a partial payment, cannot account for a
   reversal, and double-counts an order that also has an invoice. The ledger
   exists precisely because those two lists disagreed. The dashboard is still
   reading one of them.

3. **A second revenue implementation lives in the app.**
   `utils/invoiceRevenue.ts` re-implements the double-counting guard —
   "invoices linked to orders whose ids are in linkedOrderIds" — client-side.
   That is the workaround the ledger replaced, still running.

So a vendor can record a payment, see it in their invoice list, and see a
different figure on their dashboard. Both come from real data. They disagree
because they are computed from different sources.

**Classification: unfinished Phase 3 work.** It is named in the Phase 3 spec and
is not new scope.

## Callable coverage

| | Count |
|---|---:|
| Callables exported by the backend | 125 |
| Referenced anywhere in the mobile app | 35 |
| Firestore triggers and scheduled jobs (never client-called) | 14 |
| Admin console or vendor portal surface | 20 |
| **Vendor/customer app surface, not referenced** | **56** |

The 56 need per-item judgement rather than a blanket claim, and this document
does not assert all 56 are gaps. Three verified so far:

- `getVendorRevenue` — the finding above.
- `listPayments` — a vendor cannot see the payment history behind an invoice
  from the app, though the ledger records it and the callable is deployed.
- `getBusinessAnalytics` — Business Insights reads its own computation rather
  than this.

The remaining 53 are listed in the working file and each needs checking against
the spec that ordered it. That work is not finished and this document does not
pretend it is.

## What was fixed during this audit

None of these were raised in review; they were found while checking.

| Finding | Where |
|---|---|
| `getPublicInvoice` takes `shareToken`; the app sent `shareCode` — every public link lookup would have failed | Fixed |
| `chatThreads.participants` indexed as an equality field while the query uses `array-contains` — inbox would throw on the real project | Fixed, deployed |
| `getVendorRevenue` scanned every payment row a vendor ever received, per dashboard open | Fixed: maintained total |
| `invoice.items` undefined on every backend invoice — opening one crashed the screen | Fixed |
| Delete Draft filtered a list nobody rendered — did nothing at all | Fixed |
| Duplicate Invoice hidden behind a "post-MVP" comment while its callable was complete | Restored |

## Standing structural risk

`cleanupExpiredInvoiceVisibility` reads every non-hidden invoice **across all
vendors** on a schedule. It works now and has no natural ceiling. When it
eventually times out the symptom is old invoices quietly not being hidden, which
nobody will notice.

## What this audit does not cover

Stated so the gaps in the audit are not mistaken for absence of gaps:

- **The vendor portal and admin console** were not examined. The 20 callables
  classified as portal-side were classified by name, not by checking a caller
  exists.
- **Customer-side screens** were not audited to the depth the vendor side was.
- **No device testing.** Everything here is from reading code and from automated
  runs against `platform-dev`.
- **The remaining 53 callables** need individual checks against the spec that
  ordered them.

## Position on scope

Everything named in this document that appears in a delivered specification is
unfinished work under that specification, not new work. Where something is
genuinely outside every spec, the correct response is to identify which document
should have covered it — not to reclassify it after the fact.

The Section 8 episode is the precedent: a specification written by this side
listed screens as fully wired that were not, and calling the remainder new work
contradicted our own document. That judgement was wrong and the same error
should not be repeated here.
