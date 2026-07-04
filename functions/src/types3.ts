/**
 * THE PLATFORM Phase 3 Types
 * Covers: Commerce/Support/AI chat, notifications, push tokens, blocks,
 *         read receipts, drafts, greeting/away messages, quick replies,
 *         pickup details auto-send, order-scoped contact snapshots.
 *
 * Source of truth: the client's Milestone 3 Scope Update (final, post-edge-case
 * revisions) — one canonical commerce thread per customerId+vendorId pair,
 * no persistent contact-card library (local-device only per MVP decision),
 * system-wide always-on read receipts (no toggle yet).
 */

import { firestore } from "firebase-admin";

// ─── Chat threads ──────────────────────────────────────────────────────────────

export type ChatType = "commerce" | "support" | "ai_help";

export type ParticipantRole = "customer" | "vendor" | "admin" | "system";

export type BlockedState = "none" | "blocked_by_customer" | "blocked_by_vendor" | "blocked_mutual";

export interface ChatThreadDoc {
  chatId: string;
  chatType: ChatType;

  vendorId?: string;
  vendorName?: string;
  customerId?: string;
  customerName?: string;

  // relatedOrderIds accumulates every order ever placed in this thread.
  // A commerce thread is NOT per-order — it is per (customerId, vendorId).
  relatedOrderIds: string[];

  participants: string[];
  participantRoles: Record<string, ParticipantRole>;

  title?: string;
  lastMessage?: string;
  lastMessageType?: string;
  lastMessageAt?: firestore.Timestamp | firestore.FieldValue;
  lastSenderUid?: string;

  archivedBy: string[];
  blockedState: BlockedState;
  isSupportEscalated: boolean;

  // Greeting message bookkeeping — sent exactly once per thread lifetime
  greetingSentAt?: firestore.Timestamp | firestore.FieldValue | null;

  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── Messages ────────────────────────────────────────────────────────────────

export type MessageSenderRole = "customer" | "vendor" | "system" | "ai" | "admin";

export type MessageType =
  | "text"
  | "system"
  | "payment-request"
  | "contact-card"
  | "pickup-details"
  | "catalog_item"
  | "receipt"
  | "invoice"
  | "ai"
  | "order_context"
  | "new_inquiry"
  | "change_request";

export type SystemMessageSubtype =
  | "greeting_message"
  | "away_message"
  | "order_context"
  | "block_notice";

export type MessageStatus = "sent" | "delivered" | "read";

export interface ContactCardSnapshotPayload {
  fullName: string;
  phoneNumber: string;
  address?: {
    line1: string;
    line2?: string;
    area: string;
    city: string;
    state: string;
    country: string;
  };
}

export interface PickupDetailsPayload {
  businessName: string;
  orderId: string;
  pickupAddress: {
    streetAddress: string;
    unitSuite?: string | null;
    areaId: string;
    areaName: string;
    stateCode: string;
    stateName: string;
    countryCode: string;
    countryName: string;
  };
  pickupInstructions: string;
  pickupContactPhone?: string | null;
  pickupVerificationCode?: string | null;
}

export interface CatalogItemSnapshotPayload {
  itemId: string;
  name: string;
  basePrice: number;
  salePrice?: number | null;
  currency: string;
  thumbnailUrl?: string | null;
}

export interface OrderContextPayload {
  orderId: string;
  publicOrderId: string;
  status: string;
  total: number;
  currency: string;
}

export interface MessageDoc {
  messageId: string;
  chatId: string;
  senderUid: string;
  senderRole: MessageSenderRole;

  type: MessageType;
  systemSubtype?: SystemMessageSubtype | null;
  content: string;

  // Exactly one populated, matching `type` — never client-writable except
  // for the customer-initiated contact-card / catalog_item shares which
  // are still server-validated and server-assembled, never trusted raw.
  contactCardData?: ContactCardSnapshotPayload | null;
  paymentRequestData?: Record<string, unknown> | null;
  pickupDetailsData?: PickupDetailsPayload | null;
  catalogItemData?: CatalogItemSnapshotPayload | null;
  receiptData?: Record<string, unknown> | null;
  invoiceData?: Record<string, unknown> | null;
  orderContextData?: OrderContextPayload | null;
  changeRequestData?: Record<string, unknown> | null;

  orderId?: string | null; // present on order_context / pickup-details messages

  status: MessageStatus;
  visibleToUser: boolean;
  moderationStatus?: "pending" | "approved" | "flagged" | "removed";
  attachments: {
    storagePath: string;
    contentType: string;
    sizeBytes: number;
  }[];

  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
  deletedAt?: firestore.Timestamp | firestore.FieldValue | null;
}

// ─── Read receipts ──────────────────────────────────────────────────────────────

export interface ReadReceiptDoc {
  uid: string;
  lastReadMessageId: string | null;
  lastReadAt: firestore.Timestamp | firestore.FieldValue;
  unreadCount: number;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── Drafts ─────────────────────────────────────────────────────────────────────

export interface ChatDraftDoc {
  chatId: string;
  uid: string;
  content: string;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── Blocks ─────────────────────────────────────────────────────────────────────

export interface BlockedSnapshot {
  displayName: string;
  businessName?: string | null;
  photoURL?: string | null;
  initials: string;
  role: ParticipantRole;
}

export interface BlockDoc {
  blockId: string; // deterministic: `${blockerUid}_${blockedUid}`
  blockerUid: string;
  blockedUid: string;

  blockerRole: "customer" | "vendor";
  blockedRole: "customer" | "vendor";

  vendorId?: string | null;
  customerId?: string | null;

  blockedSnapshot: BlockedSnapshot;

  reason?: string | null;
  blockedAt: firestore.Timestamp | firestore.FieldValue;
  isActive: boolean;
  unblockedAt?: firestore.Timestamp | firestore.FieldValue | null;
  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── Notifications ──────────────────────────────────────────────────────────────

export type NotificationDomain =
  | "order"
  | "vendor_chat"
  | "customer_chat"
  | "support"
  | "verification"
  | "system"
  | "promotion"
  | "admin";

export interface NotificationDoc {
  notificationId: string;
  recipientUid: string;
  recipientRole: "customer" | "vendor" | "admin";
  vendorId?: string | null;
  customerId?: string | null;

  type: string;
  domain: NotificationDomain;

  title: string;
  body: string;
  deepLink?: string | null;
  metadata?: Record<string, unknown>;

  read: boolean;
  readAt?: firestore.Timestamp | firestore.FieldValue | null;
  createdAt: firestore.Timestamp | firestore.FieldValue;
  expiresAt?: firestore.Timestamp | firestore.FieldValue | null;

  isCritical: boolean; // bypasses quiet hours

  pushSent: boolean;
  pushSentAt?: firestore.Timestamp | firestore.FieldValue | null;
  pushError?: string | null;
}

// ─── Push tokens ────────────────────────────────────────────────────────────────

export interface PushTokenDoc {
  tokenId: string;
  token: string;
  platform: "ios" | "android" | "web";
  deviceId?: string | null;
  appVersion?: string | null;
  enabled: boolean;
  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
  lastSeenAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── Notification preferences ────────────────────────────────────────────────────

export interface VendorNotificationPreferences {
  pushEnabled: boolean;
  newOrderRequest: boolean;
  paymentConfirmed: boolean;
  orderChanges: boolean;
  actionRequired: boolean;
  pendingOrderReminder: boolean;
  newMessage: boolean;
  unreadMessageReminder: boolean;
  quietHours: {
    enabled: boolean;
    startHour?: number; // 0-23 local vendor time
    endHour?: number;
  };
  securityAlerts: true; // always true, not disableable — typed as literal
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

export interface CustomerNotificationPreferences {
  pushEnabled: boolean;
  orderUpdates: boolean;
  chatMessages: boolean;
  pickupReminders: boolean;
  cartReminders: boolean;
  promotions: boolean;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

export const VENDOR_NOTIFICATION_DEFAULTS: Omit<VendorNotificationPreferences, "updatedAt"> = {
  pushEnabled: true,
  newOrderRequest: true,
  paymentConfirmed: true,
  orderChanges: true,
  actionRequired: true,
  pendingOrderReminder: true,
  newMessage: true,
  unreadMessageReminder: true,
  quietHours: { enabled: false },
  securityAlerts: true,
};

export const CUSTOMER_NOTIFICATION_DEFAULTS: Omit<CustomerNotificationPreferences, "updatedAt"> = {
  pushEnabled: true,
  orderUpdates: true,
  chatMessages: true,
  pickupReminders: true,
  cartReminders: false,
  promotions: false,
};

// ─── Vendor chat settings (greeting / away) ───────────────────────────────────────

export interface VendorChatSettingsDoc {
  greetingEnabled: boolean;
  greetingMessage: string;
  greetingUpdatedAt?: firestore.Timestamp | firestore.FieldValue | null;
  greetingLastEditedByUid?: string | null;

  awayMessageEnabled: boolean;
  awayMessage: string;
  awaySchedule?: Record<string, unknown> | null;
  quietHours?: Record<string, unknown> | null;
  awayCooldownHours: number;
  // Per-thread cooldown tracking — map of chatId -> last sent timestamp
  lastAwayMessageSentAtByThread?: Record<string, firestore.Timestamp> | null;

  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

export const VENDOR_CHAT_SETTINGS_DEFAULTS: Omit<VendorChatSettingsDoc, "updatedAt"> = {
  greetingEnabled: false,
  greetingMessage: "",
  awayMessageEnabled: false,
  awayMessage: "",
  awayCooldownHours: 12,
};

// ─── Quick replies ──────────────────────────────────────────────────────────────

export interface QuickReplyDoc {
  replyId: string;
  vendorId: string;
  title: string;
  shortcut: string; // unique per vendor, starts with "/"
  message: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

export const QUICK_REPLY_LIMITS = {
  maxTitleLength: 50,
  maxShortcutLength: 30,
  maxMessageLength: 1000,
  maxPerVendor: 20,
} as const;

// ─── Support tickets (P3-FB-015) ────────────────────────────────────────────────

/**
 * A support ticket wraps exactly one chatThreads document with
 * chatType: "support". The chatThreads document remains the source of
 * truth for participants, messages, and read state, following the same
 * generic mechanics already built for commerce threads. This document
 * carries the ticket-lifecycle fields that a commerce thread has no
 * concept of: status, priority, and admin assignment.
 *
 * One open ticket per requester at a time is enforced at creation time,
 * mirroring the "one canonical thread" discipline already established
 * for commerce conversations, so a requester cannot flood the queue with
 * duplicate open tickets for the same underlying issue.
 */
export type SupportTicketStatus = "open" | "assigned" | "resolved" | "closed";
export type SupportTicketPriority = "low" | "normal" | "high" | "urgent";

export interface SupportTicketDoc {
  ticketId: string;       // same value as the underlying chatId
  chatId: string;
  requesterUid: string;
  requesterRole: "customer" | "vendor";
  subject: string;

  status: SupportTicketStatus;
  priority: SupportTicketPriority;

  assignedAdminUid?: string | null;
  assignedAt?: firestore.Timestamp | firestore.FieldValue | null;

  resolvedAt?: firestore.Timestamp | firestore.FieldValue | null;
  resolvedByAdminUid?: string | null;
  closedAt?: firestore.Timestamp | firestore.FieldValue | null;

  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

export const SUPPORT_TICKET_LIMITS = {
  maxSubjectLength: 150,
} as const;

// ─── Pickup settings ────────────────────────────────────────────────────────────

export interface PickupAddress {
  streetAddress: string;
  unitSuite?: string | null;
  areaId: string;
  areaName: string;
  stateCode: string;
  stateName: string;
  countryCode: string;
  countryName: string;
}

export interface VendorPickupSettingsDoc {
  pickupAddress?: PickupAddress | null;
  pickupInstructions?: string | null;
  pickupContactPhone?: string | null;
  pickupVerificationCode?: string | null;
  autoSendPickupDetailsEnabled: boolean;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
  updatedByUid: string;
}

export const PICKUP_LIMITS = {
  maxInstructionsLength: 300,
} as const;

// ─── Country availability ───────────────────────────────────────────────────────

export interface CountryAvailabilityDoc {
  countryCode: string;
  countryName: string;
  status: "ACTIVE" | "DISABLED" | "WAITLIST";
  updatedAt: firestore.Timestamp | firestore.FieldValue;
  updatedBy: string;
}

// ─── Order-scoped contact snapshot (extends Phase 2 OrderDoc) ────────────────────

export interface DeliveryContactSnapshot {
  fullName: string;
  phoneNumber: string;
  address?: {
    line1: string;
    line2?: string;
    area: string;
    city: string;
    state: string;
    country: string;
  } | null;
  submittedAt: firestore.Timestamp | firestore.FieldValue;
}

// Fields added to Phase 2's OrderDoc in Phase 3 — additive only.
export interface OrderPhase3Extension {
  conversationId?: string | null;
  deliveryContact?: DeliveryContactSnapshot | null;
}
