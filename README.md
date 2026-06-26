# the platform Backend

Firebase backend for the the platform multi-vendor marketplace — a location-based discovery platform for small businesses (food, hair, mechanics, and more) in Nigeria and beyond.

## Architecture

Built entirely on Firebase:
- **Cloud Functions** (Node 20, TypeScript) — all business logic, security enforcement, and data mutations
- **Firestore** — primary database with strict security rules; no client writes to sensitive fields ever
- **Firebase Auth** — custom claims for role-based access (customer / vendor / admin)
- **Firebase Storage** — vendor media and verification documents with MIME and size enforcement
- **App Check** — monitor mode (Phase 1–2), enforcement deferred until frontend App Check providers are confirmed

The backend is the **single source of truth** for all pricing, inventory, order status, and user roles. The frontend never computes totals or mutates server-controlled fields directly.

---

## Phases Completed

### Phase 1 — Auth, Users, Vendors, Verification & Security Foundation
**Tickets:** P1-FB-001 through P1-FB-013 | **Tests:** 67/67 passing

| Area | What's built |
|---|---|
| Authentication | Firebase Auth with email + phone OTP sign-in support |
| Custom claims | `role`, `vendorId`, `adminRoleIds`, `claimsVersion` — set server-side only |
| Users | `users/{uid}` with strict allowlist-based self-update rules |
| Vendors | Dual status model: `verificationStatus` + `vendorStatus` — fully independent state machines |
| Verification flow | Document upload → `recordVerificationDocument` (fetches real Storage metadata) → `submitVendorVerification` → admin review |
| Multi-role admin | `super_admin`, `verification_admin`, `support_admin`, `safety_admin`, `read_only_admin` |
| Admin access | Invite-only (`createAdminInvite` → `acceptAdminInvite`), revocable, session-tracked |
| Security rules | Firestore: allowlist-based user/vendor updates, correct discovery rules (approved + active + discoverable only). Storage: MIME allowlist, size limits, vendor raw-read denied |
| Audit logging | Every sensitive action: `requestId`, `functionName`, `appCheck` status, PII-safe snapshots |
| Email OTP | Hashed doc IDs (no PII), rate-limited, 10-min expiry |
| Phone OTP | Nigerian formats (08xxx, +234xxx), hashed doc IDs, SMS queue for provider routing |

### Phase 2 — Catalog, Orders, Inventory, Payments & Receipts
**Tickets:** P2 full scope | **Tests:** 61/61 passing

| Area | What's built |
|---|---|
| Catalog | Categories + items with plan limits enforced server-side (basic=10, standard=30, pro=70, pro_plus=120) |
| Cart repricing | `repriceCart` — backend-authoritative pricing, validates real item prices, add-ons, availability |
| Orders (internal) | `createOrderFromCart` — atomic inventory reservation, immutable price snapshot, SLA deadline set at creation |
| Orders (external) | `createExternalOrder` — vendor creates orders on behalf of walk-in/WhatsApp customers |
| Order lifecycle | `requested → accepted → in_progress → completed` (vendor) \| `requested/accepted → cancelled` (customer) |
| SLA enforcement | 48-hour acceptance deadline; `expireStaleOrders` releases inventory and notifies on timeout |
| Change requests | Vendor proposes changes on `requested` orders; customer accepts or rejects before order proceeds |
| Payment proofs | Evidence-only (no payment processing). Max 2 submissions, max 3 images, auto-lock after 2 rejections |
| Receipts | Auto-generated on completion. Format: `LVT-{YEAR}-{VENDOR_CODE}-{SEQUENCE}` |
| Inventory | Atomic reservation on order create, release on reject/cancel/expire, permanent adjustment on complete |
| Order events | Immutable subcollection audit trail for every lifecycle event |
| Security rules | All Phase 2 collections: orders/carts/proofs/receipts/events — no direct client writes ever |

---

## Project Structure

```
the platform-backend/
├── functions/
│   └── src/
│       ├── admin.ts              # Firebase Admin SDK init
│       ├── types.ts              # Phase 1 types
│       ├── types2.ts             # Phase 2 types
│       ├── index.ts              # All function exports
│       ├── auth/                 # onUserCreate, onUserDelete, completeRegistration,
│       │                         # emailOtp, phoneOtp, usernameReservation
│       ├── vendors/              # onVendorWrite, setVendorPublishStatus,
│       │                         # verificationSubmission
│       ├── admin/                # vendorModeration, adminInvites
│       ├── catalog/              # catalogFunctions (CRUD + plan limits)
│       ├── orders/               # repriceCart, createOrder, updateOrderStatus,
│       │                         # handleChangeRequest, paymentProofs,
│       │                         # orderEvents, orderNumbers
│       ├── inventory/            # inventoryUtils (reserve/release/adjust)
│       ├── receipts/             # receiptFunctions
│       └── utils/                # appCheck, auditLog, adminAuth, requestContext
├── firestore/
│   ├── firestore.rules           # Phase 1 + Phase 2 security rules
│   ├── storage.rules             # MIME allowlist, ownership, size limits
│   └── firestore.indexes.json    # Composite indexes for discovery queries
├── scripts/
│   ├── milestone1-acceptance-tests.js   # 67 tests — Phase 1
│   ├── milestone2-acceptance-tests.js   # 61 tests — Phase 2
│   └── package.json
├── docs/
│   └── frontend-contracts-phase-1.md    # Callable payloads, responses, error codes
├── firebase.json
└── .firebaserc                   # dev / staging / prod aliases
```

---

## Running Locally

**Prerequisites:** Node 20+, Firebase CLI (`npm install -g firebase-tools`)

```bash
# Install and build
cd functions
npm install
npm run build
cd ..

# Start emulators (Phase 1 only — no Storage needed)
firebase emulators:start --only auth,firestore,functions --project demo-the platform

# Start emulators (Phase 2 — Storage required)
firebase emulators:start --only auth,firestore,functions,storage --project demo-the platform
```

**Run acceptance tests** (in a second terminal):

```bash
cd scripts
npm install

# Phase 1 (67 tests)
node milestone1-acceptance-tests.js

# Phase 2 (61 tests)
node milestone2-acceptance-tests.js
```

---

## Cloud Functions Reference

### Phase 1

| Function | Role | Description |
|---|---|---|
| `onUserCreate` | system | Creates `users/{uid}` with defaults on signup |
| `onUserDelete` | system | Deletes user doc, redacts PII in audit log |
| `completeRegistration` | any | Finalizes customer/vendor onboarding |
| `getClaimsVersion` | any | Returns current claims version for token refresh |
| `checkUsernameAvailability` | public | Pre-auth username check |
| `changeUsername` | vendor | Atomic username reassignment with audit |
| `sendEmailOtp` / `verifyEmailOtp` | any | Email verification OTP |
| `sendPhoneOtp` / `verifyPhoneOtp` | any | Phone verification OTP (Nigerian formats) |
| `setVendorPublishStatus` | vendor | Go-live toggle |
| `recordVerificationDocument` | vendor | Records uploaded doc metadata (fetches real Storage object) |
| `submitVendorVerification` | vendor | Submits for admin review |
| `approveVendorVerification` | verification_admin | Approves vendor |
| `rejectVendorVerification` | verification_admin | Rejects with reason |
| `requestVerificationRetry` | verification_admin | Sends back for resubmission |
| `suspendVendor` / `deactivateVendor` / `reactivateVendor` | safety_admin | Account status management |
| `createAdminInvite` | super_admin | Invite-only admin onboarding |
| `acceptAdminInvite` | invited user | Accepts invite, sets admin claims |
| `revokeAdminAccess` | super_admin | Revokes admin, resets claims |
| `recordAdminSession` | admin | Logs admin portal login |

### Phase 2

| Function | Role | Description |
|---|---|---|
| `createCatalogCategory` | vendor | Creates a product category |
| `createCatalogItem` | vendor | Creates item, enforces plan limits |
| `updateCatalogItem` | vendor | Updates allowed fields only |
| `deleteCatalogItem` | vendor | Blocked if active reservations exist |
| `repriceCart` | customer | Creates/updates cart with server-computed prices |
| `createOrderFromCart` | customer | Atomically places order + reserves inventory |
| `createExternalOrder` | vendor | Creates order for walk-in/external customer |
| `updateOrderStatus` | vendor/customer | Lifecycle transitions with role validation |
| `handleChangeRequest` | vendor/customer | Propose, accept, or reject order changes |
| `submitPaymentProof` | customer | Submit payment evidence (max 2 attempts, 3 images) |
| `reviewPaymentProof` | vendor | Accept or reject proof with reason |
| `getReceipt` | customer/vendor | Retrieve generated receipt |

---

## App Check Rollout

App Check is implemented in **monitor mode** — missing tokens are logged but do not block requests.

| Environment | Status |
|---|---|
| dev | Monitor only |
| staging | Monitor → enforce once frontend providers confirmed |
| prod | Enforce (`APP_CHECK_ENFORCE=true`) after staging soak period |

---

## Verification Document Storage Path

Canonical path (consistent across Storage rules, `recordVerificationDocument`, and tests):
```
verificationDocuments/{vendorId}/{docId}
```
Vendor owners may upload (PDF or image, max 15 MB) but **cannot read raw files back**. Only admins can read uploaded verification documents directly.

---

## Environment Aliases

| Alias | Project |
|---|---|
| dev (default) | the platform-dev |
| staging | the platform-staging |
| prod | the platform-prod |

Deploy to dev: `firebase deploy --only functions,firestore:rules,firestore:indexes,storage:rules`