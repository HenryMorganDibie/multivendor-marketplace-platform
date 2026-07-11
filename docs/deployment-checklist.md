# Deployment Checklist

This is a review checklist, not something already executed against a live Firebase project — nobody has deployed this codebase yet. Work through it in order before running `firebase deploy` against a real project for the first time.

## 1. Environment variables / secrets

None of these have real values in this repo — the emulator falls back to safe test defaults (see the "Emulator fallback" column) so local development and the acceptance suites never need them. Production does.

| Variable | Used by | Emulator fallback | Required in production? |
|---|---|---|---|
| `PAYSTACK_SECRET_KEY` | `handlePaystackWebhook` (HMAC-SHA512 signature verification), `createSubscriptionCheckout` (Paystack API calls) | `"emulator_test_secret"` when `FUNCTIONS_EMULATOR=true` | **Yes**, for Paystack. Without it, `verifySignature` returns `false` for every request and the webhook rejects everything with 401. |
| `FLUTTERWAVE_SECRET_HASH` | `handleFlutterwaveWebhook` (signature verification — a static string comparison, not an HMAC; this is the exact value configured in the Flutterwave dashboard, not a computed secret) | `"emulator_test_secret"` when `FUNCTIONS_EMULATOR=true` | **Yes**, for Flutterwave. Get this from the Flutterwave dashboard's webhook settings, not generated locally. |
| `FLUTTERWAVE_SECRET_KEY` | `createFlutterwaveCheckout` (Flutterwave API calls) | `"emulator_test_secret"` when `FUNCTIONS_EMULATOR=true` | **Yes**, for Flutterwave checkout to work (distinct from `FLUTTERWAVE_SECRET_HASH` above — one authenticates webhooks, the other authenticates outbound API calls). |
| `STRIPE_WEBHOOK_SECRET` | `handleStripeWebhook` (HMAC-SHA256 signature verification, `whsec_...`) | `"emulator_test_secret"` when `FUNCTIONS_EMULATOR=true` | **Yes**, for Stripe. Generated per-endpoint in the Stripe dashboard when you register the webhook URL — regenerate and update this if the webhook endpoint is ever re-created. |
| `STRIPE_SECRET_KEY` | `createStripeCheckout` (Stripe API calls, `sk_live_...`/`sk_test_...`) | `"emulator_test_secret"` when `FUNCTIONS_EMULATOR=true` | **Yes**, for Stripe checkout. |
| `STRIPE_CHECKOUT_SUCCESS_URL` / `STRIPE_CHECKOUT_CANCEL_URL` | `createStripeCheckout` | Falls back to a placeholder `https://the platform.com/...` URL | **Yes** — set these to the real frontend routes the vendor should land on after paying/cancelling, before going live with Stripe specifically. |
| `RESEND_API_KEY` | `subscriptionEmail.ts` (subscription lifecycle emails) | Empty string — email send silently no-ops | **Yes**, to actually send subscription emails. Email failure is designed to never block a Firestore transaction (see README), so this being unset in production wouldn't break subscriptions, just silently mean no emails go out. Confirm before launch that this is actually set, not just "safe if forgotten." |
| `SMS_PROVIDER` | `phoneOtp.ts` | `"emulator"` — writes the OTP to a Firestore field (`_emulatorCode`) instead of sending a real SMS | **Yes.** This is a Milestone 1 dependency (phone OTP), not new to Milestone 4, but worth re-confirming as part of any deploy since it gates real user signup. |
| `APP_CHECK_ENFORCE` | `utils/appCheck.ts` | unset — monitor-only mode | **Deliberately not required yet.** See the README's App Check Rollout section — this stays unset (monitor mode) through at least dev and early staging by design, not an oversight. |

**You do not need all three providers configured to deploy.** Each provider's webhook/checkout pair fails gracefully and independently if its secrets are unset in production (the emulator fallback only applies when `FUNCTIONS_EMULATOR=true`) — a vendor-facing UI should simply not offer a provider whose `providerPlanCodes/{planId}` still has placeholder codes. Paystack is the one to configure first (existing production traffic assumption); Flutterwave and Stripe can be enabled provider-by-provider as real merchant accounts are provisioned.

Set secrets via `firebase functions:secrets:set <NAME>` (Cloud Functions v2 preferred approach) rather than plain environment config, so they're encrypted at rest and not visible in `firebase functions:config:get` output or deploy logs.

## 2. Firestore indexes

`firestore.indexes.json` has composite indexes for every compound query added across all four milestones, including Milestone 4's `invoices` (vendorId+hiddenFromHistory+createdAt, vendorId+hiddenFromHistory+status+createdAt), `subscriptionEvents`, and `ratings` queries.

```bash
firebase deploy --only firestore:indexes --project <your-project-id>
```

Composite index builds are asynchronous server-side and can take minutes to hours depending on existing data volume — on a brand-new project this is instant, but **do this well before the functions/rules deploy on any project that already has data**, since a query against an unbuilt index fails with `FAILED_PRECONDITION` at runtime, not at deploy time.

## 3. Firestore security rules

```bash
firebase deploy --only firestore:rules --project <your-project-id>
```

Before deploying: the README's Security Posture section already flags an open item worth taking seriously here — a full manual pass through every `match` block checking for a general wildcard and a more specific match both applying to the same path, since exactly this class of bug was found and fixed once already during Milestone 3. Not blocking, but the right moment to do that pass is right before a real deploy, not after.

## 4. Storage rules

```bash
firebase deploy --only storage --project <your-project-id>
```

Covers `verificationDocuments`, `vendorMedia/*`, `users/{userId}` profile photos, and Milestone 4's new `invoiceBranding/{vendorId}/{fileId}` path (2MB cap, image-only, vendor-owner + admin read).

## 5. Cloud Functions

```bash
cd functions
npm install
npm run build   # must complete with zero TypeScript errors before deploying
cd ..
firebase deploy --only functions --project <your-project-id>
```

Specific things worth checking for this deploy, not generic advice:

- **Node version.** `functions/package.json` pins `"node": "20"` under `engines`. Confirm the target Firebase project's Cloud Functions runtime is actually configured for Node 20 (`firebase.json` → `functions.runtime`, or the Firebase console), since a mismatch here is a deploy-time failure, not a subtle bug.
- **The three scheduled functions are new in Milestone 4**: `expireStaleSubscriptions`, `gracePeriodReminder` (both daily), `cleanupExpiredInvoiceVisibility` (daily, 04:00). Cloud Scheduler jobs are created automatically on deploy for `onSchedule` functions, but confirm in the GCP Console → Cloud Scheduler that all three actually appear after deploying — this is the one class of Cloud Functions v2 resource that doesn't show up in `firebase deploy` output the same way an HTTPS function's URL does.
- **Each provider's deployed webhook URL needs registering in that provider's own dashboard** before any real subscription can activate through it — `handlePaystackWebhook` in the Paystack dashboard, `handleFlutterwaveWebhook` in Flutterwave's, `handleStripeWebhook` in Stripe's. None of this is automatic; `firebase deploy` gives you the three URLs, but each provider's dashboard registration is a separate manual step, and for Stripe specifically, registering the endpoint is also what generates the `STRIPE_WEBHOOK_SECRET` value above.
- **pdfkit** (invoice PDF generation) is a real npm dependency now (`functions/package.json`), not a dev-only tool — confirm `npm install` in the Cloud Build step actually installs it (it will, since it's a regular `dependencies` entry, but worth a first-deploy sanity check given it wasn't in the codebase before Milestone 4).

## 6. Post-deploy verification

Not a substitute for the acceptance suite (which only runs against the emulator), but the minimum smoke check against the real deployed project before calling it live:

- [ ] `seedSubscriptionPlans` called once by a real `super_admin` account (this needs to happen manually — it's not automatic), and `providerPlanCodes/{planId}` edited afterward with each provider's real plan/price codes in place of the seeded placeholders
- [ ] `subscriptionPlans` document readable from an unauthenticated client (confirms the public pricing page path works)
- [ ] A real Paystack test-mode webhook event delivered successfully (confirms the registered webhook URL + `PAYSTACK_SECRET_KEY` are both correct — a signature mismatch here means either the key or the registered URL is wrong)
- [ ] For each of Flutterwave and Stripe, *if* enabled for this deploy: the same test-mode webhook round-trip, verifying that provider's own signature scheme independently (`FLUTTERWAVE_SECRET_HASH` or `STRIPE_WEBHOOK_SECRET` respectively — these are separate secrets from Paystack's, a working Paystack webhook says nothing about whether the other two are configured correctly)
- [ ] Cloud Scheduler console shows all three new scheduled jobs as `ENABLED`
- [ ] `createInvoice` → `downloadInvoicePdf` round-trip against the real project (confirms pdfkit's dependencies resolved correctly in the actual Cloud Functions runtime, not just locally)

## 7. What's intentionally NOT on this checklist

Per the README's Known Gaps section, these are explicitly deferred (by the source spec itself, not an oversight of this checklist): a subscription monitoring dashboard, a disaster-recovery runbook, App Check enforcement (still monitor-mode by design), and an independent third-party security audit. None of these block a first deployment to a controlled environment (dev/staging), but App Check enforcement and the security audit are called out in the README as the two highest-priority items before *general availability* specifically — worth tracking separately from this deploy checklist, not folding into it.
