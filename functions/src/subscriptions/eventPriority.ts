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

/**
 * Apple App Store Server Notifications V2 raw event mapping.
 * https://developer.apple.com/documentation/appstoreservernotifications/notificationtype
 *
 * DID_CHANGE_RENEWAL_STATUS only means the auto-renew toggle changed, not a
 * status change by itself -- subtype AUTO_RENEW_DISABLED is treated as
 * informational here (ignored) rather than cancelled, since the
 * subscription is still active until it actually expires; EXPIRED is what
 * the subscriptionWebhookCore transition to "cancelled" is keyed off.
 * PRICE_INCREASE and CONSUMPTION_REQUEST are informational only and never
 * change vendorSubscriptions state.
 */
const APPLE_RAW_TO_NORMALIZED: Record<string, (subtype: string | undefined) => NormalizedEvent> = {
  SUBSCRIBED: () => ({ normalizedEventType: "activation", targetStatus: "active" }),
  DID_RENEW: () => ({ normalizedEventType: "renewal", targetStatus: "active" }),
  DID_FAIL_TO_RENEW: () => ({ normalizedEventType: "past_due", targetStatus: "past_due" }),
  GRACE_PERIOD_EXPIRED: () => ({ normalizedEventType: "past_due", targetStatus: "past_due" }),
  EXPIRED: () => ({ normalizedEventType: "cancelled", targetStatus: "cancelled" }),
  // REVOKE is Family Sharing access being withdrawn (the subscriber's
  // household member loses it, not the purchaser). REFUND is Apple actually
  // returning the purchaser's money -- a distinct notification type from
  // REVOKE, easy to conflate since both end access, and originally missing
  // here entirely. Both end access the same way a provider-side cancellation
  // does.
  REVOKE: () => ({ normalizedEventType: "cancelled", targetStatus: "cancelled" }),
  REFUND: () => ({ normalizedEventType: "cancelled", targetStatus: "cancelled" }),
  DID_CHANGE_RENEWAL_PREF: (subtype) =>
    subtype === "DOWNGRADE" || subtype === "UPGRADE"
      ? { normalizedEventType: "plan_change", targetStatus: "active" }
      : { normalizedEventType: "ignored", targetStatus: null },
};

export function normalizeAppleEventType(rawEventType: string, subtype: string | undefined): NormalizedEvent {
  const mapper = APPLE_RAW_TO_NORMALIZED[rawEventType];
  return mapper ? mapper(subtype) : { normalizedEventType: "ignored", targetStatus: null };
}

/**
 * Google Play Real-time Developer Notifications, subscriptionNotification.
 * notificationType (numeric, per Google's own published enum --
 * https://developer.android.com/google/play/billing/rtdn-reference).
 *
 * Not independently verified against a live source the way the Apple enum
 * was (no official Node client library exports these as named constants the
 * way @apple/app-store-server-library does) -- these are Google's long-
 * documented, stable values. Sanity-check against a real notification once
 * Play Console access exists, same spirit as everything else in this file
 * marked SCAFFOLD pending real credentials.
 */
export const GOOGLE_NOTIFICATION_TYPE = {
  SUBSCRIPTION_RECOVERED: 1,
  SUBSCRIPTION_RENEWED: 2,
  SUBSCRIPTION_CANCELED: 3,
  SUBSCRIPTION_PURCHASED: 4,
  SUBSCRIPTION_ON_HOLD: 5,
  SUBSCRIPTION_IN_GRACE_PERIOD: 6,
  SUBSCRIPTION_RESTARTED: 7,
  SUBSCRIPTION_PRICE_CHANGE_CONFIRMED: 8,
  SUBSCRIPTION_DEFERRED: 9,
  SUBSCRIPTION_PAUSED: 10,
  SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED: 11,
  SUBSCRIPTION_REVOKED: 12,
  SUBSCRIPTION_EXPIRED: 13,
} as const;

const GOOGLE_RAW_TO_NORMALIZED: Record<number, NormalizedEvent> = {
  [GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_PURCHASED]: { normalizedEventType: "activation", targetStatus: "active" },
  [GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_RENEWED]: { normalizedEventType: "renewal", targetStatus: "active" },
  [GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_RECOVERED]: { normalizedEventType: "renewal", targetStatus: "active" },
  [GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_RESTARTED]: { normalizedEventType: "renewal", targetStatus: "active" },
  [GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_IN_GRACE_PERIOD]: { normalizedEventType: "past_due", targetStatus: "past_due" },
  [GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_ON_HOLD]: { normalizedEventType: "past_due", targetStatus: "past_due" },
  // SUBSCRIPTION_CANCELED means auto-renew was turned off -- the vendor
  // keeps access until the current period actually ends (SUBSCRIPTION_
  // EXPIRED), the same distinction Apple's DID_CHANGE_RENEWAL_STATUS needs.
  // Deliberately not mapped here: ending access on this notification would
  // cut a vendor off while they're still inside a period they paid for.
  [GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_EXPIRED]: { normalizedEventType: "cancelled", targetStatus: "cancelled" },
  [GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_REVOKED]: { normalizedEventType: "cancelled", targetStatus: "cancelled" },
  [GOOGLE_NOTIFICATION_TYPE.SUBSCRIPTION_PAUSED]: { normalizedEventType: "cancelled", targetStatus: "cancelled" },
};

export function normalizeGoogleEventType(notificationType: number): NormalizedEvent {
  return GOOGLE_RAW_TO_NORMALIZED[notificationType] ?? { normalizedEventType: "ignored", targetStatus: null };
}
