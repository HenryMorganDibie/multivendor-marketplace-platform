import { https } from "firebase-functions/v2";
import { db, FieldValue, Timestamp } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { assertAdmin } from "../utils/adminAuth";
import { DEFAULT_PLAN_DISPLAY, DEFAULT_PLAN_LIMITS, DEFAULT_PROVIDER_PLAN_CODES } from "./planLimitsSeedData";
import { SubscriptionPlanDoc, SubscriptionPlanId, ProviderPlanCodesDoc, VendorSubscriptionDoc } from "../types4";
import { withSubscriptionLock, LockContentionError } from "./subscriptionLock";

const ALL_PLAN_IDS: SubscriptionPlanId[] = ["basic", "standard", "pro", "pro_plus"];

/**
 * seedSubscriptionPlans (Phase 4, Section 5.9).
 *
 * Idempotent bootstrap of both the public subscriptionPlans collection and
 * the private providerPlanCodes collection. Real deployments run this once
 * per environment; re-running upserts the same four plan documents rather
 * than duplicating anything.
 */
export const seedSubscriptionPlans = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "seedSubscriptionPlans");
  const admin = await assertAdmin(request, ["super_admin"]);

  const now = FieldValue.serverTimestamp();
  const batch = db.batch();

  for (const planId of ALL_PLAN_IDS) {
    const limits = DEFAULT_PLAN_LIMITS[planId];
    const display = DEFAULT_PLAN_DISPLAY[planId];
    const planDoc: SubscriptionPlanDoc = {
      planId,
      displayName: display.displayName,
      features: display.features,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      ...limits,
    };
    batch.set(db.collection("subscriptionPlans").doc(planId), planDoc, { merge: true });

    const codesDoc: ProviderPlanCodesDoc = {
      planId,
      paystack: DEFAULT_PROVIDER_PLAN_CODES[planId].paystack,
      flutterwave: DEFAULT_PROVIDER_PLAN_CODES[planId].flutterwave,
      stripe: DEFAULT_PROVIDER_PLAN_CODES[planId].stripe,
      updatedAt: now,
    };
    batch.set(db.collection("providerPlanCodes").doc(planId), codesDoc, { merge: true });
  }

  await batch.commit();

  await writeAuditLog({
    requestId,
    functionName: "seedSubscriptionPlans",
    actorUid: admin.uid,
    actorRole: "admin",
    actorType: "admin",
    targetType: "subscriptionPlans",
    targetId: "default_seed",
    eventType: "subscription.plans_seeded",
    metadata: { planCount: ALL_PLAN_IDS.length },
    appCheck,
  });

  return { success: true, planCount: ALL_PLAN_IDS.length };
});

interface AdminActionParams {
  reason?: unknown;
  ticketId?: unknown;
  notes?: unknown;
}

function requireReason(params: AdminActionParams): { reason: string; ticketId: string | null; notes: string | null } {
  const reason = typeof params.reason === "string" ? params.reason.trim() : "";
  if (!reason) {
    throw new https.HttpsError("invalid-argument", "reason is required for this admin action.");
  }
  return {
    reason,
    ticketId: typeof params.ticketId === "string" && params.ticketId.trim() ? params.ticketId.trim() : null,
    notes: typeof params.notes === "string" && params.notes.trim() ? params.notes.trim() : null,
  };
}

/**
 * cancelSubscriptionAdmin (Phase 4, Section 5.6).
 *
 * super_admin only. Immediate or cancel-at-period-end, distinct from the
 * vendor-facing cancelSubscription which is always cancel-at-period-end.
 * Requires a reason (v6 mandatory admin audit fields) — there is no
 * anonymous or unexplained admin mutation path anywhere in this system.
 */
export const cancelSubscriptionAdmin = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "cancelSubscriptionAdmin");
  const admin = await assertAdmin(request, ["super_admin"]);

  const { vendorId, immediate } = request.data ?? {};
  if (!vendorId || typeof vendorId !== "string") {
    throw new https.HttpsError("invalid-argument", "vendorId is required.");
  }
  const { reason, ticketId, notes } = requireReason(request.data ?? {});

  try {
    await withSubscriptionLock(vendorId, `cancelSubscriptionAdmin:${requestId}`, async () => {
      const subRef = db.collection("vendorSubscriptions").doc(vendorId);
      const subSnap = await subRef.get();
      if (!subSnap.exists) throw new https.HttpsError("not-found", "Vendor has no subscription.");
      const before = subSnap.data() as VendorSubscriptionDoc;

      const now = FieldValue.serverTimestamp();
      const updates: Record<string, unknown> = {
        cancelledAt: now,
        cancelAtPeriodEnd: !immediate,
        pendingDowngradePlan: null,
        pendingDowngradeAt: null,
        lastEventType: "admin.cancelled",
        lastEventAt: now,
        version: FieldValue.increment(1),
        updatedAt: now,
      };
      if (immediate) {
        updates.status = "cancelled";
        updates.plan = "basic";
      }
      await subRef.update(updates);

      await writeAuditLog({
        requestId,
        functionName: "cancelSubscriptionAdmin",
        actorUid: admin.uid,
        actorRole: "admin",
        actorType: "admin",
        targetType: "vendorSubscription",
        targetId: vendorId,
        eventType: "subscription.admin_cancelled",
        metadata: { reason, ticketId, notes, immediate: !!immediate },
        appCheck,
      });

      await db.collection("subscriptionEvents").add({
        eventId: db.collection("subscriptionEvents").doc().id,
        vendorId,
        provider: "manual_admin_override",
        providerEventId: requestId,
        normalizedEventType: "admin.cancelled",
        rawEventType: "admin.cancelled",
        plan: immediate ? "basic" : before.plan,
        previousPlan: before.plan,
        status: immediate ? "cancelled" : before.status,
        idempotencyKey: requestId,
        wasIgnored: false,
        reason, performedBy: admin.uid, ticketId, notes,
        oldPlan: before.plan, newPlan: immediate ? "basic" : before.plan,
        oldStatus: before.status, newStatus: immediate ? "cancelled" : before.status,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        processedAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (err) {
    if (err instanceof LockContentionError) {
      throw new https.HttpsError("aborted", "Subscription is mid-update. Please retry shortly.");
    }
    throw err;
  }

  return { success: true };
});

/**
 * applyManualSubscriptionOverride (Phase 4, Section 5.7 / Decision A).
 *
 * super_admin only. Sets adminOverrideExpiresAt (default 30 days).
 * Provider webhooks that arrive during the override window are logged to
 * subscriptionEvents but never change the vendor's effective plan — see
 * resolveEffectivePlan's priority order (types4.ts / resolveEffectivePlan.ts).
 */
export const applyManualSubscriptionOverride = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "applyManualSubscriptionOverride");
  const admin = await assertAdmin(request, ["super_admin"]);

  const { vendorId, plan, overrideDays } = request.data ?? {};
  if (!vendorId || typeof vendorId !== "string") {
    throw new https.HttpsError("invalid-argument", "vendorId is required.");
  }
  if (!ALL_PLAN_IDS.includes(plan)) {
    throw new https.HttpsError("invalid-argument", `plan must be one of: ${ALL_PLAN_IDS.join(", ")}.`);
  }
  const { reason, ticketId, notes } = requireReason(request.data ?? {});
  const days = typeof overrideDays === "number" && overrideDays > 0 ? overrideDays : 30;

  try {
    await withSubscriptionLock(vendorId, `applyManualSubscriptionOverride:${requestId}`, async () => {
      const subRef = db.collection("vendorSubscriptions").doc(vendorId);
      const subSnap = await subRef.get();
      const before = subSnap.exists ? (subSnap.data() as VendorSubscriptionDoc) : null;
      const now = FieldValue.serverTimestamp();
      const overrideExpiresAt = Timestamp.fromMillis(Date.now() + days * 24 * 60 * 60 * 1000);

      const updates: Record<string, unknown> = {
        vendorId,
        plan,
        adminOverrideExpiresAt: overrideExpiresAt,
        provider: "manual_admin_override",
        lastEventType: "admin.override_applied",
        lastEventAt: now,
        version: FieldValue.increment(1),
        updatedAt: now,
      };
      if (!subSnap.exists) {
        // A vendor with no prior subscription record can still receive an
        // override (e.g. a comped account) — seed the minimum viable doc.
        Object.assign(updates, {
          status: "active",
          provider: "manual_admin_override",
          providerSubscriptionId: `override_${vendorId}`,
          providerCustomerId: `override_${vendorId}`,
          providerPlanId: plan,
          currency: "NGN",
          amountPaid: 0,
          billingInterval: "monthly",
          currentPeriodStart: now,
          currentPeriodEnd: overrideExpiresAt,
          cancelAtPeriodEnd: false,
          lastEventSequence: Date.now(),
          lastEventPriority: 40,
          version: 1,
          createdAt: now,
        });
      }
      await subRef.set(updates, { merge: true });

      await writeAuditLog({
        requestId,
        functionName: "applyManualSubscriptionOverride",
        actorUid: admin.uid,
        actorRole: "admin",
        actorType: "admin",
        targetType: "vendorSubscription",
        targetId: vendorId,
        eventType: "subscription.admin_override_applied",
        metadata: { reason, ticketId, notes, plan, overrideDays: days },
        appCheck,
      });

      await db.collection("subscriptionEvents").add({
        eventId: db.collection("subscriptionEvents").doc().id,
        vendorId,
        provider: "manual_admin_override",
        providerEventId: requestId,
        normalizedEventType: "admin.override_applied",
        rawEventType: "admin.override_applied",
        plan,
        previousPlan: before?.plan ?? null,
        status: before?.status ?? "active",
        idempotencyKey: requestId,
        wasIgnored: false,
        reason, performedBy: admin.uid, ticketId, notes,
        oldPlan: before?.plan ?? null, newPlan: plan,
        oldStatus: before?.status ?? null, newStatus: before?.status ?? "active",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        processedAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (err) {
    if (err instanceof LockContentionError) {
      throw new https.HttpsError("aborted", "Subscription is mid-update. Please retry shortly.");
    }
    throw err;
  }

  return { success: true };
});
