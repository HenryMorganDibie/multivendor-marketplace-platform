/**
 * PLATFORM Phase 5 Types — Internal-Order Direct-Payment Domain
 *
 * Batch 1 scope only: type definitions for the five new payment-domain
 * collections whose Firestore Rules this batch introduces (vendor Payment
 * Instructions, Confirmed Direct Payments, Refunds, Payment Disputes,
 * Payment Instruction Change Events). No runtime code reads or writes these
 * shapes yet — that begins in later batches of the approved Payment Domain
 * implementation plan. Deliberately excludes any field belonging to a later
 * batch (e.g. PaymentRequest.lifecycle/dueContext on the existing
 * paymentRequests collection, OrderDoc.paymentSummary,
 * VendorDoc.acceptCashPayments/paymentsFrozen) — those are added when the
 * batch that implements them lands, not speculatively here.
 *
 * Kept fully separate from payments/paymentLedger.ts's PaymentMethod/
 * PaymentType (the pre-existing External Order/invoice ledger) — same
 * English words, a different domain, deliberately never merged (frozen
 * architecture §21/§30).
 */
import { firestore } from "firebase-admin";

// ─── Shared ─────────────────────────────────────────────────────────────────

/**
 * MVP-supported direct-payment methods, controlled by Platform. No crypto,
 * no arbitrary vendor-defined method. Distinct from
 * payments/paymentLedger.ts's PaymentMethod ("cash"|"transfer"|"card"|
 * "other"), which belongs to the separate External Order/invoice ledger.
 */
export type DirectPaymentMethod = "bank_transfer" | "cash";

// ─── Vendor Payment Instructions ─────────────────────────────────────────────

/**
 * A value a payer needs to send money via Bank Transfer, alongside a
 * supplementary routing code where the vendor's banking system needs one.
 * `type` names what KIND of value this is -- it never names a payment
 * rail or provider. IBAN is its own variant (not a routing code) because
 * an IBAN replaces the account number rather than supplementing it: it
 * already encodes country/bank/branch/account in one string.
 */
export type RoutingCodeType =
  | "sort_code"          // UK, Ireland
  | "routing_number"     // US (ABA)
  | "transit_number"     // Canada
  | "institution_number" // Canada (paired with transit_number)
  | "bsb"                // Australia
  | "ifsc"               // India
  | "swift_bic";         // international wire routing, pairs with an account_number for any country

export interface RoutingCode {
  type: RoutingCodeType;
  value: string;
}

export type BankAccountIdentifier =
  | {
      type: "account_number";
      value: string;
      routing?: RoutingCode[];
    }
  | {
      type: "iban";
      value: string;
      swiftBic?: string;
    };

/**
 * A contact value a payer sends money to directly (e.g. a real-time
 * email/phone-linked transfer). Deliberately makes no claim about which
 * provider or network moves the money -- Platform names no rail here.
 */
export type ContactIdentifier =
  | { type: "email"; value: string }
  | { type: "phone"; value: string }; // E.164

/**
 * vendors/{vendorId}/paymentInstructions/{recordId} — a vendor's payment
 * configuration at a point in time (Batch 2B: Bank Transfer + Contact
 * Transfer + Accept Cash, worldwide). Immutable once created: a change
 * always creates a brand-new document (auto-generated id) carrying the
 * next monotonic version, and never edits a prior record's fields in
 * place -- there is no isActive/supersededAt mutation of history. Identity
 * (recordId, the document's own auto-generated id) and ordering (version,
 * a separate monotonic integer) are deliberately independent; nothing in
 * this codebase requires the document id to equal the version number.
 * Written only by a Cloud Function (setVendorPaymentInstructions); read
 * only by the vendor owner at the Firestore-rules layer — admin access is
 * a separate audited callable in a later batch, never a raw rules-level
 * grant, so a full identifier value is never handed to any admin client
 * without an audit trail.
 */
export interface PaymentInstructionRecord {
  recordId: string;
  vendorId: string;
  version: number;
  acceptCash: boolean;
  /**
   * null is the sole "no structured destination configured" representation
   * -- no separate enabled flag, so a disabled record can never be
   * ambiguous about whether its (absent) fields are live or stale.
   */
  paymentDestination: PaymentDestination | null;
  createdAt: firestore.Timestamp | firestore.FieldValue;
  createdByUid: string;
}

/**
 * Bank Transfer: country/currency-generic, worldwide. countryCode/
 * currencyCode are always server-derived at write time from the vendor's
 * own resolved country (see vendors/vendorCurrency.ts's
 * resolveVendorCountryCode/resolveVendorCurrency) -- never accepted as
 * client input. institutionName/recipientName are bounded free text and
 * are never validated against any institution registry (none exists in
 * this repository, and none is planned for this batch).
 */
export interface BankTransferDestination {
  type: "bank_transfer";
  countryCode: string;
  currencyCode: string;
  institutionName: string;
  recipientName: string;
  identifier: BankAccountIdentifier;
}

/**
 * Contact Transfer: a recipient identified by email or phone, with no
 * institution field (inapplicable -- see the type's own doc comment
 * above) and no provider/rail name.
 */
export interface ContactTransferDestination {
  type: "contact_transfer";
  countryCode: string;
  currencyCode: string;
  recipientName: string;
  identifier: ContactIdentifier;
}

export type PaymentDestination = BankTransferDestination | ContactTransferDestination;

/**
 * vendors/{vendorId}/paymentInstructionsCurrent/current — a mutable,
 * server-maintained pointer/cache reflecting the vendor's latest Payment
 * Instructions state, for an O(1) read without querying the immutable
 * history collection above. Deliberately NOT itself claimed immutable --
 * it is overwritten in place on every genuine change. The historical
 * record it points to (currentRecordId) never changes after creation.
 */
export interface PaymentInstructionsCurrentDoc {
  currentRecordId: string;
  currentVersion: number;
  acceptCash: boolean;
  paymentDestination: PaymentInstructionRecord["paymentDestination"];
  updatedAt: firestore.Timestamp | firestore.FieldValue;
}

/**
 * vendors/{vendorId}/paymentInstructionsIdempotency/{sanitizedKey} —
 * internal replay-detection state for setVendorPaymentInstructions,
 * modeled on payments/paymentLedger.ts's recordPayment idempotency
 * convention: a deterministic document id derived from the caller's own
 * idempotency key, so a retry finds the same document instead of creating
 * a second one. Fully internal -- no client, including the vendor owner,
 * ever reads or writes this collection directly.
 */
export interface PaymentInstructionsIdempotencyRecord {
  idempotencyKey: string;
  recordId: string;
  version: number;
  changed: boolean;
  payloadHash: string;
  createdAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── Confirmed Direct Payments ───────────────────────────────────────────────

/**
 * The controlled source enum distinguishing how a ConfirmedDirectPayment
 * came into existence — never implies Platform verified or processed the
 * payment, only how the vendor's attestation of receipt was captured.
 */
export type ConfirmedDirectPaymentSource =
  | "bank_proof_vendor_confirmed"
  | "cash_vendor_confirmed"
  | "vendor_manual_record";

export type CustomerPaymentAcknowledgement = "pending" | "acknowledged" | "disputed";

/**
 * orders/{orderId}/confirmedDirectPayments/{paymentId} — the durable,
 * append-only record of a vendor's attested receipt. The only entity that
 * ever moves an order's payment summary (introduced in a later batch).
 * Immutable except for `customerAcknowledgement` (advisory only — never a
 * precondition for the record's validity) and the reversal-linkage fields,
 * which a correction populates by writing a NEW linked record, never by
 * editing this one in place.
 */
export interface ConfirmedDirectPayment {
  paymentId: string;
  orderId: string;
  vendorId: string;
  customerId: string;
  // null for a manual/no-request record — never inferred/auto-allocated
  // to an existing PaymentRequest (see the unallocated-payment product
  // clarification).
  requestId: string | null;
  method: DirectPaymentMethod;
  source: ConfirmedDirectPaymentSource;
  amount: number;
  currency: string;
  confirmedByUid: string;
  confirmedAt: firestore.Timestamp | firestore.FieldValue;
  customerAcknowledgement: CustomerPaymentAcknowledgement;
  reversalOf?: string | null;
  reversedBy?: string | null;
}

// ─── Refunds ──────────────────────────────────────────────────────────────────

export type RefundType = "full" | "partial";
export type RefundCustomerConfirmation = "pending" | "received" | "not_received";

/**
 * orders/{orderId}/refunds/{refundId} — a vendor's attestation that they
 * sent money back to the customer directly. Platform does not process
 * refunds; this is a record of what the vendor says happened, never
 * labeled "processed".
 */
export interface Refund {
  refundId: string;
  orderId: string;
  vendorId: string;
  customerId: string;
  amount: number;
  currency: string;
  method: DirectPaymentMethod;
  reason: string;
  evidenceRef?: string | null;
  relatedPaymentIds: string[];
  type: RefundType;
  attestedAt: firestore.Timestamp | firestore.FieldValue;
  attestedByUid: string;
  customerConfirmation: RefundCustomerConfirmation;
}

// ─── Payment Disputes ─────────────────────────────────────────────────────────

export type PaymentDisputeCategory = "payment" | "refund";

export type PaymentDisputeReasonCode =
  | "PAID_VENDOR_SAYS_NOT_RECEIVED"
  | "PAID_TO_PREVIOUS_INSTRUCTIONS"
  | "PAYMENT_AMOUNT_DISAGREEMENT"
  | "VENDOR_RECORDED_PAYMENT_I_DID_NOT_MAKE"
  | "SUSPICIOUS_PAYMENT_DETAILS"
  | "PROOF_REJECTED_DISPUTE"
  | "REFUND_NOT_RECEIVED"
  | "REFUND_AMOUNT_INCORRECT"
  | "PARTIAL_REFUND_DISAGREEMENT"
  | "OTHER";

export type PaymentDisputeStatus = "open" | "under_review" | "resolved" | "closed";

/**
 * paymentDisputes/{disputeId} — top-level (not nested under the order) for
 * cross-order admin querying, with orderId carried as a field. Admin-only
 * at the Firestore-rules layer in this batch (matching the existing
 * auditLogs/moderationEvents convention) — participant-safe projected
 * access is a dedicated callable introduced in the later Disputes batch,
 * not a rules-level grant, so one party's private evidence and any
 * internal admin resolution note are never exposed to the other party or
 * readable wholesale by a client.
 */
export interface PaymentDispute {
  disputeId: string;
  orderId: string;
  vendorId: string;
  customerId: string;
  raisedByUid: string;
  raisedByRole: "customer" | "vendor";
  category: PaymentDisputeCategory;
  reasonCode: PaymentDisputeReasonCode;
  freeTextDetail?: string | null;
  evidenceRefs?: string[];
  linkedPaymentRequestId?: string | null;
  linkedConfirmedPaymentId?: string | null;
  linkedRefundId?: string | null;
  status: PaymentDisputeStatus;
  resolutionNote?: string | null;
  resolvedByUid?: string | null;
  resolvedAt?: firestore.Timestamp | firestore.FieldValue | null;
  createdAt: firestore.Timestamp | firestore.FieldValue;
}

// ─── Payment Instruction Change Events ─────────────────────────────────────────

export type PaymentInstructionChangeRiskLevel = "normal" | "elevated";

/**
 * paymentInstructionChangeEvents/{eventId} — audit trail for every bank-
 * detail change, masked (last 4 digits only, never the full account
 * number). Readable only by the vendor whose event it is and by admin —
 * never by a customer, who has no legitimate reason to see a vendor's own
 * security history. `vendorId` here is only ever set by a Cloud Function
 * (create/update/delete are all denied at the rules layer), so comparing
 * it against the caller's own `tokenVendorId()` custom claim at read time
 * cannot be spoofed by a client-supplied field.
 */
export interface PaymentInstructionChangeEvent {
  eventId: string;
  vendorId: string;
  actorUid: string;
  changedAt: firestore.Timestamp | firestore.FieldValue;
  previousRecordId: string | null;
  newRecordId: string;
  riskLevel: PaymentInstructionChangeRiskLevel;
  /**
   * Identifier-neutral: the masked form of whatever identifier the old/new
   * state carried (account number, IBAN, email, or phone), never the raw
   * value. null when that state had no destination configured (disabled
   * or cash-only). Routing codes/SWIFT-BIC are never included here at all
   * -- see paymentInstructions/maskPaymentIdentifier.ts.
   */
  maskedIdentifierOld: string | null;
  maskedIdentifierNew: string | null;
}
