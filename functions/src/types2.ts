/**
 * PLATFORM Phase 2 Types
 * Covers: Catalog, Carts, Orders, Inventory, Receipts, Payment Proofs,
 *         Change Requests, Order Events
 */
import { firestore } from "firebase-admin";
import { PaymentDestination } from "./types5";

export const PLAN_CATALOG_LIMITS: Record<string, number> = {
  basic: 10,
  standard: 30,
  pro: 70,
  pro_plus: 120,
};

// ─── Catalog ──────────────────────────────────────────────────────────────────

export interface CatalogCategoryDoc {
  categoryId: string;
  vendorId: string;
  name: string;
  description?: string | null;
  order: number;
  isSystem: boolean;
  itemCount: number;
  visibleItemCount: number;
  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

export type ModerationStatus = "pending" | "approved" | "rejected" | "flagged";

export interface AddOnOption {
  optionId: string;
  name: string;
  priceModifier: number;
}

export interface AddOnGroup {
  groupId: string;
  name: string;
  /** Optional vendor-set override for the group's helper text (e.g. "Choose
   * up to 2"); the client falls back to a computed default when absent. */
  subheading?: string;
  required: boolean;
  multiSelect: boolean;
  maxSelections?: number;
  options: AddOnOption[];
}

export interface CatalogItemDoc {
  itemId: string;
  vendorId: string;
  categoryId?: string | null;
  name: string;
  description?: string | null;
  basePrice: number;
  salePrice?: number | null;
  currency: string;
  photos: string[];
  thumbnailUrl?: string | null;
  isAvailable: boolean;
  isHidden: boolean;
  isOutOfStock: boolean;
  inventoryQuantity: number;
  reservedQuantity: number;   // server-controlled
  trackInventory: boolean;
  lowStockThreshold?: number | null;
  addOnGroups?: AddOnGroup[];
  orderCount: number;          // server-controlled
  moderationStatus: ModerationStatus;
  moderationNotes?: string | null;
  /** Phase 2: whether a proposed edit is awaiting review. Only a boolean lives
   * on the item itself — the proposed values are stored in the private
   * `moderation/pendingRevision` subcollection instead.
   *
   * This split is deliberate and load-bearing. Customers read approved catalog
   * item documents directly under Firestore rules, and rules cannot restrict
   * individual fields on a read: anything on this document is readable by
   * anyone allowed to read the document at all. Keeping the proposed edit here
   * would therefore publish unreviewed content (and any rejection reason) to
   * every customer, which is exactly what moderation exists to prevent. */
  hasPendingRevision?: boolean;
  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

/** The subset of catalog fields a vendor edit can propose. Deliberately only
 * the material ones — operational fields (stock, visibility, availability)
 * apply immediately and never sit in a revision. */
export interface PendingRevisionChanges {
  name?: string;
  description?: string | null;
  categoryId?: string | null;
  basePrice?: number;
  salePrice?: number | null;
  photos?: string[];
  addOnGroups?: AddOnGroup[];
}

/**
 * Stored at vendors/{vendorId}/catalogItems/{itemId}/moderation/pendingRevision
 * — a subcollection, so Firestore rules can deny customers access to it
 * entirely while still allowing them to read the approved parent item.
 */
export interface PendingRevision {
  changes: PendingRevisionChanges;
  submittedAt: firestore.Timestamp | firestore.FieldValue;
  /** Set when an admin rejects the revision, so the vendor can see why and fix
   * it. Cleared on resubmission. */
  rejectionReason?: string | null;
  status: "pending" | "rejected";
}

/** Single well-known document id for an item's current pending revision. One
 * outstanding revision per item, so this never needs to be a generated id. */
export const PENDING_REVISION_DOC_ID = "pendingRevision";

// ─── Carts ────────────────────────────────────────────────────────────────────

export interface CartItem {
  itemId: string;
  name: string;
  basePrice: number;
  salePrice?: number | null;
  quantity: number;
  selectedAddOns?: {
    groupId: string;
    groupName: string;
    optionId: string;
    optionName: string;
    priceModifier: number;
  }[];
  lineTotal: number;
}

export interface CartDoc {
  cartId: string;
  customerId: string;
  vendorId: string;
  items: CartItem[];
  quantity: number;
  subtotal: number;
  tax: number;
  discount: number;
  total: number;
  fulfillmentType: "pickup" | "delivery" | "shipping";
  orderNote?: string | null;
  expiresAt: firestore.Timestamp | firestore.FieldValue;
  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
  appliedPromotion?: { promotionId: string; title: string; discountAmount: number } | null;
}

// ─── Promotions ─────────────────────────────────────────────────────────────
// Mirrors the mobile app's VendorPromotion shape (mocks/promotionsData.ts)
// exactly, field for field, so the eventual repository swap there is a
// straight passthrough rather than a remapping.

export type PromotionType = "percentage" | "flat" | "bogo" | "free_item" | "free_delivery";

export interface PromotionDoc {
  promotionId: string;
  vendorId: string;
  title: string;
  shortDescription: string;
  fullDescription: string;
  type: PromotionType;
  discountValue: number;
  minimumOrder: number;
  maxDiscount?: number | null;
  freeItemName?: string | null;
  bogoItemName?: string | null;
  applicableItemIds?: string[] | null;
  applicableCategoryIds?: string[] | null;
  active: boolean;
  startDate: string; // ISO date
  endDate: string; // ISO date
  icon: "percent" | "gift" | "truck" | "tag" | "zap";
  eligibility?: "all" | "pickup" | "delivery" | null;
  vendorTerms?: string | null;
  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── Orders ───────────────────────────────────────────────────────────────────

export type OrderSource = "internal" | "external";

export type OrderStatus =
  | "requested" | "accepted" | "confirmed"
  | "in_progress" | "completed"
  | "rejected" | "cancelled" | "expired";

export type PaymentStatus =
  | "UNPAID" | "PROOF_SUBMITTED" | "PROOF_ACCEPTED"
  | "PROOF_REJECTED" | "PROOF_LOCKED";

export interface OrderItemSnapshot {
  itemId: string;
  name: string;
  basePrice: number;
  salePrice?: number | null;
  quantity: number;
  selectedAddOns?: CartItem["selectedAddOns"];
  lineTotal: number;
}

export interface OrderVendorSnapshot {
  vendorId: string;
  name: string;
  username: string;
  slug: string;
  phone?: string | null;
  email?: string | null;
  area?: string | null;
  state?: string | null;
  country?: string | null;
}

export interface OrderCustomerSnapshot {
  customerId: string;
  displayName: string;
  photoURL?: string | null;
}

export interface OrderDoc {
  orderId: string;
  publicOrderId: string;
  vendorId: string;
  customerId: string;
  linkedCustomerId?: string | null;
  orderSource: OrderSource;
  conversationId: string;
  createdByVendor: boolean;
  externalCustomerName?: string | null;
  externalCustomerPhone?: string | null;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  fulfillmentType: "pickup" | "delivery" | "shipping";
  orderNote?: string | null;
  items: OrderItemSnapshot[];
  orderSnapshot: {
    subtotal: number; tax: number; discount: number;
    total: number; currency: string;
  };
  vendorSnapshot: OrderVendorSnapshot;
  customerSnapshot: OrderCustomerSnapshot;
  acceptanceDeadlineAt: firestore.Timestamp | firestore.FieldValue;
  acceptedAt?: firestore.Timestamp | firestore.FieldValue | null;
  rejectedAt?: firestore.Timestamp | firestore.FieldValue | null;
  completedAt?: firestore.Timestamp | firestore.FieldValue | null;
  cancelledAt?: firestore.Timestamp | firestore.FieldValue | null;
  /**
   * The reason typed into the vendor's reject/cancel modal. Already sent to
   * updateOrderStatus and already used for the customer's push notification
   * body and the order-events log, but never persisted onto the order
   * itself - the customer's order detail screen has always displayed
   * order.rejectionReason/cancellationReason directly, so re-opening the
   * order after the notification was gone showed no reason at all.
   */
  rejectionReason?: string | null;
  cancellationReason?: string | null;
  expiredAt?: firestore.Timestamp | firestore.FieldValue | null;
  // External Orders only — the payment ledger's derived projection onto this
  // order (recordPayment/reversePayment). Separate from paymentStatus above,
  // which is the customer proof-workflow enum: these describe what a vendor
  // has actually recorded against the order, not what a customer claimed.
  // Absent on internal orders, and absent on external orders created before
  // this field existed until the ledger next touches them (see
  // rebuildOrderPaymentProjection for the lazy-reconstruction path).
  ledgerAmountPaidMinorUnits?: number;
  ledgerPaymentStatus?: "unpaid" | "partial" | "paid" | "overpaid";
  lastLedgerActivityAt?: firestore.Timestamp | firestore.FieldValue | null;
  /**
   * Points at whichever paymentRequests/{requestId} document is currently
   * "active"/"resent" for this order, if any -- the deterministic
   * serialization point sendPaymentRequestInChat reads and writes inside
   * one transaction so that two concurrent, genuinely different Send
   * Payment Request attempts (two different idempotency keys) for the same
   * order conflict and retry through this shared document rather than
   * relying solely on query-based transaction semantics. Absent on orders
   * created before this field existed, or that have never had a payment
   * request sent against them -- sendPaymentRequestInChat falls back to a
   * legacy status-based query the first time such an order gets one, then
   * populates this field going forward.
   */
  activePaymentRequestId?: string;
  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── Order Events ─────────────────────────────────────────────────────────────

export type OrderEventType =
  | "ORDER_CREATED" | "STATUS_CHANGED" | "ORDER_EXPIRED"
  | "ORDER_AUTO_EXPIRED" | "ORDER_ACCEPTANCE_TIMEOUT"
  | "INVENTORY_RESERVED" | "INVENTORY_RELEASED"
  | "PAYMENT_PROOF_SUBMITTED" | "PAYMENT_PROOF_REJECTED"
  | "PAYMENT_PROOF_APPROVED" | "PAYMENT_PROOF_LOCKED"
  | "RECEIPT_GENERATED" | "PAYMENT_PROOF_LIMIT_REACHED"
  | "CHANGE_REQUEST_ACCEPTED" | "CHANGE_REQUEST_DECLINED";

export interface OrderEventDoc {
  eventId: string;
  orderId: string;
  vendorId: string;
  eventType: OrderEventType;
  actorUid?: string | null;
  actorRole?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  createdAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── Change Requests ─────────────────────────────────────────────────────────

export type ChangeRequestStatus = "PENDING" | "ACCEPTED" | "REJECTED";

export interface ChangeRequestDoc {
  changeRequestId: string;
  orderId: string;
  vendorId: string;
  status: ChangeRequestStatus;
  proposedChanges: { items?: OrderItemSnapshot[]; notes?: string; newTotal?: number; };
  message: string;
  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── Payment Proofs ───────────────────────────────────────────────────────────

export type PaymentProofStatus = "SUBMITTED" | "REVIEWED" | "REJECTED" | "LOCKED";

export interface PaymentProofImage {
  storagePath: string;
  thumbnailPath: string;
  uploadedAt: firestore.Timestamp | firestore.FieldValue;
  uploadedBy: string;
}

export interface PaymentProofDoc {
  proofId: string;
  orderId: string;
  vendorId: string;
  customerId: string;
  submissionCount: number;
  status: PaymentProofStatus;
  notes?: string | null;
  reviewReason?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: firestore.Timestamp | firestore.FieldValue | null;
  images: PaymentProofImage[];
  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
  uploadedBy: string;
}

// ─── Payment Requests (chat) ───────────────────────────────────────────────────
//
// A vendor's "pay me" ask sent through an order's chat thread. Unlike
// PaymentProofDoc (the customer's evidence that they paid), this is the
// vendor's own request that names an amount and points the customer at the
// vendor's real payment instructions.
//
// There is deliberately no structured bank-name/account-name/account-number
// selection on the legacy path. The only free-text vendor payment field is a
// single instructions string (vendors/{vendorId}/settings/payment
// .paymentInstructions, a private owner-only subdoc — gated by
// paymentInstructionsEnabled, written by updateVendorPaymentInstructions.ts)
// — there is no paymentMethods array, no primaryPaymentMethod/
// secondaryPaymentMethod on that legacy path. A structured alternative now
// also exists (paymentDestinationSnapshot below), sourced from the vendor's
// canonical Payment Instructions record instead. A captured snapshot of
// whichever source applied lives on this doc so a later edit to the
// vendor's instructions never rewrites what was actually shown at send time.
//
// Status vocabulary is deliberately narrower than the order/proof lifecycle:
// this doc only tracks the request's own lifecycle (was it superseded by a
// newer request, cancelled, or eventually confirmed), never the payment
// proof review outcome, which paymentProofs/reviewPaymentProof already own.
export type PaymentRequestStatus = "active" | "resent" | "replaced" | "cancelled" | "confirmed";

export interface PaymentRequestDoc {
  requestId: string;
  orderId: string;
  vendorId: string;
  customerId: string;
  amount: number;
  currency: string;
  // Snapshot of vendors/{vendorId}/settings/payment.paymentInstructions at
  // send time — never re-read live by the chat card, so an instructions
  // edit afterward cannot silently rewrite what the customer was already
  // shown. Optional: legacy documents (created before the structured
  // snapshot below existed) all have this set; new structured requests omit
  // it entirely rather than writing a fake/empty string merely to satisfy
  // this field.
  paymentInstructions?: string;
  // Structured Batch 2B/2C.2 snapshot — the sole location for the raw
  // destination (account number, IBAN, routing, SWIFT/BIC, contact
  // email/phone). Never duplicated into the chat message; the message only
  // ever carries enough metadata to look this document up. Immutable once
  // created, same as paymentInstructions above.
  paymentDestinationSnapshot?: {
    paymentDestination: PaymentDestination | null;
    acceptCash: boolean;
  };
  // Audit metadata pointing back at the exact vendors/{vendorId}/
  // paymentInstructions/{recordId} history entry that was current at send
  // time — does not replace the immutable destination snapshot above, just
  // makes it traceable back to that historical record.
  paymentInstructionsVersion?: number;
  paymentInstructionsRecordId?: string;
  message?: string | null;
  status: PaymentRequestStatus;
  chatId: string;
  messageId: string;
  sentAt: firestore.Timestamp | firestore.FieldValue;
  replacedAt?: firestore.Timestamp | firestore.FieldValue | null;
  replacedByRequestId?: string | null;
  // Set by reviewPaymentProof on accept, alongside status: "confirmed" —
  // previously nothing ever moved this doc (or the chat message's own
  // paymentRequestData.status) out of "active" once a payment actually
  // cleared, so the request looked permanently outstanding regardless of
  // real payment state.
  confirmedAt?: firestore.Timestamp | firestore.FieldValue | null;
  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── Receipts ────────────────────────────────────────────────────────────────

export interface ReceiptDoc {
  receiptId: string;
  receiptNumber: string;
  orderId: string;
  vendorId: string;
  customerId: string;
  items: OrderItemSnapshot[];
  subtotal: number;
  tax: number;
  discount: number;
  total: number;
  currency: string;
  generatedAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── Vendor sequence counters ─────────────────────────────────────────────────

export interface VendorSequenceDoc {
  vendorId: string;
  orderSequence: number;
  externalOrderSequence: number;
  receiptSequence: number;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}
