import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { resolveEffectivePlan } from "../subscriptions/resolveEffectivePlan";

const MAX_POLICY_LENGTH = 2000;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MAX_RANGES_PER_DAY = 5;
// Matches the exact format the mobile hours editors already produce, e.g.
// "9:00 AM" / "12:00 PM" — h or hh, mm, AM/PM. Validated server-side rather
// than trusted, since this function persists straight to the vendor doc.
const TIME_STRING_RE = /^([1-9]|1[0-2]):[0-5][0-9]\s?(AM|PM)$/i;

const FULFILLMENT_METHODS = ["pickup", "delivery", "shipping"] as const;
const MAX_FULFILLMENT_METHODS = FULFILLMENT_METHODS.length;

interface TimeRange {
  open: string;
  close: string;
}

interface DayHoursConfig {
  closed: boolean;
  ranges: TimeRange[];
}

function assertValidTimeRange(range: unknown, context: string): TimeRange {
  if (typeof range !== "object" || range === null) {
    throw new https.HttpsError("invalid-argument", `${context}: each range must be an object.`);
  }
  const { open, close } = range as Record<string, unknown>;
  if (typeof open !== "string" || !TIME_STRING_RE.test(open.trim())) {
    throw new https.HttpsError("invalid-argument", `${context}: open time is not a valid time string.`);
  }
  if (typeof close !== "string" || !TIME_STRING_RE.test(close.trim())) {
    throw new https.HttpsError("invalid-argument", `${context}: close time is not a valid time string.`);
  }
  return { open: open.trim(), close: close.trim() };
}

function assertValidWeeklyHours(value: unknown): Record<string, DayHoursConfig> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new https.HttpsError("invalid-argument", "weeklyHours must be an object keyed by weekday.");
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  // Only the seven known weekday keys are accepted — reject anything else
  // rather than silently persisting unexpected structures.
  for (const key of keys) {
    if (!(WEEKDAYS as readonly string[]).includes(key)) {
      throw new https.HttpsError("invalid-argument", `weeklyHours: unexpected key "${key}".`);
    }
  }

  const result: Record<string, DayHoursConfig> = {};
  for (const day of WEEKDAYS) {
    const dayValue = input[day];
    if (dayValue === undefined) continue; // partial updates (e.g. a single day) are allowed
    if (typeof dayValue !== "object" || dayValue === null || Array.isArray(dayValue)) {
      throw new https.HttpsError("invalid-argument", `weeklyHours.${day} must be an object.`);
    }
    const { closed, ranges } = dayValue as Record<string, unknown>;
    if (typeof closed !== "boolean") {
      throw new https.HttpsError("invalid-argument", `weeklyHours.${day}.closed must be a boolean.`);
    }
    if (!Array.isArray(ranges)) {
      throw new https.HttpsError("invalid-argument", `weeklyHours.${day}.ranges must be an array.`);
    }
    if (ranges.length > MAX_RANGES_PER_DAY) {
      throw new https.HttpsError("invalid-argument", `weeklyHours.${day}.ranges must have at most ${MAX_RANGES_PER_DAY} entries.`);
    }
    const validatedRanges = ranges.map((r, i) => assertValidTimeRange(r, `weeklyHours.${day}.ranges[${i}]`));
    result[day] = { closed, ranges: closed ? [] : validatedRanges };
  }
  return result;
}

function assertValidFulfillmentTypes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new https.HttpsError("invalid-argument", "fulfillmentTypes must be an array.");
  }
  if (value.length === 0) {
    throw new https.HttpsError("invalid-argument", "At least one fulfillment method must be enabled.");
  }
  if (value.length > MAX_FULFILLMENT_METHODS) {
    throw new https.HttpsError("invalid-argument", `fulfillmentTypes must have at most ${MAX_FULFILLMENT_METHODS} entries.`);
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !(FULFILLMENT_METHODS as readonly string[]).includes(entry)) {
      throw new https.HttpsError(
        "invalid-argument",
        `fulfillmentTypes may only contain: ${FULFILLMENT_METHODS.join(", ")}.`
      );
    }
    if (seen.has(entry)) {
      throw new https.HttpsError("invalid-argument", `fulfillmentTypes contains a duplicate value: "${entry}".`);
    }
    seen.add(entry);
  }
  // Normalized: dedup already enforced above, but return in a stable,
  // canonical order rather than whatever order the client sent.
  return FULFILLMENT_METHODS.filter((m) => value.includes(m));
}

/**
 * updateVendorSettings (Phase 4, Section 6; extended for Business Hours and
 * Fulfillment Methods).
 *
 * minimumOrderAmount and policy are gated by plan (canSetMinimumOrderAmount /
 * canSetBusinessPolicies). weeklyHours and fulfillmentTypes are not
 * plan-gated — both are informational/operational vendor configuration, not
 * premium storefront features.
 *
 * weeklyHours is the sole canonical Business Hours representation
 * (VendorDoc's separate `businessHours` string and `openingHours` fields are
 * not written by this function and should not be treated as authoritative —
 * see mapVendorDoc.ts and the Storefront Business Details sheet).
 */
export const updateVendorSettings = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "updateVendorSettings");

  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string | undefined;
  // A vendor role with no vendorId claim (stale token predating a claims
  // repair, or a token that was never refreshed after one) previously fell
  // through silently: db.collection("vendors").doc(undefined) throws a raw
  // (non-HttpsError) SDK error, which the callable wrapper reports to the
  // client as an opaque "internal" with no actionable detail -- reproduced
  // directly against this handler. Caught here with a message that tells
  // the vendor what to actually do about it.
  if (!vendorId || typeof vendorId !== "string") {
    throw new https.HttpsError(
      "failed-precondition",
      "Your vendor session needs to be refreshed. Please sign out and back in, then try again."
    );
  }
  const { minimumOrderAmount, policy, weeklyHours, fulfillmentTypes } = request.data ?? {};

  if (
    minimumOrderAmount === undefined &&
    policy === undefined &&
    weeklyHours === undefined &&
    fulfillmentTypes === undefined
  ) {
    throw new https.HttpsError(
      "invalid-argument",
      "At least one of minimumOrderAmount, policy, weeklyHours, or fulfillmentTypes is required."
    );
  }

  const { limits: planLimits } = await resolveEffectivePlan(vendorId);
  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };

  if (minimumOrderAmount !== undefined) {
    if (!planLimits.canSetMinimumOrderAmount) {
      throw new https.HttpsError("permission-denied", "Setting a minimum order amount is not available on your current plan.");
    }
    if (typeof minimumOrderAmount !== "number" || minimumOrderAmount < 0) {
      throw new https.HttpsError("invalid-argument", "minimumOrderAmount must be a non-negative number.");
    }
    updates.minimumOrderAmount = minimumOrderAmount;
  }

  if (policy !== undefined) {
    if (!planLimits.canSetBusinessPolicies) {
      throw new https.HttpsError("permission-denied", "Setting business policies is not available on your current plan.");
    }
    const trimmed = String(policy).trim();
    if (trimmed.length > MAX_POLICY_LENGTH) {
      throw new https.HttpsError("invalid-argument", `policy must be ${MAX_POLICY_LENGTH} characters or fewer.`);
    }
    updates.policy = trimmed;
  }

  if (weeklyHours !== undefined) {
    const currentSnap = await db.collection("vendors").doc(vendorId).get();
    const currentWeeklyHours = (currentSnap.data()?.weeklyHours as Record<string, DayHoursConfig> | undefined) ?? {};
    const validatedPartial = assertValidWeeklyHours(weeklyHours);
    // Merge rather than replace: edit-day-hours.tsx saves one day at a time,
    // and a partial payload must not wipe the other six days' configuration.
    updates.weeklyHours = { ...currentWeeklyHours, ...validatedPartial };
  }

  if (fulfillmentTypes !== undefined) {
    updates.fulfillmentTypes = assertValidFulfillmentTypes(fulfillmentTypes);
  }

  await db.collection("vendors").doc(vendorId).update(updates);

  await writeAuditLog({
    requestId,
    functionName: "updateVendorSettings",
    actorUid: request.auth.uid,
    actorRole: "vendor",
    actorType: "vendor",
    targetType: "vendor",
    targetId: vendorId,
    eventType: "vendor.settings_updated",
    after: updates,
    appCheck,
  });

  return { success: true };
});
