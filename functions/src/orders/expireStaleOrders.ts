import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import { db, FieldValue, Timestamp } from "../admin";
import { OrderDoc } from "../types2";
import { releaseInventory } from "../inventory/inventoryUtils";
import { writeOrderEvent } from "./orderEvents";
import { createNotificationInternal } from "../notifications/notificationFunctions";
import { logOperationalEvent } from "../utils/operationalLogging";

/**
 * expireStaleOrders (Phase 2, Section 5 — SLA system).
 *
 * The SLA itself (acceptanceDeadlineAt = createdAt + 48h) has been computed
 * and stored on every order since createOrder.ts was written; nothing ever
 * read it back. Runs hourly rather than daily like the subscription
 * scheduled jobs (expireStaleSubscriptions/gracePeriodReminder) because a
 * 48-hour SLA checked only once a day could leave an order sitting up to 24
 * hours past its deadline — the existing daily cadence is right for a 7-day
 * grace period, not a 48-hour one. This does not introduce a second SLA
 * model: the deadline field, the "requested" gate, and the terminal/active
 * status classification (orderStatus.ts) are all pre-existing.
 *
 * Idempotent and safe to run repeatedly or concurrently with itself: each
 * order's transition is a compare-and-set inside a transaction (mirrors
 * updateOrderStatus.ts's own guard) — an order already moved out of
 * "requested" by the vendor/customer in the interim is left untouched, not
 * force-expired.
 */
export const expireStaleOrders = onSchedule("every 1 hours", async () => {
  const now = Timestamp.now();

  const staleSnap = await db.collection("orders")
    .where("status", "==", "requested")
    .where("acceptanceDeadlineAt", "<=", now)
    .get();

  let expiredCount = 0;
  let skippedCount = 0;

  for (const doc of staleSnap.docs) {
    const orderId = doc.id;
    const orderRef = doc.ref;
    const order = doc.data() as OrderDoc;

    let didExpire = false;
    try {
      await db.runTransaction(async (tx) => {
        const fresh = await tx.get(orderRef);
        if (fresh.data()?.status !== "requested") {
          // Already accepted/rejected/cancelled by a real actor since the
          // query ran, or already expired by a concurrent/prior invocation
          // of this same function — leave it alone.
          return;
        }
        tx.update(orderRef, {
          status: "expired",
          expiredAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        didExpire = true;
      });
    } catch (err) {
      logger.error(`expireStaleOrders: failed to expire order ${orderId}`, err);
      logOperationalEvent({
        functionName: "expireStaleOrders",
        event: "unhandled_error",
        severity: "ERROR",
        metadata: { orderId, errorMessage: err instanceof Error ? err.message : String(err) },
      });
      continue;
    }

    if (!didExpire) {
      skippedCount++;
      continue;
    }

    await releaseInventory(order.vendorId, orderId, order.items, "order_expired_sla");

    await writeOrderEvent({
      orderId,
      vendorId: order.vendorId,
      eventType: "ORDER_AUTO_EXPIRED",
      actorRole: "system",
      before: { status: "requested" },
      after: { status: "expired" },
      metadata: { acceptanceDeadlineAt: order.acceptanceDeadlineAt, orderSource: order.orderSource },
    });

    // External orders' customerId is a synthetic "ext_{orderId}" placeholder
    // with no real users/{uid} document behind it — createNotificationInternal
    // already no-ops safely on a missing recipient, but skip the call
    // entirely for external orders rather than relying on that fallback.
    if (order.orderSource === "internal") {
      await createNotificationInternal({
        recipientUid: order.customerId,
        recipientRole: "customer",
        vendorId: order.vendorId,
        customerId: order.customerId,
        type: "order_expired",
        domain: "order",
        title: "Order expired",
        body: `${order.vendorSnapshot.name} didn't respond to your order in time, so it's been cancelled and any reserved items released.`,
        deepLink: `platform://chat/${order.conversationId}`,
        isCritical: true,
      });
    }

    const vendorSnap = await db.collection("vendors").doc(order.vendorId).get();
    const vendorOwnerUid = vendorSnap.data()?.ownerUid as string | undefined;
    if (vendorOwnerUid) {
      await createNotificationInternal({
        recipientUid: vendorOwnerUid,
        recipientRole: "vendor",
        vendorId: order.vendorId,
        customerId: order.orderSource === "internal" ? order.customerId : null,
        type: "order_expired",
        domain: "order",
        title: "Order expired — no response in time",
        body: `Order ${order.publicOrderId} expired after 48 hours with no response and has been cancelled.`,
        deepLink: `platform://chat/${order.conversationId}`,
        isCritical: false,
      });
    }

    expiredCount++;
  }

  logOperationalEvent({
    functionName: "expireStaleOrders",
    event: "scheduled_run_complete",
    severity: "WARNING",
    metadata: { candidateCount: staleSnap.size, expiredCount, skippedCount },
  });
});
