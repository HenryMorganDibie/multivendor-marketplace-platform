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

const RAW_TO_NORMALIZED: Record<string, NormalizedEvent> = {
  "subscription.create": { normalizedEventType: "activation", targetStatus: "active" },
  "charge.success": { normalizedEventType: "activation", targetStatus: "active" },
  "invoice.payment_succeeded": { normalizedEventType: "renewal", targetStatus: "active" },
  "invoice.payment_failed": { normalizedEventType: "past_due", targetStatus: "past_due" },
  "subscription.not_renew": { normalizedEventType: "cancelled", targetStatus: "cancelled" },
  "subscription.disable": { normalizedEventType: "cancelled", targetStatus: "cancelled" },
  "subscription.expiring_cards": { normalizedEventType: "trial_ending", targetStatus: null },
};

export function normalizeRawEventType(rawEventType: string): NormalizedEvent {
  return RAW_TO_NORMALIZED[rawEventType] ?? { normalizedEventType: "ignored", targetStatus: null };
}
