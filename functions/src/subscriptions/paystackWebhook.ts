import * as crypto from "crypto";
import { https, logger } from "firebase-functions/v2";
import { db, FieldValue, Timestamp } from "../admin";
import { VendorSubscriptionDoc, SubscriptionPlanId } from "../types4";
import { normalizeRawEventType, NORMALIZED_EVENT_PRIORITY } from "./eventPriority";
import { acquireSubscriptionLock, releaseSubscriptionLock, LockContentionError } from "./subscriptionLock";
import { logOperationalEvent } from "../utils/operationalLogging";

const STALE_WEBHOOK_MS = 24 * 60 * 60 * 1000;
const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const VALID_PLAN_IDS: SubscriptionPlanId[] = ["basic", "standard", "pro", "pro_plus"];

function getPaystackSecret(): string {
  // Emulator fallback keeps local acceptance tests self-contained without a
  // real Paystack account, matching the FUNCTIONS_EMULATOR pattern already
  // used for SMS OTP (auth/phoneOtp.ts).
  return process.env.PAYSTACK_SECRET_KEY ?? (process.env.FUNCTIONS_EMULATOR === "true" ? "emulator_test_secret" : "");
}

function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  const secret = getPaystackSecret();
  if (!secret) return false;
  const expected = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  // Constant-time comparison — a naive === here would leak timing
  // information about how many leading bytes matched, letting an attacker
  // incrementally brute-force a valid signature.
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(signatureHeader, "hex");
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

async function writeIgnoredEvent(params: {
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
    provider: "paystack",
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
 * handlePaystackWebhook (Phase 4, Section 5.2).
 *
 * HTTPS endpoint, not a callable — Paystack posts directly to this URL.
 * Every check below runs in the exact order the spec requires: signature
 * verification before ANY Firestore access, then staleness, then the
 * distributed lock, then idempotency, then out-of-order protection, then
 * the actual mutation.
 */
export const handlePaystackWebhook = https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  // 1. Signature verification before any Firestore access.
  const signature = req.headers["x-paystack-signature"] as string | undefined;
  const rawBody: Buffer = (req as unknown as { rawBody: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
  if (!verifySignature(rawBody, signature)) {
    res.status(401).send("Invalid signature");
    return;
  }

  const body = req.body ?? {};
  const rawEventType: string = body.event ?? "";
  const providerEventId: string = body.data?.id != null ? String(body.data.id) : (req.headers["x-paystack-request-id"] as string) ?? "";
  const vendorId: string | null = body.data?.metadata?.vendorId ?? null;
  const eventTimestampMs: number = body.data?.created_at ? new Date(body.data.created_at).getTime() : Date.now();

  if (!providerEventId) {
    res.status(400).send("Missing event id");
    return;
  }

  // 2. Stale webhook rejection (replay protection) — before any Firestore access.
  if (Date.now() - eventTimestampMs > STALE_WEBHOOK_MS) {
    await writeIgnoredEvent({
      vendorId, providerEventId, rawEventType,
      normalizedEventType: "ignored", ignoreReason: "stale_webhook_rejected",
    });
    res.status(200).send("Stale webhook logged and ignored");
    return;
  }

  // 3. Missing vendorId — reject with logged error, never infer.
  if (!vendorId) {
    await writeIgnoredEvent({
      vendorId: null, providerEventId, rawEventType,
      normalizedEventType: "ignored", ignoreReason: "missing_vendor_id",
    });
    res.status(200).send("Missing vendorId logged and ignored");
    return;
  }

  const { normalizedEventType, targetStatus } = normalizeRawEventType(rawEventType);

  // 4. Unknown provider event — log as ignored, no status change.
  if (normalizedEventType === "ignored") {
    await writeIgnoredEvent({
      vendorId, providerEventId, rawEventType,
      normalizedEventType: "ignored", ignoreReason: "unknown_provider_event_type",
    });
    res.status(200).send("Unknown event type logged and ignored");
    return;
  }

  // 5. Idempotency — same providerEventId already processed.
  const existingEventSnap = await db.collection("subscriptionEvents")
    .where("idempotencyKey", "==", providerEventId).limit(1).get();
  if (!existingEventSnap.empty) {
    res.status(200).send("Duplicate event, already processed");
    return;
  }

  // 6. Acquire distributed lock — webhook callers get 409, never retry internally.
  try {
    await acquireSubscriptionLock(vendorId, `webhook:${providerEventId}`);
  } catch (err) {
    if (err instanceof LockContentionError) {
      res.status(409).send("Subscription mid-update, Paystack should retry");
      return;
    }
    throw err;
  }

  try {
    const subRef = db.collection("vendorSubscriptions").doc(vendorId);

    await db.runTransaction(async (tx) => {
      const subSnap = await tx.get(subRef);
      const existing = subSnap.exists ? (subSnap.data() as VendorSubscriptionDoc) : null;

      // A genuinely NEW subscription cycle (a different Paystack
      // subscription_code than what's on file) always resets priority
      // tracking rather than being compared against it. Without this, a
      // vendor who cancelled (priority 100, the highest in the table)
      // could never resubscribe: every future "activation" webhook
      // (priority 40) would look like a lower-priority event trying to
      // overwrite a higher-priority one and get permanently rejected. The
      // guard exists to resolve REORDERING within one subscription's
      // lifecycle, not to ratchet forever across separate subscriptions.
      const incomingSubscriptionCode: string | undefined = body.data?.subscription_code;
      const isNewSubscriptionCycle =
        normalizedEventType === "activation" &&
        !!incomingSubscriptionCode &&
        incomingSubscriptionCode !== existing?.providerSubscriptionId;

      // Out-of-order protection: an event only applies if its priority is
      // higher than the last-applied event's priority, OR equal priority
      // with a later sequence number (tie broken by recency).
      const incomingPriority = NORMALIZED_EVENT_PRIORITY[normalizedEventType];
      const incomingSequence = eventTimestampMs;
      if (existing && !isNewSubscriptionCycle) {
        const lastPriority = existing.lastEventPriority ?? 0;
        const lastSequence = existing.lastEventSequence ?? 0;
        const supersededByHigherPriority = incomingPriority < lastPriority;
        const supersededByTie = incomingPriority === lastPriority && incomingSequence <= lastSequence;
        if (supersededByHigherPriority || supersededByTie) {
          await writeIgnoredEvent({
            vendorId, providerEventId, rawEventType, normalizedEventType,
            ignoreReason: "superseded_by_newer_or_higher_priority_event",
          });
          return;
        }
      }

      // Admin override active — log but never mutate plan/status.
      const overrideExpiresAt = existing?.adminOverrideExpiresAt;
      if (overrideExpiresAt && "toMillis" in overrideExpiresAt && overrideExpiresAt.toMillis() > Date.now()) {
        await writeIgnoredEvent({
          vendorId, providerEventId, rawEventType, normalizedEventType,
          ignoreReason: "admin_override_active",
        });
        return;
      }

      const now = FieldValue.serverTimestamp();
      const planFromPayload = VALID_PLAN_IDS.includes(body.data?.plan?.plan_code_metadata?.planId)
        ? body.data.plan.plan_code_metadata.planId
        : existing?.plan ?? "basic";

      const updates: Record<string, unknown> = {
        vendorId,
        provider: "paystack",
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
        // subscription to active. A full re-verification against
        // Paystack's own subscription-status API (the stricter v7
        // behavior) is intentionally deferred — see README known-gaps.
        updates.status = "active";
        updates.plan = planFromPayload;
        updates.gracePeriodEnd = null;
        updates.gracePeriodSetAt = null;
        if (body.data?.subscription_code) updates.providerSubscriptionId = body.data.subscription_code;
        if (body.data?.customer?.customer_code) updates.providerCustomerId = body.data.customer.customer_code;
        if (body.data?.plan?.plan_code) updates.providerPlanId = body.data.plan.plan_code;
        if (typeof body.data?.amount === "number") updates.amountPaid = body.data.amount / 100;
        updates.currency = body.data?.currency ?? existing?.currency ?? "NGN";
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
        // A PROVIDER-side cancellation (Paystack itself reports the
        // subscription as not-renewing/disabled) is distinct from a
        // vendor-initiated soft cancel via the cancelSubscription callable,
        // which deliberately leaves status "active" until period end so
        // resolveEffectivePlan's "active" branch keeps serving full plan
        // limits. A webhook-driven cancellation sets status to "cancelled"
        // outright, which is what makes resolveEffectivePlan's dedicated
        // "cancelled && before currentPeriodEnd" priority branch reachable
        // at all (Section 4.1, priority order item 5).
        updates.status = "cancelled";
        updates.cancelAtPeriodEnd = true;
        updates.cancelledAt = now;
      }

      if (!subSnap.exists) {
        tx.set(subRef, {
          ...updates,
          providerSubscriptionId: updates.providerSubscriptionId ?? body.data?.subscription_code ?? "",
          providerCustomerId: updates.providerCustomerId ?? body.data?.customer?.customer_code ?? "",
          providerPlanId: updates.providerPlanId ?? body.data?.plan?.plan_code ?? "",
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
        provider: "paystack",
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

    res.status(200).send("Processed");
  } catch (err) {
    logger.error(err);
    logOperationalEvent({
      functionName: "handlePaystackWebhook",
      event: "unhandled_error",
      severity: "ERROR",
      metadata: { vendorId, providerEventId, errorMessage: err instanceof Error ? err.message : String(err) },
    });
    // No partial state was written (the mutation is a single transaction) —
    // 500 signals Paystack to retry per its standard schedule.
    res.status(500).send("Processing failed, retry expected");
  } finally {
    await releaseSubscriptionLock(vendorId);
  }
});
