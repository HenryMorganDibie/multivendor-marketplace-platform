/**
 * Event priority table (PHASE_4_COLLECTION_MAPPING v10, Section 12.2) and
 * raw-provider-event → normalized-event mapping.
 *
 * The source document gives the priority table verbatim but does not give
 * an exhaustive raw-Paystack-event-name → normalizedEventType mapping — it
 * references invoice.payment_succeeded / invoice.payment_failed in prose
 * (Section 4.1, "Late payment after expiry resolution"), which is what this
 * mapping treats as canonical. If Paystack's real webhook payloads use
 * different raw type strings in practice, only this one mapping table needs
 * updating — normalizeRawEventType() is the single seam everything else in
 * the webhook handler depends on.
 */

export type NormalizedEventType =
  | "activation"
  | "renewal"
  | "past_due"
  | "cancelled"
  | "suspended"
  | "plan_change"
  | "trial_ending"
  | "ignored";

export const NORMALIZED_EVENT_PRIORITY: Record<NormalizedEventType, number> = {
  cancelled: 100,
  suspended: 90,
  past_due: 50,
  renewal: 40,
  plan_change: 40,
  activation: 40,
  trial_ending: 10,
  ignored: 0,
};

export interface NormalizedEvent {
  normalizedEventType: NormalizedEventType;
  targetStatus: "active" | "past_due" | "cancelled" | "trialing" | null;
}

const PAYSTACK_RAW_TO_NORMALIZED: Record<string, NormalizedEvent> = {
  "subscription.create": { normalizedEventType: "activation", targetStatus: "active" },
  "charge.success": { normalizedEventType: "activation", targetStatus: "active" },
  "invoice.payment_succeeded": { normalizedEventType: "renewal", targetStatus: "active" },
  "invoice.payment_failed": { normalizedEventType: "past_due", targetStatus: "past_due" },
  "subscription.not_renew": { normalizedEventType: "cancelled", targetStatus: "cancelled" },
  "subscription.disable": { normalizedEventType: "cancelled", targetStatus: "cancelled" },
  "subscription.expiring_cards": { normalizedEventType: "trial_ending", targetStatus: null },
};

export function normalizeRawEventType(rawEventType: string): NormalizedEvent {
  return PAYSTACK_RAW_TO_NORMALIZED[rawEventType] ?? { normalizedEventType: "ignored", targetStatus: null };
}

/**
 * Flutterwave raw event mapping. Flutterwave's webhook vocabulary is
 * charge-centric rather than subscription-centric (its "Payment Plans"
 * product recurs a charge on a schedule and fires charge.completed each
 * time, rather than emitting distinct subscription lifecycle events the
 * way Paystack/Stripe do) — this mapping is a best-effort normalization
 * against Flutterwave's documented webhook shapes as of this writing and,
 * like the Paystack table above, is the single seam to update if real
 * production traffic uses different raw type strings or a charge status
 * this table doesn't yet cover.
 */
const FLUTTERWAVE_RAW_TO_NORMALIZED: Record<string, (chargeStatus: string | undefined) => NormalizedEvent> = {
  "charge.completed": (status) =>
    status === "successful"
      ? { normalizedEventType: "renewal", targetStatus: "active" }
      : { normalizedEventType: "past_due", targetStatus: "past_due" },
  "subscription.cancelled": () => ({ normalizedEventType: "cancelled", targetStatus: "cancelled" }),
};

export function normalizeFlutterwaveEventType(rawEventType: string, chargeStatus: string | undefined): NormalizedEvent {
  const mapper = FLUTTERWAVE_RAW_TO_NORMALIZED[rawEventType];
  return mapper ? mapper(chargeStatus) : { normalizedEventType: "ignored", targetStatus: null };
}

/**
 * Stripe raw event mapping. Stripe's `customer.subscription.created` fires
 * on the FIRST activation; subsequent renewals arrive as
 * `invoice.payment_succeeded` against that subscription, matching the same
 * activation/renewal split Paystack uses, which is why both providers
 * converge on the same `NormalizedEventType` values here.
 */
const STRIPE_RAW_TO_NORMALIZED: Record<string, NormalizedEvent> = {
  "customer.subscription.created": { normalizedEventType: "activation", targetStatus: "active" },
  "invoice.payment_succeeded": { normalizedEventType: "renewal", targetStatus: "active" },
  "invoice.payment_failed": { normalizedEventType: "past_due", targetStatus: "past_due" },
  "customer.subscription.deleted": { normalizedEventType: "cancelled", targetStatus: "cancelled" },
  "customer.subscription.trial_will_end": { normalizedEventType: "trial_ending", targetStatus: null },
};

export function normalizeStripeEventType(rawEventType: string): NormalizedEvent {
  return STRIPE_RAW_TO_NORMALIZED[rawEventType] ?? { normalizedEventType: "ignored", targetStatus: null };
}
