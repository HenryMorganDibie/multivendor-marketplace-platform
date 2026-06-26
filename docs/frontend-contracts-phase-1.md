# the platform Backend — Frontend Integration Contracts (Milestone 1)

This document describes every callable Cloud Function exposed by the Milestone 1 backend: required auth state, request payload, response payload, error codes, and any Firestore/Storage side effects the frontend needs to know about.

General notes that apply to all callables:

- All callables are Firebase Callable Functions (`httpsCallable`). Errors surface to the client as `FirebaseError` with a `code` of the form `functions/<error-code>` (e.g. `functions/permission-denied`).
- App Check is in **monitor mode** for Milestone 1 (see README). No callable currently rejects requests for missing App Check tokens, but this will change — see the App Check Rollout section in the README before assuming this stays permissive.
- After any callable that changes a user's custom claims (`role`, `vendorId`, `adminRoleIds`, `claimsVersion`), the client **must** call `getIdToken(true)` to force a token refresh before relying on the new claims in subsequent reads/writes. The backend never assumes the client did this automatically.

---

## Auth

### `completeRegistration`
- **Auth required:** yes (any signed-in user, role `customer` at this point)
- **App Check:** monitored, not enforced
- **Request:**
  ```ts
  {
    role: "customer" | "vendor";
    // customer fields
    firstName?: string;
    lastName?: string;
    countryCode?: string;
    region?: string;
    city?: string;
    area?: string;
    // vendor fields (required if role === "vendor")
    businessName?: string;
    username?: string;       // 3-30 chars, lowercase letters/numbers/underscore
    fullName?: string;
    categoryId?: string;
    categoryName?: string;
    country?: string;
    state?: string;
    plan?: "basic" | "standard" | "pro" | "pro_plus";
  }
  ```
- **Response:** `{ success: true, role: string, vendorId?: string }`
- **Errors:** `invalid-argument` (bad role, missing username/businessName), `failed-precondition` (role already finalized), `already-exists` (username taken)
- **Side effects:** creates/updates `users/{uid}`; for vendors, creates `vendors/{vendorId}`, `vendorVerification/{vendorId}`, `usernameReservations/{username}`; sets custom claims.
- **Client must:** call `getIdToken(true)` immediately after success.

### `getClaimsVersion`
- **Auth required:** yes
- **Request:** `{}`
- **Response:** `{ claimsVersion: number }`
- Use this to check if a token refresh is needed without forcing one unconditionally.

### `checkUsernameAvailability`
- **Auth required:** no (public, but App-Check-monitored)
- **Request:** `{ username: string }`
- **Response:** `{ available: boolean, reason?: string }`

### `changeUsername`
- **Auth required:** yes, role `vendor`
- **Request:** `{ username: string }`
- **Response:** `{ success: true, username: string }`
- **Errors:** `permission-denied` (not a vendor), `invalid-argument` (bad format), `already-exists` (taken)

### `sendEmailOtp`
- **Auth required:** no
- **Request:** `{ email: string }`
- **Response:** `{ success: true }`
- **Errors:** `invalid-argument` (bad email), `resource-exhausted` (rate limited, max 5/hour per email)
- **Note:** in the emulator, the generated code is delivered to a `mail/{autoId}` Firestore document (no real SMTP). In production this is wired to the Trigger Email extension.

### `verifyEmailOtp`
- **Auth required:** no (but if signed in and the email matches the account, marks `emailVerified: true`)
- **Request:** `{ email: string, code: string }`
- **Response:** `{ success: true, verified: true }`
- **Errors:** `not-found`, `deadline-exceeded` (expired), `invalid-argument` (wrong code), `resource-exhausted` (too many attempts, max 5)

---

## Vendor

### `setVendorPublishStatus`
- **Auth required:** yes, role `vendor`
- **Request:** `{ isPublished: boolean }` — **must be a real boolean**, not a string
- **Response:** `{ success: true, isPublished: boolean }`
- **Errors:** `invalid-argument` if `isPublished` is not strictly a boolean
- **Side effects:** `vendors/{vendorId}.isPublished` updated; `isDiscoverable` recomputed asynchronously by the `onVendorWrite` trigger (allow ~1 second before re-reading).

### `recordVerificationDocument`
- **Auth required:** yes, role `vendor`
- **Precondition:** the file must already be uploaded to Cloud Storage at `verificationDocuments/{vendorId}/{anything}` before calling this.
- **Request:**
  ```ts
  {
    type: "business_info" | "identity_document" | "proof_of_address" | "other";
    storagePath: string; // must start with verificationDocuments/{vendorId}/
  }
  ```
  Note: `contentType` and `sizeBytes` are **not** part of the request. The server fetches the real object metadata from Cloud Storage directly — do not rely on client-supplied values for these.
- **Response:** `{ success: true, docId: string }`
- **Errors:** `invalid-argument` (bad type or path), `failed-precondition` (no object exists at that path yet — upload first), `not-found` (no vendorVerification record)

### `submitVendorVerification`
- **Auth required:** yes, role `vendor`
- **Request:** `{}`
- **Response:** `{ success: true, verificationStatus: "pending_review" }`
- **Errors:** `failed-precondition` (not in `not_started`/`retry_required`, or missing required documents — error message lists which types are missing)

---

## Admin — vendor moderation

All require an active `adminUsers/{uid}` document (`status: "active"`) in addition to the `role: "admin"` custom claim — a revoked admin's token is rejected even if not yet expired.

### `approveVendorVerification`
- **Required admin role:** `verification_admin` (or `super_admin`)
- **Request:** `{ vendorId: string }`
- **Response:** `{ success: true }`
- **Errors:** `failed-precondition` if not currently `pending_review`

### `rejectVendorVerification`
- **Required admin role:** `verification_admin` (or `super_admin`)
- **Request:** `{ vendorId: string, reason: string }`
- **Response:** `{ success: true }`

### `requestVerificationRetry`
- **Required admin role:** `verification_admin` (or `super_admin`)
- **Request:** `{ vendorId: string, retryReason?: string, requiredSteps?: string[] }` (steps limited to `business_info`, `identity_document`, `proof_of_address`)
- **Response:** `{ success: true }`

### `suspendVendor` / `deactivateVendor` / `reactivateVendor`
- **Required admin role:** `safety_admin` (or `super_admin`)
- **Request:** `{ vendorId: string, reason?: string }` (reason not used by `reactivateVendor`)
- **Response:** `{ success: true }`
- **Note:** `reactivateVendor` fails with `failed-precondition` if `verificationStatus === 'rejected'` — rejected vendors must be re-approved through the verification flow, not just reactivated.

---

## Admin — access management

### `createAdminInvite`
- **Required admin role:** `super_admin` only
- **Request:** `{ email: string, roleIds: AdminRoleId[] }`
- **Response:** `{ success: true, inviteId: string }`
- Invite expires 72 hours after creation.

### `acceptAdminInvite`
- **Auth required:** yes (the invited user, signed up separately first)
- **Request:** `{ inviteId: string }`
- **Response:** `{ success: true, roleIds: AdminRoleId[] }`
- **Errors:** `not-found`, `failed-precondition` (already accepted/revoked), `deadline-exceeded` (expired), `permission-denied` (email mismatch)

### `revokeAdminAccess`
- **Required admin role:** `super_admin` only
- **Request:** `{ uid: string }`
- **Response:** `{ success: true }`
- **Errors:** `invalid-argument` if attempting to revoke your own access

### `recordAdminSession`
- **Auth required:** yes, any active admin
- **Request:** `{ userAgent?: string, deviceLabel?: string }`
- **Response:** `{ success: true, sessionId: string }`
- Intended to be called by the Admin Web Portal on login.

---

## Storage paths (canonical)

| Purpose | Path | Read | Write |
|---|---|---|---|
| User avatar | `users/{uid}/avatar.{ext}` | public | owner only, image, <5MB |
| Vendor logo | `vendorMedia/{vendorId}/logos/{fileId}` | public | vendor owner, image, <5MB |
| Vendor banner | `vendorMedia/{vendorId}/banners/{fileId}` | public | vendor owner, image, <8MB |
| Vendor gallery | `vendorMedia/{vendorId}/gallery/{fileId}` | public | vendor owner, image, <8MB |
| Verification document | `verificationDocuments/{vendorId}/{docId}` | **admin only** (vendor cannot read raw files) | vendor owner, PDF or image, <15MB |
