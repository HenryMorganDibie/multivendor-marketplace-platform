import { firestore as functionsFirestore } from "firebase-functions/v1";
import { db, FieldValue, Timestamp } from "../admin";
import { RatingDoc, VendorRatingStatsDoc } from "../types4";

/**
 * onRatingWrite (Phase 4, Section 5.15).
 *
 * Fires on create (submitRating) and on moderation updates
 * (moderateRating) — there is no customer-edit case to fire on, since no
 * such path exists (v10). Recomputes vendorRatingStats/{vendorId} from
 * scratch each time rather than incrementally, since a moderation action
 * can both add and remove a rating from the aggregate depending on the
 * transition, and a full recompute is simplest to keep provably correct
 * at MVP scale. Never reads privateFeedback, orderId, or customerId into
 * any aggregate or denormalized field.
 */
export const onRatingWrite = functionsFirestore.document("ratings/{ratingId}").onWrite(async (change) => {
  const after = change.after.exists ? (change.after.data() as RatingDoc) : null;
  const before = change.before.exists ? (change.before.data() as RatingDoc) : null;
  const vendorId = after?.vendorId ?? before?.vendorId;
  if (!vendorId) return;

  const snap = await db.collection("ratings")
    .where("vendorId", "==", vendorId)
    .where("moderationStatus", "in", ["clean", "flagged"])
    .get();

  const ratings = snap.docs.map((d) => d.data() as RatingDoc);
  const breakdown = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  let sum = 0;
  let lastRatingAtMs = 0;

  for (const r of ratings) {
    const star = r.stars as 1 | 2 | 3 | 4 | 5;
    if (breakdown[star] !== undefined) breakdown[star]++;
    sum += r.stars;
    const submittedAtMs = r.submittedAt && "toMillis" in r.submittedAt ? r.submittedAt.toMillis() : 0;
    if (submittedAtMs > lastRatingAtMs) lastRatingAtMs = submittedAtMs;
  }

  const total = ratings.length;
  const average = total > 0 ? Math.round((sum / total) * 10) / 10 : 0;

  const statsDoc: Partial<VendorRatingStatsDoc> = {
    vendorId,
    average,
    total,
    breakdown,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (lastRatingAtMs > 0) {
    statsDoc.lastRatingAt = Timestamp.fromMillis(lastRatingAtMs);
  }

  await db.collection("vendorRatingStats").doc(vendorId).set(statsDoc, { merge: true });
  await db.collection("vendors").doc(vendorId).update({
    ratingAverage: average,
    ratingCount: total,
  }).catch(() => null); // vendor doc missing is not this trigger's problem to surface
});
