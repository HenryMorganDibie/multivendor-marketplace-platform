import * as crypto from "crypto";
import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { OrderDoc } from "../types2";
import { RatingDoc, VendorFacingRating } from "../types4";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { assertAdmin } from "../utils/adminAuth";
import { enforceRateLimit } from "../subscriptions/rateLimit";

const MAX_FEEDBACK_LENGTH = 1000;
const NON_RATABLE_STATUSES = ["cancelled", "rejected", "expired"];

/** Cryptographically random, unguessable, never derived from ratingId,
 * orderId, vendorId, or customerId — the only identifier a vendor ever
 * sees (PHASE_4_COLLECTION_MAPPING v10, Section 4.9). */
function generateDisplayId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I
  let code = "";
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) code += alphabet[bytes[i] % alphabet.length];
  return `R-${code}`;
}

/**
 * submitRating (Phase 4, Section 5.12).
 *
 * Final upon submission — there is no follow-up edit function anywhere in
 * this system (v10). The only post-submission mutation is admin-initiated
 * moderateRating.
 */
export const submitRating = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "submitRating");

  if (!request.auth || request.auth.token.role !== "customer") {
    throw new https.HttpsError("permission-denied", "Customers only.");
  }
  const customerId = request.auth.uid;
  await enforceRateLimit(customerId, "submitRating");

  const { orderId, stars, privateFeedback } = request.data ?? {};
  if (!orderId || typeof orderId !== "string") throw new https.HttpsError("invalid-argument", "orderId is required.");
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    throw new https.HttpsError("invalid-argument", "stars must be an integer from 1 to 5.");
  }
  if (privateFeedback !== undefined && privateFeedback !== null) {
    if (typeof privateFeedback !== "string" || privateFeedback.length > MAX_FEEDBACK_LENGTH) {
      throw new https.HttpsError("invalid-argument", `privateFeedback must be a string of ${MAX_FEEDBACK_LENGTH} characters or fewer.`);
    }
  }

  const orderRef = db.collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw new https.HttpsError("not-found", "Order not found.");
  const order = orderSnap.data() as OrderDoc;

  if (order.customerId !== customerId) {
    throw new https.HttpsError("permission-denied", "You do not own this order.");
  }
  if (NON_RATABLE_STATUSES.includes(order.status)) {
    throw new https.HttpsError("failed-precondition", `Orders with status "${order.status}" cannot be rated.`);
  }
  if (order.status !== "completed") {
    throw new https.HttpsError("failed-precondition", "Only completed orders can be rated.");
  }

  const existingSnap = await db.collection("ratings").where("orderId", "==", orderId).limit(1).get();
  if (!existingSnap.empty) {
    throw new https.HttpsError("already-exists", "This order has already been rated.");
  }

  const hasFeedback = typeof privateFeedback === "string" && privateFeedback.trim().length > 0;
  const ratingRef = db.collection("ratings").doc();
  const now = FieldValue.serverTimestamp();
  const rating: RatingDoc = {
    ratingId: ratingRef.id,
    displayId: generateDisplayId(),
    orderId,
    vendorId: order.vendorId,
    customerId,
    stars,
    privateFeedback: hasFeedback ? privateFeedback.trim() : null,
    hasPrivateFeedback: hasFeedback,
    submittedAt: now,
    readByVendor: false,
    readByVendorAt: null,
    moderationStatus: "clean",
    moderatedByAdminUid: null,
    moderationReason: null,
  };

  const batch = db.batch();
  batch.set(ratingRef, rating);
  batch.update(orderRef, { hasRating: true, updatedAt: now });
  await batch.commit();

  await writeAuditLog({
    requestId,
    functionName: "submitRating",
    actorUid: customerId,
    actorRole: "customer",
    actorType: "customer",
    targetType: "rating",
    targetId: ratingRef.id,
    eventType: "rating.submitted",
    after: { orderId, vendorId: order.vendorId, stars },
    appCheck,
  });

  return { success: true, ratingId: ratingRef.id, displayId: rating.displayId };
});

function toVendorFacing(doc: RatingDoc): VendorFacingRating {
  // Explicit allowlist projection — the enforcement point that guarantees
  // orderId/customerId never leak to a vendor client, not just an
  // omission a future edit to this function could accidentally undo.
  return {
    ratingId: doc.ratingId,
    displayId: doc.displayId,
    stars: doc.stars,
    privateFeedback: doc.privateFeedback ?? null,
    hasPrivateFeedback: doc.hasPrivateFeedback,
    submittedAt: doc.submittedAt,
    readByVendor: doc.readByVendor,
  };
}

/**
 * getVendorRatings (Phase 4, Section 5.13).
 *
 * The ONLY sanctioned read path for a vendor to view their own ratings —
 * direct Firestore reads are denied entirely in firestore.rules for the
 * vendor role, specifically so this server-side projection is the only
 * way orderId/customerId could ever reach a vendor client.
 */
export const getVendorRatings = https.onCall(async (request) => {
  checkAppCheck(request, "getVendorRatings");
  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string | undefined;
  if (!vendorId) throw new https.HttpsError("failed-precondition", "Vendor ID could not be determined.");

  // "in" rather than "!=" — a flagged rating still shows to the vendor,
  // only a removed one is excluded, and "in" avoids != semantics quietly
  // dropping any document where moderationStatus happens to be absent.
  const snap = await db.collection("ratings")
    .where("vendorId", "==", vendorId)
    .where("moderationStatus", "in", ["clean", "flagged"])
    .get();

  const ratings = snap.docs.map((d) => toVendorFacing(d.data() as RatingDoc));

  // Mark unread ratings as read now that the vendor has fetched them —
  // narrowly scoped to this one field, the only one a vendor is ever
  // permitted to change on a rating (moderateRating owns everything else).
  const unread = snap.docs.filter((d) => !(d.data() as RatingDoc).readByVendor);
  if (unread.length > 0) {
    const batch = db.batch();
    const now = FieldValue.serverTimestamp();
    for (const doc of unread) batch.update(doc.ref, { readByVendor: true, readByVendorAt: now });
    await batch.commit();
  }

  return { success: true, ratings };
});

/**
 * moderateRating (Phase 4, Section 5.14).
 *
 * super_admin or safety_admin only. Never deletes the document — a
 * "removed" rating is excluded from vendorRatingStats and getVendorRatings
 * going forward, but remains queryable by admins for audit purposes. This
 * is the ONLY post-submission mutation path for a ratings document.
 */
export const moderateRating = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "moderateRating");
  const admin = await assertAdmin(request, ["super_admin", "safety_admin"]);

  const { ratingId, moderationStatus, reason } = request.data ?? {};
  if (!ratingId || typeof ratingId !== "string") throw new https.HttpsError("invalid-argument", "ratingId is required.");
  if (moderationStatus !== "flagged" && moderationStatus !== "removed") {
    throw new https.HttpsError("invalid-argument", "moderationStatus must be 'flagged' or 'removed'.");
  }
  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  if (!trimmedReason) throw new https.HttpsError("invalid-argument", "reason is required for this admin action.");

  const ratingRef = db.collection("ratings").doc(ratingId);
  const ratingSnap = await ratingRef.get();
  if (!ratingSnap.exists) throw new https.HttpsError("not-found", "Rating not found.");
  const before = ratingSnap.data() as RatingDoc;

  await ratingRef.update({
    moderationStatus,
    moderatedByAdminUid: admin.uid,
    moderationReason: trimmedReason,
  });

  await writeAuditLog({
    requestId,
    functionName: "moderateRating",
    actorUid: admin.uid,
    actorRole: "admin",
    actorType: "admin",
    targetType: "rating",
    targetId: ratingId,
    eventType: "rating.moderated",
    before: { moderationStatus: before.moderationStatus ?? "clean" },
    after: { moderationStatus, reason: trimmedReason },
    appCheck,
  });

  return { success: true };
});
