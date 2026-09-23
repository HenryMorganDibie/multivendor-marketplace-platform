# Device and abuse risk controls — current state

Answers the six questions raised in review, verified against the code rather
than from memory. Where a control does not exist, it says so and places it as
either an existing scope limitation or post-MVP work.

Device fingerprinting was not specified in any milestone or phase, and none
exists. The question is what protection *does* exist, and that turns out to be
more than nothing and less than enough.

---

## 1. Does the app create a random installation ID?

**No.**

The only device-shaped identifier anywhere is `deviceId` on `registerPushToken`,
which keys the push token document at
`users/{uid}/pushTokens/{deviceId}`. Its purpose is deduplication — one token
per device rather than a new row on every launch. It is supplied by the client,
never verified, and absent from every other call.

It is not an installation ID and should not be described as one. It cannot
correlate accounts, it is only written when a user grants notification
permission, and a client that wanted to evade it would simply send a new value.

**Post-MVP**, and the smallest useful piece of work on this list.

## 2. Do security events record actor, session, platform, App Check and risk context?

**Partly — more than expected on some axes, nothing on others.**

`writeAuditLog` writes to `auditLogs` on every sensitive callable and records:

| Recorded | Notes |
|---|---|
| `requestId` | Unique per invocation, so an event chain is traceable |
| `actor.uid`, role, type | Who acted, and as what |
| `functionName` | What they called |
| `targetType`, `targetId` | What they acted on |
| `eventType` | Domain event, e.g. `invoice.deleted` |
| `before` / `after` | State either side, on mutations |
| `appCheck` | Present and verified status per call |
| `environment` | Which project |

**Not recorded:** IP address, user agent, platform, app version, installation or
session identifier. `request.rawRequest.ip` is available and used for rate
limiting on unauthenticated calls, but is not persisted to the audit log.

So an investigator can answer *who did what to which record and whether App
Check vouched for the app* — and cannot answer *from where, on what, or whether
two accounts share anything*.

Persisting IP, platform and app version to `auditLogs` is a small change and
the highest-value item here. **Recommend moving to MVP.**

## 3. Can the backend flag several accounts created or operated from the same installation?

**No.** Nothing shared is recorded, so nothing can be correlated.

The pieces that would make this possible are absent rather than broken: no
installation ID (Q1), and no IP or device context on audit entries (Q2). With
those two, a query for accounts sharing an installation or an IP within a window
becomes straightforward, because the audit log is already per-event and indexed.

**Post-MVP as a detection feature. The two inputs it needs should be MVP.**

## 4. Can a suspended user returning through another account be detected?

**Not reliably.**

What exists:

- `assertAdmin()` re-checks `adminUsers/{uid}.status` on every admin call, so a
  revoked admin holding a valid token is stopped rather than waiting an hour for
  it to expire.
- Vendor suspension is enforced through `resolveEffectivePlan`, which returns
  `basic` with `reason: "vendor_suspended"`, so a suspended vendor loses paid
  capability immediately.
- `cleanupOrphanedAccounts` removes half-created accounts, which closes one
  re-registration path.

What is missing: nothing links a new account to a suspended one. A suspended
user registering with a different email and phone number is a new user. Email
and phone are verified — which is a real cost, since both must be re-obtained —
but that is the only friction.

**Detection is post-MVP. It depends entirely on Q1 and Q2.**

## 5. What protects referral, trial, promotion and rating abuse?

**Ratings — genuinely strong.** `submitRating` requires an `orderId`, checks the
order belongs to the rater, and refuses a second rating for the same order.
There is no path to a rating without a real completed order, so fake ratings
require fake orders, which require a real vendor to accept them.

**Promotions — strong, server-decided.** `repriceCart` calls
`evaluateBestPromotion` server-side. The client cannot name a promotion and have
it honoured; a code is a request and the server decides what qualifies. Validity
window, minimum spend, eligible items and usage limits are all checked there.

**Trials and subscriptions — partly protected.** `priceReconciliation` compares
what a provider actually charged against the approved price and records a
discrepancy per vendor and plan. Manual overrides are admin-only and audited.
But nothing prevents the same person taking a trial repeatedly under new
accounts, for the reason in Q4.

**Referrals — no referral system exists**, so there is nothing to abuse yet. If
one is built, it will need Q1 before launch, not after.

**Rate limiting** applies to billing-sensitive callables via `enforceRateLimit`,
keyed on uid or IP so an unauthenticated caller cannot sidestep it.

**Moderation scoring** exists: `applyUserModerationScore` accumulates a score
and restricts an account at 50 and 100. That is a real automatic control and
does not depend on device signals.

## 6. What device-risk work is intentionally deferred?

Never scoped, so deferred by omission rather than decision:

- Device fingerprinting of any kind
- Installation identity that survives reinstall
- Cross-account correlation by device, IP or installation
- Velocity rules, such as several registrations from one address in an hour
- Automatic linking of a new account to a suspended one

---

## What we would move to MVP

Ordered by value against effort. None of these ban anyone automatically; each
produces a signal an admin can investigate, which is what the review asked for.

| Work | Why | Size |
|---|---|---|
| Persist IP, platform and app version to `auditLogs` | The single highest-value change. Makes every existing audit entry investigable, retrospectively as well as going forward. | Small |
| Random installation ID, generated on first launch and sent with sensitive calls | The one missing input. Correlation is impossible without it, and it is cheap to add. | Small |
| Admin view: accounts sharing an installation or IP | Turns the two above into something an investigator can actually use. | Medium |

Genuinely post-MVP: velocity rules, automated suspension-evasion detection,
commercial fingerprinting.

## One thing worth deciding deliberately

An installation ID is a persistent identifier for a person's device. It carries
privacy-notice obligations and, in some jurisdictions, consent obligations. A
random value generated by the app and stored locally is the lightest form and
the one recommended here — it identifies an installation, not a device, and is
cleared on uninstall.

Commercial fingerprinting, which survives reinstall by deriving an identity from
hardware and configuration, is a materially different decision and should be
made explicitly rather than arrived at.
