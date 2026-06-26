# the platform Backend — Milestone 1

Firebase backend for the the platform multi-vendor marketplace: Auth, Users, Vendors, Verification, and Security Foundation (tickets P1-FB-001 through P1-FB-013).

## Status

This reflects the state of the repo after the second remediation pass following an independent audit. Status is described honestly rather than as a blanket "complete" — see the table below for what is and isn't verified.

| Area | Status |
|---|---|
| Auth + custom claims (customer/vendor/admin) | Acceptance tests passing in developer environment |
| Vendor registration, verification submission flow | Acceptance tests passing in developer environment |
| Multi-role admin (super_admin, verification_admin, support_admin, safety_admin, read_only_admin) | Acceptance tests passing in developer environment |
| Firestore security rules (discovery, user/vendor update allowlists) | Acceptance tests passing in developer environment, including negative/escalation cases |
| Storage security rules (MIME allowlist, size limits, vendor-only upload, admin-only raw read) | Acceptance tests passing in developer environment against the real Storage emulator |
| `recordVerificationDocument` server-side metadata verification | Implemented — fetches real Cloud Storage object metadata rather than trusting client-supplied values |
| Audit log schema (requestId, functionName, App Check status) | Acceptance tests passing in developer environment |
| App Check | Implemented in **monitor mode only** (see App Check Rollout below). Not yet enforced. |
| Frontend integration contracts | See `docs/frontend-contracts-phase-1.md` |
| Production monitoring/alerting dashboards | Not yet implemented — infrastructure/ops work, tracked separately from this code delivery |

"Acceptance tests passing in developer environment" means: run against the local Firebase Emulator Suite, on this developer's machine, as of the date of the corresponding test run. It is not a substitute for independent review, staging deployment, or production verification.

## Running the acceptance tests

```bash
cd functions
npm install
npm run build
cd ..
firebase emulators:start --only auth,firestore,functions,storage --project demo-the platform
```

In a second terminal:

```bash
cd scripts
npm install
node milestone1-acceptance-tests.js
```

The Storage emulator is required — the suite includes real file upload tests against Storage security rules (MIME allowlist, size limits, ownership, admin-only raw read), not just Firestore.

## App Check Rollout

App Check is implemented as a monitor-mode helper (`functions/src/utils/appCheck.ts`) that records whether a valid App Check token was present on every sensitive callable, without blocking requests, controlled by the `APP_CHECK_ENFORCE` environment variable.

Planned rollout:

- **dev**: monitor mode only. App Check status is logged and recorded in audit logs; no requests are blocked.
- **staging**: monitor mode initially, switched to enforcement once the mobile app and Admin Web Portal both have App Check providers registered and have been confirmed sending valid tokens in real traffic.
- **production**: enforcement (`APP_CHECK_ENFORCE=true`) only after staging enforcement has run cleanly for a defined soak period with no unexpected rejections.

This sequencing exists to avoid a scenario where enabling enforcement before the frontend is ready locks out legitimate users.

## Verification document storage path

Canonical path, used consistently across Storage rules, the `recordVerificationDocument` callable, and the acceptance tests:

```
verificationDocuments/{vendorId}/{docId}
```

Vendor owners may upload (PDF or image, 15 MB max) but cannot read raw files back. Only admins can read uploaded verification documents directly; vendors see document metadata via Firestore (`vendorVerification/{vendorId}/documents/{docId}`).

## Known gaps / explicitly deferred

- Production monitoring dashboards and alerting are not part of this code delivery.
- App Check enforcement is deferred per the rollout plan above.
- Admin MFA enrollment UI is not part of this milestone (the `adminUsers` schema reserves fields for it; enrollment flow is Phase 2).
