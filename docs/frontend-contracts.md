# the platform Backend — Frontend Integration Contracts (Milestones 1–3)

This document describes every callable Cloud Function exposed by the backend across Milestones 1–3: required auth state, request payload, response payload, error codes, and any Firestore/Storage side effects the frontend needs to know about.

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

### `sendPhoneOtp`
- **Auth required:** no
- **Request:** `{ phoneNumber: string }` — accepts Nigerian local format (`08012345678`), E.164 (`+2348012345678`), or the bare international form (`2348012345678`); all are normalized server-side to E.164 before use
- **Response:** `{ success: true }`
- **Errors:** `invalid-argument` (unparseable phone number), `resource-exhausted` (rate limited, max 5 sends per hour per number)
- **Note:** in the emulator, the generated 6-digit code is written to an `smsQueue/{autoId}` Firestore document under an `_emulatorCode` field for test harness inspection. In production this is wired to a real SMS provider and that field does not exist. The code expires 10 minutes after generation.

### `verifyPhoneOtp`
- **Auth required:** no (but if signed in, updates `users/{uid}.phoneNumber` and the Firebase Auth record on success)
- **Request:** `{ phoneNumber: string, code: string }`
- **Response:** `{ success: true, verified: true }`
- **Errors:** `not-found` (no pending code for this number), `deadline-exceeded` (expired), `invalid-argument` (wrong code — the error message reports remaining attempts), `resource-exhausted` (5 incorrect attempts exhausted, the code is invalidated and a new one must be requested)

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

---

# Milestone 2 — Catalog, Orders, Inventory, Payments, Receipts

General notes specific to Milestone 2:

- The backend is the sole authority on pricing. No callable accepts a client-supplied price, subtotal, or total for anything that gets persisted. `repriceCart` recomputes all figures from the live catalog on every call.
- Order status values (`requested`, `accepted`, `confirmed`, `in_progress`, `completed`, `rejected`, `cancelled`, `expired`) are classified as active or terminal through `isOrderActive` / `isOrderTerminal` in `orders/orderStatus.ts`. The frontend should treat this classification as authoritative rather than hard-coding its own status lists, since new statuses may be introduced in a later phase without changing this contract.

## Catalog

### `createCatalogCategory`
- **Auth required:** yes, role `vendor`
- **Request:** `{ name: string, description?: string, order?: number }`
- **Response:** `{ success: true, categoryId: string }`
- **Errors:** `permission-denied`, `invalid-argument` (missing name)

### `createCatalogItem`
- **Auth required:** yes, role `vendor`
- **Request:**
  ```ts
  {
    name: string;
    description?: string;
    basePrice: number;       // non-negative
    salePrice?: number;
    currency?: string;       // defaults to "NGN"
    categoryId?: string;
    photos?: string[];       // up to 10, first photo becomes thumbnailUrl
    isAvailable?: boolean;   // defaults true
    isHidden?: boolean;      // defaults false
    trackInventory?: boolean;
    inventoryQuantity?: number;
    lowStockThreshold?: number;
    addOnGroups?: AddOnGroup[];
  }
  ```
- **Response:** `{ success: true, itemId: string }`
- **Errors:** `invalid-argument` (missing name or negative price), `not-found` (vendor doc missing), `resource-exhausted` (plan catalog limit reached — see table below)
- **Plan limits (server-enforced, counted on visible items only):**

  | Plan | Max visible items |
  |---|---|
  | basic | 10 |
  | standard | 30 |
  | pro | 70 |
  | pro_plus | 120 |

- **Side effects:** new item always starts `moderationStatus: "pending"` and `reservedQuantity: 0` regardless of request payload — these fields cannot be set by the client.

### `updateCatalogItem`
- **Auth required:** yes, role `vendor`, must own the item
- **Request:** `{ itemId: string, ...anyEditableField }`
- **Response:** `{ success: true }`
- **Errors:** `not-found`, `permission-denied` (not the owner), `invalid-argument` (negative price)
- **Note:** the server silently strips `itemId`, `vendorId`, `reservedQuantity`, `orderCount`, `moderationStatus`, `createdAt` from the update payload even if present in the request. These fields are never client-writable.

### `deleteCatalogItem`
- **Auth required:** yes, role `vendor`, must own the item
- **Request:** `{ itemId: string }`
- **Response:** `{ success: true }`
- **Errors:** `not-found`, `permission-denied`, `failed-precondition` (item has active inventory reservations — an open order references it)

---

## Cart and orders

### `repriceCart`
- **Auth required:** yes (any signed-in customer)
- **Request:**
  ```ts
  {
    vendorId: string;
    fulfillmentType: "pickup" | "delivery" | "shipping";
    items: { itemId: string; quantity: number; selectedAddOns?: { groupId: string; optionId: string }[] }[];
    orderNote?: string;
    cartId?: string; // omit to create a new cart
  }
  ```
- **Response:** `{ success: true, cartId: string, subtotal: number, tax: number, discount: number, total: number, quantity: number, items: CartItem[] }`
- **Errors:** `invalid-argument` (empty items array), `not-found` (unknown vendor or item), `failed-precondition` (vendor not discoverable, item unavailable or out of stock)
- **Note:** every price in the response is server-computed from the live catalog. Do not display client-side estimates before calling this — the returned totals are the ones that will actually be charged.

### `createOrderFromCart`
- **Auth required:** yes, the cart owner
- **Request:** `{ cartId: string }`
- **Response:** `{ success: true, orderId: string, publicOrderId: string, conversationId: string }`
- **Errors:** `invalid-argument` (missing cartId), `not-found` (cart expired or missing), `permission-denied` (cart belongs to someone else), `failed-precondition` (cart expired, vendor not accepting orders, country unavailable, blocked — see Milestone 3 Blocks section), insufficient stock surfaces as `failed-precondition` with a message naming the specific item
- **Side effects:** atomically reserves inventory, deletes the cart, and injects an `order_context` system message into the customer/vendor commerce thread (creating that thread first if it does not already exist — see Milestone 3). The 48-hour SLA acceptance deadline is set here; there is no separate call to start it.
- **Frontend note:** `conversationId` in the response is the `chatId` for this customer/vendor pair. Do not construct this value on the client — always use the value returned here or from `createCommerceConversation`.

### `createExternalOrder`
- **Auth required:** yes, role `vendor`
- **Request:**
  ```ts
  {
    externalCustomerName: string;
    externalCustomerPhone?: string;
    items: { itemId: string; quantity: number }[];
    fulfillmentType?: "pickup" | "delivery" | "shipping"; // defaults to "pickup"
    orderNote?: string;
  }
  ```
- **Response:** `{ success: true, orderId: string, publicOrderId: string, conversationId: string }`
- **Errors:** `permission-denied` (not a vendor), `invalid-argument`, `not-found`
- **Note:** `publicOrderId` for external orders always contains `-EXT-` (e.g. `SPICYREST-EXT-000001`) to distinguish it from internal orders in vendor-facing UI. External orders use a synthetic per-order conversation, not the persistent customer/vendor thread, since there is no authenticated customer to link to.

### `updateOrderStatus`
- **Auth required:** yes, either the order's customer or the order's vendor
- **Request:** `{ orderId: string, newStatus: string, reason?: string }`
- **Response:** `{ success: true, orderId: string, newStatus: string }`
- **Errors:** `not-found`, `permission-denied`, `failed-precondition` (illegal transition for the caller's role — see transition table below)
- **Legal transitions:**

  | Actor | From | To |
  |---|---|---|
  | vendor | `requested` | `accepted`, `rejected` |
  | vendor | `accepted` | `in_progress`, `rejected` |
  | vendor | `in_progress` | `completed` |
  | customer | `requested` | `cancelled` |
  | customer | `accepted` | `cancelled` |

- **Side effects:** transitioning to `completed` triggers receipt generation and permanent inventory deduction. Transitioning to any terminal status other than `completed` (`rejected`, `cancelled`, `expired`) releases the reserved inventory back to available stock.

### `handleChangeRequest`
- **Auth required:** yes
- **Request (create, vendor only):** `{ orderId: string, action: "create", message: string, proposedChanges?: { items?: OrderItemSnapshot[]; notes?: string } }`
- **Request (respond, customer only):** `{ orderId: string, action: "accept" | "reject", changeRequestId: string }`
- **Response:** `{ success: true, changeRequestId?: string, status?: "ACCEPTED" | "REJECTED" }`
- **Errors:** `failed-precondition` (order not in `requested` status), `permission-denied` (wrong role for the action)

---

## Payment proofs

### `submitPaymentProof`
- **Auth required:** yes, the order's customer
- **Request:** `{ orderId: string, images: { storagePath: string; thumbnailPath?: string }[], notes?: string }`
- **Response:** `{ success: true, proofId: string, submissionCount: number }`
- **Errors:** `invalid-argument` (no images, or more than 3), `permission-denied`, `failed-precondition` (a proof is already under review, payment already confirmed, or the abuse lock has triggered), `resource-exhausted` (maximum 2 submissions reached — see below)
- **Abuse limits (server-enforced):** maximum 3 images per submission, maximum 2 submissions per order. After the second rejected submission, the order's payment status locks to `PROOF_LOCKED` and no further submissions are accepted through this callable.

### `reviewPaymentProof`
- **Auth required:** yes, the order's vendor
- **Request:** `{ orderId: string, proofId: string, decision: "accept" | "reject", reviewReason?: string }`
- **Response:** `{ success: true, proofId: string, status: "REVIEWED" | "REJECTED" }`
- **Errors:** `invalid-argument` (`reviewReason` is required when rejecting), `not-found`, `permission-denied`, `failed-precondition` (proof not currently awaiting review)
- **Side effects:** accepting triggers `sendPickupDetailsIfEligible` internally (see Milestone 3 Pickup section) — this is automatic and has no separate client-facing call.

---

## Receipts

### `getReceipt`
- **Auth required:** yes, the order's customer or vendor
- **Request:** `{ orderId: string }`
- **Response:** `{ success: true, receipt: ReceiptDoc }`
- **Errors:** `permission-denied`, `not-found` (no receipt generated yet — receipts only exist after an order reaches `completed`)
- **Receipt number format:** `LVT-{YEAR}-{VENDOR_CODE}-{SEQUENCE}`, e.g. `LVT-2026-SPICY01-000001`.

---

# Milestone 3 — Commerce Chat, Notifications, Blocks, Pickup Auto-Send

General notes specific to Milestone 3:

- There is exactly **one** commerce thread per `(customerId, vendorId)` pair, never one per order. Placing a second order with the same vendor reuses the existing thread; it does not create a new one. The thread's `relatedOrderIds` array accumulates every order ever placed in it.
- `chatId` for a commerce thread is deterministic: `commerce_{customerId}_{vendorId}`. The frontend may compute this locally for optimistic UI purposes, but should always confirm it against the value returned by `createCommerceConversation` or an order-creation callable rather than assuming it.
- Country availability (`countryAvailability/{countryCode}`) gates every commerce-creating action. A missing or non-`ACTIVE` country document fails closed — the callable returns `failed-precondition` rather than allowing the action through.
- Contact cards are **local-device-only** for this milestone. There is no `users/{uid}/contactCards` collection on the backend. The frontend is responsible for storing saved contact details in device-secure storage (Keychain on iOS, Keystore on Android) and passing the relevant fields inline when the customer chooses to submit them for a specific order via `submitDeliveryContact`.

## Commerce conversations and messages

### `createCommerceConversation`
- **Auth required:** yes, role `customer`
- **Request:** `{ vendorId: string }`
- **Response:** `{ success: true, chatId: string, created: boolean }`
- **Errors:** `not-found` (unknown vendor), `permission-denied` (caller is not a customer), `failed-precondition` (vendor not active, storefront not accessible via discovery or direct link, country unavailable, or a block exists between the parties)
- **Idempotent:** calling this again for the same vendor returns the same `chatId` with `created: false`. This is safe to call defensively before sending a first message.
- **Side effects:** if the vendor has a greeting message configured (see `updateVendorChatSettings` below) and this is a true first-time creation, a system message of type `system` / `systemSubtype: "greeting_message"` is inserted automatically. The vendor also receives a `new_inquiry` notification.

### `sendChatMessage`
- **Auth required:** yes, must be a participant in the thread
- **Request:**
  ```ts
  {
    chatId: string;
    type: "text" | "contact-card" | "catalog_item"; // these are the ONLY client-creatable types
    content?: string;          // required for type "text", max 4000 characters
    contactCardData?: { fullName: string; phoneNumber: string; address?: AddressObject };
    catalogItemData?: { itemId: string };  // price/name/photo are server-fetched, never trusted from client
    attachments?: { storagePath: string; contentType: string; sizeBytes: number }[]; // max 5, each under 15MB
  }
  ```
- **Response:** `{ success: true, messageId: string }`
- **Errors:** `not-found`, `permission-denied` (not a participant), `invalid-argument` (attempting to create a server-only type such as `order_context`, `pickup-details`, `system`, `receipt`, `invoice`, or `change_request`; empty text; attachment limits exceeded; **or message content blocked by moderation — see below**), `failed-precondition` (vendor suspended, country unavailable, or blocked with no active order — see Blocks below)
- **Message types the client will *receive* but can never send directly:** `system`, `payment-request`, `pickup-details`, `receipt`, `invoice`, `ai`, `order_context`, `new_inquiry`, `change_request`. These are always server-assembled from real data and appear in the thread as a side effect of other actions.
- **Side effects:** updates the thread's `lastMessage` / `lastMessageAt` / `lastSenderUid` summary fields, creates a `new_message` notification for every other participant (never the sender), and — for customer-sent messages only — checks vendor away-message eligibility.
- **Moderation (P3-FB-021):** every `text` / `contact-card` / `catalog_item` message is checked against the backend rule-based moderation engine before it is saved. Any field named `moderationStatus` or `moderationScore` in the request is silently ignored — these are always server-computed, never client-settable. Two outcomes are visible to the frontend:
  - **Blocked (high/critical severity):** the callable throws `invalid-argument` with message `"This message contains content that is not allowed on the platform."` The message is never saved — do not optimistically render it in the composer's sent list.
  - **Allowed but flagged (low/medium severity, or a configured hold-for-review):** the call succeeds normally and the message is saved and delivered exactly as any other message. The saved message document carries `moderationStatus: "clean" | "flagged" | "needs_review"` and a `moderationScore` number, but **the frontend is not expected to branch on these today** — they exist for a future admin moderation queue (Phase 5), not for client-side UI treatment.

### `markChatRead`
- **Auth required:** yes, must be a participant
- **Request:** `{ chatId: string, lastReadMessageId?: string }`
- **Response:** `{ success: true }`
- **Side effects:** writes the caller's own read receipt and marks up to 50 of the most recent messages from other senders as `status: "read"`.

### `saveChatDraft` / `clearChatDraft`
- **Auth required:** yes
- **Request:** `{ chatId: string, content: string }` (for save) / `{ chatId: string }` (for clear)
- **Response:** `{ success: true, cleared: boolean }` / `{ success: true }`
- **Note:** saving with empty or whitespace-only content clears the draft rather than storing an empty string. Drafts are owner-private — a vendor can never read a customer's draft or vice versa.

---

## Blocks

### `blockUser`
- **Auth required:** yes
- **Request:** `{ blockedUid: string, reason?: string }`
- **Response:** `{ success: true, blockId: string }`
- **Errors:** `invalid-argument` (attempting to block yourself), `not-found` (unknown user), `failed-precondition` (blocker role could not be determined)
- **Block ID is deterministic:** `{blockerUid}_{blockedUid}`. Re-blocking after an unblock is idempotent and safe.
- **Side effects:** a display snapshot (`blockedSnapshot`) is captured at block time and never updates afterward, so the blocked-users list renders correctly even if the blocked party later changes their name or deletes their account.

### `unblockUser`
- **Auth required:** yes, must be the original blocker
- **Request:** `{ blockedUid: string }`
- **Response:** `{ success: true }`
- **Errors:** `not-found` (no block record for this pair — note that only the party who created the block can find and remove it; the other party calling this receives `not-found`, not `permission-denied`), `failed-precondition` (already unblocked)

**Block enforcement semantics the frontend needs to understand:**

| Situation | Allowed? |
|---|---|
| Starting a brand-new commerce conversation while blocked | Never, regardless of any active order elsewhere |
| Sending a message in an existing thread, no active order between the pair | Denied |
| Sending a message in an existing thread, at least one active order exists | Allowed, until that order (and every other active order between the pair) reaches a terminal status |
| Placing a new order while blocked | Never |

"Active" and "terminal" here use the same classification as `isOrderActive` / `isOrderTerminal` referenced in the Milestone 2 notes above.

---

## Notifications and push tokens

### `markNotificationRead`
- **Auth required:** yes, owner of the notification
- **Request:** `{ notificationId: string }`
- **Response:** `{ success: true }`
- **Note:** only `read` and `readAt` can ever change on a notification document, whether through this callable or a direct client write attempt. Every other field is immutable after creation.

### `registerPushToken`
- **Auth required:** yes
- **Request:** `{ token: string, platform: "ios" | "android" | "web", deviceId?: string, appVersion?: string }`
- **Response:** `{ success: true, tokenId: string }`
- **Note:** passing `deviceId` makes the write idempotent per device (re-registering the same device updates rather than duplicates). Omitting it creates a new token record each call.

### `updateVendorNotificationPreferences`
- **Auth required:** yes, role `vendor`
- **Request:** any subset of `{ pushEnabled, newOrderRequest, paymentConfirmed, orderChanges, actionRequired, pendingOrderReminder, newMessage, unreadMessageReminder, quietHours: { enabled, startHour, endHour } }`
- **Response:** `{ success: true }`
- **Note:** `securityAlerts` cannot be set through this callable under any circumstances. It is forced to `true` server-side regardless of what the request contains — this preference does not exist as a user-facing toggle.

### `updateCustomerNotificationPreferences`
- **Auth required:** yes
- **Request:** any subset of `{ pushEnabled, orderUpdates, chatMessages, pickupReminders, cartReminders, promotions }`
- **Response:** `{ success: true }`

**Push delivery behavior the frontend should know about (not separate callables, just documented behavior):** in-app notification documents are always created regardless of push preferences — `pushEnabled: false` only suppresses the push send, never the in-app record. Quiet hours delay non-critical push notifications but never delay notification creation. A notification's `isCritical` flag, set server-side per event type, determines whether it bypasses quiet hours.

---

## Vendor chat settings, quick replies, pickup

### `updateVendorChatSettings`
- **Auth required:** yes, role `vendor`
- **Request:** any subset of `{ greetingEnabled: boolean, greetingMessage: string, awayMessageEnabled: boolean, awayMessage: string, awaySchedule?: object, quietHours?: object, awayCooldownHours?: number }`
- **Response:** `{ success: true }`
- **Errors:** `invalid-argument` if `greetingMessage` or `awayMessage` exceeds 300 characters, **or if either contains content blocked by moderation** (message: `"greetingMessage contains content that is not allowed on the platform."` / same for `awayMessage`) — these become automatically-sent system messages, so they are checked once at save time rather than on every send.
- **Behavioral notes:** the greeting message sends exactly once, on the thread's true first creation — never on subsequent messages, and never at all if `greetingMessage` is empty even with `greetingEnabled: true`. The away message has a per-thread cooldown, default 12 hours, configurable via `awayCooldownHours`, and only fires in response to a customer-sent message.

### `createQuickReply` / `updateQuickReply` / `deleteQuickReply`
- **Auth required:** yes, role `vendor`
- **Request (create):** `{ title: string, shortcut: string, message: string, sortOrder?: number }`
- **Request (update):** `{ replyId: string, ...anyEditableField }`
- **Request (delete):** `{ replyId: string }`
- **Response:** `{ success: true, replyId?: string }`
- **Errors:** `invalid-argument` (field length exceeded — see limits below; or `message` blocked by moderation, same wording as `sendChatMessage`), `already-exists` (shortcut collision), `resource-exhausted` (20-reply cap reached), `not-found`
- **Limits:** title max 50 characters, shortcut max 30 characters, message max 1000 characters, maximum 20 quick replies per vendor.
- **Shortcut normalization:** the server automatically prepends `/` if the client-supplied shortcut does not already start with one. Do not rely on the exact string you sent — read the value back from the response or a subsequent fetch.
- **Important:** quick replies are a client-side composer convenience only. Selecting one should populate the message composer; there is no callable that sends a quick reply directly. The frontend must still call `sendChatMessage` with `type: "text"` to actually send it.

### `updateVendorPickupSettings`
- **Auth required:** yes, role `vendor`
- **Request:** any subset of `{ pickupAddress: PickupAddress, pickupInstructions: string, pickupContactPhone?: string, pickupVerificationCode?: string, autoSendPickupDetailsEnabled: boolean }`
- **Response:** `{ success: true }`
- **Errors:** `invalid-argument` (`pickupInstructions` over 300 characters), `failed-precondition` — this is the important one: attempting to set `autoSendPickupDetailsEnabled: true` without both a saved `pickupAddress.streetAddress` and `pickupInstructions` already in place (either from this same request or a prior one) is rejected server-side. The frontend should disable this toggle in the UI accordingly, but the backend enforces it regardless of what the UI allows.
- **Note:** `pickupContactPhone` and `pickupVerificationCode` are never readable by customers directly. They only ever reach the customer through the structured `pickup-details` message, which is sent automatically — see below.

**Pickup auto-send behavior — there is no callable for this.** This is the most important architectural fact in this section: no client-callable function exists to manually trigger a pickup-details message, for either the vendor or the customer. The backend automatically inserts a `pickup-details` message into the commerce thread when **all** of the following become true simultaneously:

1. `order.fulfillmentType === "pickup"`
2. the order's payment status reaches the accepted state (this happens as a side effect of `reviewPaymentProof` with `decision: "accept"`, documented above in Milestone 2)
3. the vendor's `autoSendPickupDetailsEnabled` is `true`
4. the vendor has a saved `pickupAddress` and `pickupInstructions`

This check is idempotent — if a pickup-details message already exists for the order, it will never be duplicated, even if the payment-confirmation path is triggered more than once. If the vendor edits their pickup address or instructions after a message has already been sent for a given order, that historical message is unaffected; it retains the exact snapshot from the moment it was sent.

---

## Order-scoped delivery contact

### `submitDeliveryContact`
- **Auth required:** yes, the order's customer
- **Request:** `{ orderId: string, fullName: string, phoneNumber: string, address?: AddressObject }`
- **Response:** `{ success: true }`
- **Errors:** `invalid-argument`, `not-found`, `permission-denied` (not your order), `already-exists` — once submitted for an order, the contact snapshot is immutable and cannot be resubmitted or edited for that same order. If the customer needs to provide different details, that only happens naturally on their next order.

### `getOrderDetails`
- **Auth required:** yes, the order's customer, the order's vendor, or an admin
- **Request:** `{ orderId: string }`
- **Response:** `{ success: true, order: OrderDoc & { deliveryContactExpired?: true } }`
- **Errors:** `not-found`, `permission-denied`
- **This is the callable the frontend should use to display order details to a vendor, rather than reading `orders/{orderId}` directly.** The reason: once an order reaches a terminal status, the vendor's copy of `deliveryContact` is stripped from the response entirely and replaced with `deliveryContactExpired: true`. The customer always retains access to their own submitted contact details regardless of order status. A raw Firestore read of the order document does not enforce this expiry — only this callable does.

---

## Firestore collections added in Milestone 3 (read-only from client, all writes via the callables above)

| Collection | Client read access |
|---|---|
| `chatThreads/{chatId}` | participants only |
| `chatThreads/{chatId}/messages/{messageId}` | participants only |
| `chatThreads/{chatId}/readReceipts/{uid}` | participants only |
| `users/{uid}/chatDrafts/{chatId}` | owner only |
| `blocks/{blockId}` | the blocker only — the blocked party cannot see the block record |
| `users/{uid}/notifications/{notificationId}` | owner only |
| `users/{uid}/pushTokens/{tokenId}` | owner only |
| `vendors/{vendorId}/settings/notifications` | vendor owner, admin |
| `vendors/{vendorId}/settings/chat` | vendor owner, admin |
| `vendors/{vendorId}/settings/pickup` | vendor owner, admin — **never** customer-readable, by design |
| `vendors/{vendorId}/quickReplies/{replyId}` | vendor owner, admin — never customer-readable |
| `countryAvailability/{countryCode}` | public |


---

# Milestone 3 Additions (P3-FB-015, P3-FB-016) — Support Tickets and AI Help Placeholder

## Support tickets

Support tickets use a dual-document model. Each ticket creates both a `chatThreads/{chatId}` document with `chatType: "support"` and a `supportTickets/{ticketId}` document carrying the lifecycle fields specific to a support interaction. The `chatId` and `ticketId` are always the same value. Message sending, read receipts, and drafts for a support thread all reuse the existing `sendChatMessage`, `markChatRead`, and `saveChatDraft` callables documented in Milestone 3 above, with no modification, since those functions already branch on `chatType` and skip commerce-specific checks for support threads.

### `createSupportTicket` / `assignSupportTicket` / `resolveSupportTicket`

**`createSupportTicket`**
- **Auth required:** yes, role `customer` or `vendor`
- **Request:** `{ subject: string, initialMessage: string }`
- **Response:** `{ success: true, ticketId: string, chatId: string, created: boolean }`
- **Errors:** `unauthenticated`, `failed-precondition` (role could not be determined), `invalid-argument` (subject missing or over 150 characters, initialMessage missing)
- **Idempotent:** if the caller already has an open or assigned ticket, this callable returns that ticket's IDs with `created: false` rather than creating a duplicate. One open ticket per requester at a time is enforced server-side.
- **Note:** `ticketId` and `chatId` are always equal. The initial message is written into the `chatThreads/{chatId}/messages` subcollection as a `type: "text"` message from the requester in the same batch as the thread and ticket documents. The ticket starts with `status: "open"` and `priority: "normal"`.

**`assignSupportTicket`**
- **Auth required:** yes, role `admin` with `super_admin` or `support_admin` role
- **Request:** `{ ticketId: string, priority?: "low" | "normal" | "high" | "urgent" }`
- **Response:** `{ success: true }`
- **Errors:** `permission-denied` (caller is not a qualified admin), `not-found`, `failed-precondition` (ticket is already resolved or closed)
- **Side effects:** sets `status: "assigned"` and `assignedAdminUid` on the `supportTickets` document, adds the admin to the `chatThreads` document's `participants` array with role `"admin"` so they can send messages into the thread, and sends a notification to the requester.

**`resolveSupportTicket`**
- **Auth required:** yes, role `admin` with `super_admin` or `support_admin` role
- **Request:** `{ ticketId: string }`
- **Response:** `{ success: true }`
- **Errors:** `permission-denied` (caller is not the assigned agent and does not hold `super_admin`), `not-found`, `failed-precondition` (ticket is not currently in `assigned` status — only an assigned ticket can be resolved)
- **Authorization rule:** only the admin who was assigned the ticket, or any `super_admin`, may resolve it. A `support_admin` who was not assigned the ticket receives `permission-denied` even though they passed the initial role check.
- **Side effects:** sets `status: "resolved"`, `resolvedAt`, and `resolvedByAdminUid` on the `supportTickets` document, and sends a notification to the requester.

**Firestore collections added for support tickets:**

| Collection | Client read access |
|---|---|
| `supportTickets/{ticketId}` | the requester who opened the ticket and any admin — direct client writes always denied |

---

## AI help placeholder

### `createAiHelpThread`
- **Auth required:** yes, role `customer` or `vendor`
- **Request:** `{}` (empty object)
- **Response:** `{ success: true, chatId: string, created: boolean }`
- **Errors:** `unauthenticated`, `failed-precondition` (role could not be determined)
- **Thread ID is deterministic:** `ai_help_{uid}`. Each user has exactly one AI help thread for their lifetime, keyed to their uid. Calling this function repeatedly is idempotent and always returns the same `chatId` with `created: false` after the first call.
- **Important:** this is a placeholder. No language model or AI backend is connected. The thread contains exactly one system message of `type: "ai"` and `senderRole: "ai"` with a canned response directing the user to Contact Support. The content of this message explicitly states that AI assistance is not yet available. The frontend must not present this as a functional AI assistant. The reserved collection namespaces `evaKnowledgeBases`, `evaConversations`, `evaEscalations`, and `aiAuditLogs` exist in the architecture document for the future real implementation and must not be written to by any current code path.
- **Side effects:** on first creation only, writes the `chatThreads/{chatId}` document and one `messages/{messageId}` document atomically in a transaction, guarded against race conditions from concurrent calls.

---

## Chat moderation (P3-FB-021)

A rule-based content moderation layer that runs inside `sendChatMessage`, `updateVendorChatSettings`, and `createQuickReply` / `updateQuickReply` before anything is saved. It is a **flagging system first**, not an aggressive hard-ban system — the platform does not process payments in-app, so ordinary commerce phrases (`bank transfer`, `proof of payment`, `call me`, `contact me`, etc.) are never flagged on their own. They only contribute to a flag when they co-occur in the same message with a genuine off-platform-avoidance phrase (`pay outside the platform`, `message me on WhatsApp to order`, `DM for price`, etc.).

**What the frontend actually needs to handle:** the `invalid-argument` / `"This message contains content that is not allowed on the platform."` error shape documented on `sendChatMessage` above. Everything else (rule config, moderation events, risk scoring) is backend-internal and has no client-facing surface in this milestone — there is no moderation queue UI in Phase 3; that is deferred to Phase 5 admin tooling.

**Rules are backend-managed config, not hardcoded** — they live in the `moderationRules` Firestore collection (admin-readable only, never client-readable or writable) and are bootstrapped via `seedDefaultModerationRules`, documented below for completeness even though it is an admin/ops action, not something the customer or vendor apps call.

### `seedDefaultModerationRules`
- **Auth required:** yes, role `admin` with `super_admin`
- **Request:** `{}` (empty object)
- **Response:** `{ success: true, ruleCount: number }`
- **Errors:** `permission-denied` (not a `super_admin`)
- **Idempotent:** upserts a fixed default rule set by deterministic rule ID; calling it again does not create duplicates or change `ruleCount` if the defaults haven't changed.
- **Not for frontend use.** This exists for initial environment bootstrap and is intended to be superseded by direct rule editing once Phase 5 admin tooling exists.

**Severity → behavior mapping (for reference, not something the frontend computes):**

| Rule severity | Typical action | Message outcome |
|---|---|---|
| low / medium | `allow_flag` / `hold_for_review` | Sent normally; saved with `moderationStatus: "flagged"` or `"needs_review"` |
| high / critical | `block_message` | Rejected with `invalid-argument`, never saved |

**Firestore collections added for moderation:**

| Collection | Client read access |
|---|---|
| `moderationRules/{ruleId}` | admin only — direct client writes always denied |
| `moderationEvents/{eventId}` | admin only — direct client writes always denied; never contains raw message text, only a hash and a redacted snippet |