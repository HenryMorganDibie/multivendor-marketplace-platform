import { onSchedule } from "firebase-functions/v2/scheduler";
import { db, FieldValue, Timestamp } from "../admin";
import { VendorSubscriptionDoc } from "../types4";
import { withSubscriptionLock, LockContentionError } from "./subscriptionLock";
import { sendSubscriptionEmail, getVendorEmail } from "./subscriptionEmail";
import { logOperationalEvent } from "../utils/operationalLogging";
import { cancelProviderSubscription } from "./internationalCheckout";

async function processOneVendor(vendorId: string, mutate: (sub: VendorSubscriptionDoc, subRef: FirebaseFirestore.DocumentReference) => Promise<Record<string, unknown> | null>): Promise<void> {
  try {
    await withSubscriptionLock(vendorId, "expireStaleSubscriptions", async () => {
      const subRef = db.collection("vendorSubscriptions").doc(vendorId);
      const subSnap = await subRef.get();
      if (!subSnap.exists) return;
      const sub = subSnap.data() as VendorSubscriptionDoc;
      const updates = await mutate(sub, subRef);
      if (!updates) return;
      await subRef.update({
        ...updates,
        version: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (err) {
    if (err instanceof LockContentionError) {
      // Another process is already mutating this vendor right now — safe
      // to skip this run, the next scheduled run will pick it up if still
      // applicable, and no state is lost by deferring one cycle.
      return;
    }
    throw err;
  }
}

/**
 * expireStaleSubscriptions (Phase 4, Section 5.10). Scheduled daily.
 * Resolves cancellation-vs-pending-downgrade priority (Section 4.1) for
 * subscriptions whose currentPeriodEnd has passed, and expires past_due
 * subscriptions whose grace period has fully elapsed.
 */
export const expireStaleSubscriptions = onSchedule("every day 03:00", async () => {
  const now = Timestamp.now();

  // Group A: active/cancelled subscriptions whose billing period has ended.
  const periodEndedSnap = await db.collection("vendorSubscriptions")
    .where("status", "in", ["active", "cancelled"])
    .where("currentPeriodEnd", "<=", now)
    .get();

  for (const doc of periodEndedSnap.docs) {
    const vendorId = doc.id;
    let downgradeCheckoutRequired: string | null = null;

    await processOneVendor(vendorId, async (sub) => {
      if (sub.cancelAtPeriodEnd) {
        // Cancellation always wins over any pending downgrade (Section 4.1).
        return { status: "expired", plan: "basic", lastEventType: "scheduled.expired_cancelled" };
      }
      if (sub.pendingDowngradePlan) {
        // No provider here supports a silent re-charge at a new amount —
        // every checkout is a vendor-driven hosted-page redirect, nothing
        // is stored server-side to bill against later (approved direction,
        // 2026-08-27). So the safe transition is: stop the old (higher)
        // price from billing again now, and drop entitlement to Basic
        // rather than silently granting an unpaid mid-tier plan.
        if (
          (sub.provider === "paystack" || sub.provider === "flutterwave" || sub.provider === "stripe")
          && sub.providerSubscriptionId
        ) {
          await cancelProviderSubscription(sub.provider, sub.providerSubscriptionId);
        }
        // A downgrade TO basic is already fully resolved by dropping to
        // Basic above — nothing further to check out, so pendingDowngradePlan
        // is cleared like any other completed transition. A downgrade to a
        // paid tier still needs one checkout to activate it, so
        // pendingDowngradePlan is deliberately left set (pendingDowngradeAt
        // cleared) — getSubscriptionStatus keeps surfacing it, and the
        // portal reads reason:"expired" + a still-present pendingDowngrade
        // as "checkout needed to finish this downgrade," distinct from
        // reason:"active" + pendingDowngrade, which means it's still
        // counting down.
        const isDowngradeToBasic = sub.pendingDowngradePlan === "basic";
        if (!isDowngradeToBasic) downgradeCheckoutRequired = sub.pendingDowngradePlan;
        return {
          status: "expired",
          plan: "basic",
          pendingDowngradePlan: isDowngradeToBasic ? null : sub.pendingDowngradePlan,
          pendingDowngradeAt: null,
          lastEventType: "scheduled.downgrade_effective_checkout_required",
        };
      }
      // No cancellation and no pending downgrade, yet the period has
      // ended with no renewal webhook ever updating currentPeriodEnd —
      // fail closed rather than silently keep granting paid access.
      return { status: "expired", plan: "basic", lastEventType: "scheduled.expired_no_renewal" };
    });

    if (downgradeCheckoutRequired) {
      const email = await getVendorEmail(vendorId);
      if (email) await sendSubscriptionEmail(email, "downgrade_effective_checkout_required", { vendorId, plan: downgradeCheckoutRequired });
    }
  }

  // Group B: past_due subscriptions whose grace period has fully elapsed.
  const graceExpiredSnap = await db.collection("vendorSubscriptions")
    .where("status", "==", "past_due")
    .where("gracePeriodEnd", "<=", now)
    .get();

  for (const doc of graceExpiredSnap.docs) {
    const vendorId = doc.id;
    await processOneVendor(vendorId, async () => ({
      status: "expired", plan: "basic", lastEventType: "scheduled.expired_grace_period",
    }));
    const email = await getVendorEmail(vendorId);
    if (email) await sendSubscriptionEmail(email, "expired", { vendorId });
  }

  logOperationalEvent({
    functionName: "expireStaleSubscriptions",
    event: "scheduled_run_complete",
    severity: "WARNING",
    metadata: { periodEndedCount: periodEndedSnap.size, graceExpiredCount: graceExpiredSnap.size },
  });
});

/**
 * gracePeriodReminder (Phase 4, Section 5.11). Scheduled daily. Fires
 * exactly once per grace period, when gracePeriodEnd is within the next
 * 2 days — gracePeriodReminderSentAt is the dedup guard so a function
 * retry or a second run within the same day never double-sends.
 */
export const gracePeriodReminder = onSchedule("every day 09:00", async () => {
  const now = Date.now();
  const twoDaysFromNow = Timestamp.fromMillis(now + 2 * 24 * 60 * 60 * 1000);

  const snap = await db.collection("vendorSubscriptions")
    .where("status", "==", "past_due")
    .where("gracePeriodEnd", "<=", twoDaysFromNow)
    .get();

  let sentCount = 0;
  for (const doc of snap.docs) {
    const sub = doc.data() as VendorSubscriptionDoc;
    if (sub.gracePeriodReminderSentAt) continue;
    const gracePeriodEndMs = sub.gracePeriodEnd && "toMillis" in sub.gracePeriodEnd ? sub.gracePeriodEnd.toMillis() : 0;
    if (gracePeriodEndMs <= now) continue; // already expired, expireStaleSubscriptions handles this

    await doc.ref.update({ gracePeriodReminderSentAt: FieldValue.serverTimestamp() });
    const email = await getVendorEmail(doc.id);
    if (email) {
      await sendSubscriptionEmail(email, "grace_period_t_minus_2", { vendorId: doc.id });
      sentCount++;
    }
  }

  logOperationalEvent({
    functionName: "gracePeriodReminder",
    event: "scheduled_run_complete",
    severity: "WARNING",
    metadata: { candidateCount: snap.size, sentCount },
  });
});
