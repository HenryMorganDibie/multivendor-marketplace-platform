/**
 * Shared Firestore document types — Milestone 1 (full architecture scope).
 *
 * Mirrors the original architecture document sections 4.1-4.7 and the
 * P1-FB-001..013 ticket set. No trimming — multi-role admin, full audit
 * schema, provider-aware verification, App Check awareness.
 */

import { firestore } from "firebase-admin";

export type UserRole = "customer" | "vendor" | "admin";

export type AccountStatus =
  | "active"
  | "pending_deletion"
  | "deactivated"
  | "frozen"
  | "banned";

export interface UserDoc {
  uid: string;
  email?: string | null;
  phoneNumber?: string | null;
  displayName?: string | null;
  photoURL?: string | null;

  role: UserRole;
  accountStatus: AccountStatus;
  vendorId?: string | null;

  // Custom-claims versioning — incremented whenever role/vendorId/admin
  // claims change, so clients know to force a token refresh.
  claimsVersion: number;

  onboarding: {
    completed: boolean;
    completedAt?: firestore.Timestamp | null;
    currentStep?: string | null;
  };

  profile: {
    firstName?: string;
    lastName?: string;
    fullName?: string;
    username?: string;
    countryCode?: string;
    region?: string;
    city?: string;
    area?: string;
  };

  notificationPreferences?: {
    orderUpdates: boolean;
    messages: boolean;
    promotions: boolean;
    support: boolean;
  };

  privacy?: {
    profileVisibility: "public" | "private";
    allowVendorMessages: boolean;
    analyticsOptOut: boolean;
  };

  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
  lastLoginAt?: firestore.Timestamp | firestore.FieldValue;
}

// ---------------------------------------------------------------------------
// Vendor verification vs vendor account status
// ---------------------------------------------------------------------------

export type VerificationStatus =
  | "not_started"
  | "pending_review"
  | "retry_required"
  | "approved"
  | "rejected";

export type VendorAccountStatus =
  | "active"
  | "suspended"
  | "deactivated"
  | "frozen";

export type VendorPlan = "basic" | "standard" | "pro" | "pro_plus";

export interface VendorDoc {
  vendorId: string;
  ownerUid: string;

  username: string;
  slug?: string;
  name: string;
  businessName?: string;
  category?: string;
  categoryId?: string;
  categoryName?: string;
  description?: string;

  logoImage?: string;
  bannerImage?: string;
  galleryImages?: string[];

  countryCode?: string;
  country?: string;
  region?: string;
  state?: string;
  city?: string;
  area?: string;
  fullAddress?: string;

  // --- Status model (source of truth) ---
  verificationStatus: VerificationStatus;
  vendorStatus: VendorAccountStatus;

  // --- Discovery flags, derived/enforced server-side ---
  isVerified: boolean;
  isPublished: boolean;
  isDiscoverable: boolean;

  // --- Storefront / commerce config (owner-editable, allowlisted) ---
  fulfillmentTypes?: string[];
  pickup?: boolean;
  delivery?: boolean;
  shipping?: boolean;
  shippingScope?: "domestic" | "international";
  minimumOrderAmount?: number;
  currency?: string;
  taxEnabled?: boolean;
  taxRate?: number;
  policy?: string;

  storeStatus?: "open" | "closed" | "away" | "sleep_mode";
  storeStatusMode?: "follow_hours" | "manual";
  closedForOrders?: boolean;
  isOpenNow?: boolean;
  awayMessage?: string;
  closedMessage?: string;

  contactLinks?: {
    website?: string;
    instagram?: string;
    tiktok?: string;
  };
  email?: string;
  phone?: string;

  plan: VendorPlan;

  // --- Aggregates (server-controlled only) ---
  ratingAverage?: number;
  ratingCount?: number;
  orderCount?: number;
  recentOrders7Days?: number;
  ordersLast48h?: number;
  profileViews?: number;
  favoritesCount?: number;

  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
  approvedAt?: firestore.Timestamp | firestore.FieldValue | null;
  suspendedAt?: firestore.Timestamp | firestore.FieldValue | null;
  deactivatedAt?: firestore.Timestamp | firestore.FieldValue | null;
  frozenAt?: firestore.Timestamp | firestore.FieldValue | null;
}

// ---------------------------------------------------------------------------
// Vendor verification — provider-aware (architecture doc section 4.7)
// ---------------------------------------------------------------------------

export interface VendorVerificationDoc {
  vendorId: string;
  ownerUid: string;
  verificationStatus: VerificationStatus;
  type: "individual" | "business";

  submittedAt?: firestore.Timestamp | firestore.FieldValue | null;
  reviewedAt?: firestore.Timestamp | firestore.FieldValue | null;
  referenceId?: string;

  rejectionReason?: string | null;
  retryReason?: string | null;
  retryAllowed?: boolean;
  requiresKYB?: boolean;
  kybCompleted?: boolean;

  // Provider integration fields (manual/internal review for MVP; structure
  // ready for a future KYC/KYB provider).
  providerName?: string | null;
  providerApplicantId?: string | null;
  providerVerificationId?: string | null;
  providerStatus?: string | null;
  providerWebhookStatus?: string | null;
  providerFailureReason?: string | null;

  manualReviewStatus?: "pending" | "in_review" | "completed";
  reviewerAdminUid?: string | null;
  reviewNotes?: string | null;

  requiredSteps?: string[];
  documentCount?: number;

  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

export interface VerificationDocumentDoc {
  docId: string;
  vendorId: string;
  type: "business_info" | "identity_document" | "proof_of_address" | "other";
  storagePath: string;
  contentType: string;
  sizeBytes: number;
  uploadedByUid: string;
  status: "uploaded" | "rejected" | "accepted";
  createdAt: firestore.Timestamp | firestore.FieldValue;
}

// ---------------------------------------------------------------------------
// Admin model — full multi-role (architecture doc 3.2 / 4.2-4.5)
// ---------------------------------------------------------------------------

export type AdminRoleId =
  | "super_admin"
  | "verification_admin"
  | "support_admin"
  | "safety_admin"
  | "read_only_admin";

export interface AdminUserDoc {
  uid: string;
  email?: string | null;
  displayName?: string | null;
  roleIds: AdminRoleId[];
  status: "invited" | "active" | "suspended" | "revoked";
  mfaRequired: boolean;
  mfaEnrolled: boolean;
  lastMfaAt?: firestore.Timestamp | firestore.FieldValue | null;
  allowedEnvironments?: string[];
  createdByAdminUid?: string | null;
  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
  lastLoginAt?: firestore.Timestamp | firestore.FieldValue | null;
  revokedAt?: firestore.Timestamp | firestore.FieldValue | null;
}

export interface AdminRoleDoc {
  roleId: AdminRoleId;
  name: string;
  description: string;
  permissions: string[];
  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

export interface AdminInviteDoc {
  inviteId: string;
  email: string;
  roleIds: AdminRoleId[];
  status: "pending" | "accepted" | "expired" | "revoked";
  invitedByAdminUid: string;
  acceptedByUid?: string | null;
  expiresAt: firestore.Timestamp | firestore.FieldValue;
  createdAt: firestore.Timestamp | firestore.FieldValue;
  acceptedAt?: firestore.Timestamp | firestore.FieldValue | null;
  revokedAt?: firestore.Timestamp | firestore.FieldValue | null;
}

export interface AdminSessionDoc {
  sessionId: string;
  adminUid: string;
  environment: string;
  ipHash?: string | null;
  userAgent?: string | null;
  deviceLabel?: string | null;
  mfaVerifiedAt?: firestore.Timestamp | firestore.FieldValue | null;
  createdAt: firestore.Timestamp | firestore.FieldValue;
  lastSeenAt: firestore.Timestamp | firestore.FieldValue;
  revokedAt?: firestore.Timestamp | firestore.FieldValue | null;
  riskFlags?: string[];
}

// ---------------------------------------------------------------------------
// Audit logs — full schema with requestId/functionName/App Check status
// ---------------------------------------------------------------------------

export type AuditActorType = "customer" | "vendor" | "admin" | "system";

export interface AuditLogDoc {
  requestId: string;
  functionName: string;

  actor: {
    uid: string | null;
    role: UserRole | "system";
    type: AuditActorType;
    adminRoleIds?: AdminRoleId[];
  };

  target: {
    type: string;
    id: string;
  };

  eventType: string;
  message?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;

  appCheck: {
    present: boolean;
    verified: boolean | null; // null = App Check not enforced/available
  };

  environment: string;
  createdAt: firestore.Timestamp | firestore.FieldValue;
}

// ---------------------------------------------------------------------------
// Registration payloads
// ---------------------------------------------------------------------------

export interface CompleteRegistrationRequest {
  role: UserRole;
  firstName?: string;
  lastName?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  area?: string;
  businessName?: string;
  username?: string;
  plan?: VendorPlan;
  fullName?: string;
  categoryId?: string;
  categoryName?: string;
  country?: string;
  state?: string;
}

// ---------------------------------------------------------------------------
// App Check context, attached to every request after verification
// ---------------------------------------------------------------------------

export interface AppCheckContext {
  present: boolean;
  verified: boolean | null;
}
