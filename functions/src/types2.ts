/**
 * THE PLATFORM Phase 2 Types
 * Covers: Catalog, Carts, Orders, Inventory, Receipts, Payment Proofs,
 *         Change Requests, Order Events
 */
import { firestore } from "firebase-admin";

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
  createdAt: firestore.Timestamp | firestore.FieldValue;
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

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
  expiredAt?: firestore.Timestamp | firestore.FieldValue | null;
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
  | "RECEIPT_GENERATED" | "PAYMENT_PROOF_LIMIT_REACHED";

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
