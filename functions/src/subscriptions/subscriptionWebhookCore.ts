import { logger } from "firebase-functions/v2";
import { db, FieldValue, Timestamp } from "../admin";
import { SubscriptionPlanId, SubscriptionProvider, VendorSubscriptionDoc } from "../types4";
import { NORMALIZED_EVENT_PRIORITY, NormalizedEventType } from "./eventPriority";
import { acquireSubscriptionLock, releaseSubscriptionLock, LockContentionError } from "./subscriptionLock";
import { logOperationalEvent } from "../utils/operationalLogging";

const STALE_WEBHOOK_MS = 24 * 60 * 60 * 1000;
const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const VALID_PLAN_IDS: SubscriptionPlanId[] = ["basic", "standard", "pro", "pro_plus"];

/**
 * The provider-agnostic normalized shape every webhook handler converges
 * on (Provider Abstraction Contract, PHASE_4_COLLECTION_MAPPING v10
 * Section 9). Each provider's webhook file (paystackWebhook.ts,
 * flutterwaveWebhook.ts, stripeWebhook.ts) is responsible ONLY for:
 * verifying that provider's signature scheme, and mapping that provider's
 * raw payload into this shape. Everything after that — staleness
 * rejection, idempotency, distributed locking, out-of-order/priority
 * resolution, the actual vendorSubscriptions mutation, and the
 * subscriptionEvents audit write — is identical across every provider and
 * lives here exactly once. Adding a fourth provider means writing a new
 * signature check and a new field mapping, never touching this file.
 */
export interface NormalizedWebhookEvent {
  provider: SubscriptionProvider;
  providerEventId: string;
  vendorId: string | null;
  rawEventType: string;
  normalizedEventType: NormalizedEventType;
  eventTimestampMs: number;
  planIdFromPayload: SubscriptionPlanId | null;
  providerSubscriptionId?: string;
  providerCustomerId?: string;
  providerPlanId?: string;
  /** Already converted to the major currency unit (e.g. naira, not kobo). */
  amountPaid?: number;
  currency?: string;
}

export interface WebhookResult {
  httpStatus: number;
  message: string;
}

async function writeIgnoredEvent(params: {
  provider: SubscriptionProvider;
  vendorId: string | null;
  providerEventId: string;
  rawEventType: string;
  normalizedEventType: string;
  ignoreReason: string;
}): Promise<void> {
  const now = FieldValue.serverTimestamp();
  await db.collection("subscriptionEvents").add({
    eventId: db.collection("subscriptionEvents").doc().id,
    vendorId: params.vendorId,
    provider: params.provider,
    providerEventId: params.providerEventId,
    normalizedEventType: params.normalizedEventType,
    rawEventType: params.rawEventType,
    plan: "unknown",
    status: "unknown",
    idempotencyKey: params.providerEventId,
    wasIgnored: true,
    ignoreReason: params.ignoreReason,
    createdAt: now,
    updatedAt: now,
    processedAt: now,
  });
}

/**
 * processNormalizedWebhookEvent — the single implementation of every rule
 * in Section 5.2/12 of the spec: signature verification happens before
 * this is ever called (in the provider-specific file, before any
 * Firestore access), then in order: staleness, missing-vendorId,
 * unknown-event-type, idempotency, distributed lock, out-of-order/
 * priority resolution, admin-override check, the mutation itself, and the
 * audit log write. Returns an HTTP status/message for the caller to send
 * — this function never touches `res` directly, so it stays provider-
 * agnostic and unit-testable independent of any HTTP framework.
 */
export async function processNormalizedWebhookEvent(event: NormalizedWebhookEvent): Promise<WebhookResult> {
  const { provider, providerEventId, vendorId, rawEventType, normalizedEventType, eventTimestampMs } = event;

  // Stale webhook rejection (replay protection) — before any Firestore access
  // beyond this ignored-event write, which is itself audit bookkeeping, not
  // a subscription mutation.
  if (Date.now() - eventTimestampMs > STALE_WEBHOOK_MS) {
    await writeIgnoredEvent({
      provider, vendorId, providerEventId, rawEventType,
      normalizedEventType: "ignored", ignoreReason: "stale_webhook_rejected",
    });
    return { httpStatus: 200, message: "Stale webhook logged and ignored" };
  }

  // Missing vendorId — reject with logged error, never infer.
  if (!vendorId) {
    await writeIgnoredEvent({
      provider, vendorId: null, providerEventId, rawEventType,
      normalizedEventType: "ignored", ignoreReason: "missing_vendor_id",
    });
    return { httpStatus: 200, message: "Missing vendorId logged and ignored" };
  }

  // Unknown provider event — log as ignored, no status change.
  if (normalizedEventType === "ignored") {
    await writeIgnoredEvent({
      provider, vendorId, providerEventId, rawEventType,
      normalizedEventType: "ignored", ignoreReason: "unknown_provider_event_type",
    });
    return { httpStatus: 200, message: "Unknown event type logged and ignored" };
  }

  // Idempotency — same providerEventId already processed. Idempotency keys
  // are provider-scoped by construction (each provider's event IDs live in
  // their own namespace, e.g. Paystack numeric IDs vs Stripe's evt_...
  // strings), so no cross-provider collision risk even though this is a
  // single shared collection.
  const existingEventSnap = await db.collection("subscriptionEvents")
    .where("idempotencyKey", "==", providerEventId).limit(1).get();
  if (!existingEventSnap.empty) {
    return { httpStatus: 200, message: "Duplicate event, already processed" };
  }

  // Acquire distributed lock — webhook callers get 409, never retry internally.
  try {
    await acquireSubscriptionLock(vendorId, `webhook:${provider}:${providerEventId}`);
  } catch (err) {
    if (err instanceof LockContentionError) {
      return { httpStatus: 409, message: "Subscription mid-update, provider should retry" };
    }
    throw err;
  }

  try {
    const subRef = db.collection("vendorSubscriptions").doc(vendorId);

    await db.runTransaction(async (tx) => {
      const subSnap = await tx.get(subRef);
      const existing = subSnap.exists ? (subSnap.data() as VendorSubscriptionDoc) : null;

      // A genuinely NEW subscription cycle (a different provider
      // subscription ID than what's on file — including a vendor migrating
      // from one provider to another, or resubscribing after cancelling)
      // always resets priority tracking rather than being compared against
      // it. Without this, a cancellation (priority 100, the highest in the
      // table) would permanently block every future activation webhook
      // from ever being accepted again, regardless of which provider sends
      // it — a real bug caught by the Paystack-only acceptance tests
      // before this was generalized to all providers.
      const isNewSubscriptionCycle =
        normalizedEventType === "activation" &&
        !!event.providerSubscriptionId &&
        event.providerSubscriptionId !== existing?.providerSubscriptionId;

      const incomingPriority = NORMALIZED_EVENT_PRIORITY[normalizedEventType];
      const incomingSequence = eventTimestampMs;
      if (existing && !isNewSubscriptionCycle) {
        const lastPriority = existing.lastEventPriority ?? 0;
        const lastSequence = existing.lastEventSequence ?? 0;
        const supersededByHigherPriority = incomingPriority < lastPriority;
        const supersededByTie = incomingPriority === lastPriority && incomingSequence <= lastSequence;
        if (supersededByHigherPriority || supersededByTie) {
          await writeIgnoredEvent({
            provider, vendorId, providerEventId, rawEventType, normalizedEventType,
            ignoreReason: "superseded_by_newer_or_higher_priority_event",
          });
          return;
        }
      }

      // Admin override active — log but never mutate plan/status.
      const overrideExpiresAt = existing?.adminOverrideExpiresAt;
      if (overrideExpiresAt && "toMillis" in overrideExpiresAt && overrideExpiresAt.toMillis() > Date.now()) {
        await writeIgnoredEvent({
          provider, vendorId, providerEventId, rawEventType, normalizedEventType,
          ignoreReason: "admin_override_active",
        });
        return;
      }

      const now = FieldValue.serverTimestamp();
      const planFromPayload = event.planIdFromPayload && VALID_PLAN_IDS.includes(event.planIdFromPayload)
        ? event.planIdFromPayload
        : existing?.plan ?? "basic";

      const updates: Record<string, unknown> = {
        vendorId,
        provider,
        lastEventType: normalizedEventType,
        lastEventAt: now,
        lastEventSequence: incomingSequence,
        lastEventPriority: incomingPriority,
        version: FieldValue.increment(1),
        updatedAt: now,
      };

      if (normalizedEventType === "activation" || normalizedEventType === "renewal") {
        // Late-payment-after-expiry (EC2/v7 simplified): any signature-
        // verified activation/renewal webhook restores an expired
        // subscription to active, regardless of provider. A full
        // re-verification against the provider's own subscription-status
        // API (the stricter v7 behavior) is intentionally deferred for all
        // three providers — see README known-gaps.
        updates.status = "active";
        updates.plan = planFromPayload;
        updates.gracePeriodEnd = null;
        updates.gracePeriodSetAt = null;
        if (event.providerSubscriptionId) updates.providerSubscriptionId = event.providerSubscriptionId;
        if (event.providerCustomerId) updates.providerCustomerId = event.providerCustomerId;
        if (event.providerPlanId) updates.providerPlanId = event.providerPlanId;
        if (typeof event.amountPaid === "number") updates.amountPaid = event.amountPaid;
        updates.currency = event.currency ?? existing?.currency ?? "NGN";
        const periodStart = Timestamp.now();
        const periodEnd = Timestamp.fromMillis(periodStart.toMillis() + 30 * 24 * 60 * 60 * 1000);
        updates.currentPeriodStart = periodStart;
        updates.currentPeriodEnd = periodEnd;
        updates.cancelAtPeriodEnd = false;
        updates.cancelledAt = null;
        // Upgrade before period end clears a pending downgrade (EC4).
        if (existing?.pendingDowngradePlan && planFromPayload !== existing.plan) {
          updates.pendingDowngradePlan = null;
          updates.pendingDowngradeAt = null;
        }
      } else if (normalizedEventType === "past_due") {
        updates.status = "past_due";
        // EC3: duplicate failed-payment webhooks must not extend the grace
        // period — only set it the FIRST time this billing cycle fails.
        if (!existing?.gracePeriodSetAt) {
          updates.gracePeriodEnd = Timestamp.fromMillis(Date.now() + GRACE_PERIOD_MS);
          updates.gracePeriodSetAt = now;
        }
      } else if (normalizedEventType === "cancelled") {
        // A PROVIDER-side cancellation is distinct from a vendor-initiated
        // soft cancel via the cancelSubscription callable, which
        // deliberately leaves status "active" until period end. A
        // webhook-driven cancellation sets status to "cancelled" outright
        // (Section 4.1, priority order item 5).
        updates.status = "cancelled";
        updates.cancelAtPeriodEnd = true;
        updates.cancelledAt = now;
      }

      if (!subSnap.exists) {
        tx.set(subRef, {
          ...updates,
          providerSubscriptionId: updates.providerSubscriptionId ?? event.providerSubscriptionId ?? "",
          providerCustomerId: updates.providerCustomerId ?? event.providerCustomerId ?? "",
          providerPlanId: updates.providerPlanId ?? event.providerPlanId ?? "",
          plan: updates.plan ?? "basic",
          status: updates.status ?? "incomplete",
          currency: updates.currency ?? "NGN",
          amountPaid: updates.amountPaid ?? 0,
          billingInterval: "monthly",
          currentPeriodStart: updates.currentPeriodStart ?? now,
          currentPeriodEnd: updates.currentPeriodEnd ?? now,
          cancelAtPeriodEnd: updates.cancelAtPeriodEnd ?? false,
          version: 1,
          createdAt: now,
        });
      } else {
        tx.update(subRef, updates);
      }

      const eventRef = db.collection("subscriptionEvents").doc();
      tx.set(eventRef, {
        eventId: eventRef.id,
        vendorId,
        provider,
        providerEventId,
        normalizedEventType,
        rawEventType,
        plan: updates.plan ?? existing?.plan ?? "basic",
        previousPlan: existing?.plan ?? null,
        status: updates.status ?? existing?.status ?? "unknown",
        effectiveFrom: now,
        amountPaid: updates.amountPaid ?? null,
        currency: updates.currency ?? null,
        idempotencyKey: providerEventId,
        wasIgnored: false,
        createdAt: now,
        updatedAt: now,
        processedAt: now,
      });
    });

    return { httpStatus: 200, message: "Processed" };
  } catch (err) {
    logger.error(err);
    logOperationalEvent({
      functionName: `handle${provider[0].toUpperCase()}${provider.slice(1)}Webhook`,
      event: "unhandled_error",
      severity: "ERROR",
      metadata: { vendorId, providerEventId, errorMessage: err instanceof Error ? err.message : String(err) },
    });
    // No partial state was written (the mutation is a single transaction) —
    // 500 signals the provider to retry per its own standard schedule.
    return { httpStatus: 500, message: "Processing failed, retry expected" };
  } finally {
    await releaseSubscriptionLock(vendorId);
  }
}
