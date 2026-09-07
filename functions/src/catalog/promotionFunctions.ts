import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { resolveEffectivePlan } from "../subscriptions/resolveEffectivePlan";
import { PromotionDoc, PromotionType } from "../types2";

const VALID_TYPES: PromotionType[] = ["percentage", "flat", "bogo", "free_item", "free_delivery"];
const VALID_ICONS = ["percent", "gift", "truck", "tag", "zap"];
const VALID_ELIGIBILITY = ["all", "pickup", "delivery"];
const MAX_TITLE_LENGTH = 200;
const MAX_SHORT_DESC_LENGTH = 300;
const MAX_FULL_DESC_LENGTH = 1000;
const MAX_TERMS_LENGTH = 500;

function requireVendor(request: https.CallableRequest<unknown>): string {
  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string | undefined;
  if (!vendorId) throw new https.HttpsError("failed-precondition", "Vendor ID could not be determined.");
  return vendorId;
}

/** Validates the structural/numeric fields every create or update must
 * satisfy. Title/description text is vendor-authored content (same trust
 * model as invoice branding's thank-you message) — capped in length, not
 * regenerated server-side. */
function validatePromotionInput(data: Record<string, unknown>): void {
  const { title, shortDescription, fullDescription, type, discountValue, minimumOrder,
    maxDiscount, startDate, endDate, icon, eligibility, vendorTerms } = data;

  if (typeof title !== "string" || !title.trim() || title.length > MAX_TITLE_LENGTH) {
    throw new https.HttpsError("invalid-argument", `title is required, ${MAX_TITLE_LENGTH} characters or fewer.`);
  }
  if (typeof shortDescription !== "string" || !shortDescription.trim() || shortDescription.length > MAX_SHORT_DESC_LENGTH) {
    throw new https.HttpsError("invalid-argument", `shortDescription is required, ${MAX_SHORT_DESC_LENGTH} characters or fewer.`);
  }
  if (typeof fullDescription !== "string" || !fullDescription.trim() || fullDescription.length > MAX_FULL_DESC_LENGTH) {
    throw new https.HttpsError("invalid-argument", `fullDescription is required, ${MAX_FULL_DESC_LENGTH} characters or fewer.`);
  }
  if (typeof type !== "string" || !VALID_TYPES.includes(type as PromotionType)) {
    throw new https.HttpsError("invalid-argument", `type must be one of: ${VALID_TYPES.join(", ")}.`);
  }
  if (typeof discountValue !== "number" || discountValue < 0) {
    throw new https.HttpsError("invalid-argument", "discountValue must be a non-negative number.");
  }
  if (type === "percentage" && discountValue > 100) {
    throw new https.HttpsError("invalid-argument", "A percentage discount cannot exceed 100.");
  }
  if ((type === "percentage" || type === "flat") && discountValue <= 0) {
    throw new https.HttpsError("invalid-argument", "discountValue must be greater than 0 for percentage/flat promotions.");
  }
  if (typeof minimumOrder !== "number" || minimumOrder < 0) {
    throw new https.HttpsError("invalid-argument", "minimumOrder must be a non-negative number.");
  }
  if (maxDiscount !== undefined && maxDiscount !== null && (typeof maxDiscount !== "number" || maxDiscount <= 0)) {
    throw new https.HttpsError("invalid-argument", "maxDiscount must be a positive number when provided.");
  }
  if (typeof startDate !== "string" || Number.isNaN(new Date(startDate).getTime())) {
    throw new https.HttpsError("invalid-argument", "startDate must be a valid ISO date string.");
  }
  if (typeof endDate !== "string" || Number.isNaN(new Date(endDate).getTime())) {
    throw new https.HttpsError("invalid-argument", "endDate must be a valid ISO date string.");
  }
  if (new Date(endDate).getTime() < new Date(startDate).getTime()) {
    throw new https.HttpsError("invalid-argument", "endDate cannot be before startDate.");
  }
  if (typeof icon !== "string" || !VALID_ICONS.includes(icon)) {
    throw new https.HttpsError("invalid-argument", `icon must be one of: ${VALID_ICONS.join(", ")}.`);
  }
  if (eligibility !== undefined && eligibility !== null && !VALID_ELIGIBILITY.includes(eligibility as string)) {
    throw new https.HttpsError("invalid-argument", `eligibility must be one of: ${VALID_ELIGIBILITY.join(", ")}.`);
  }
  if (vendorTerms !== undefined && vendorTerms !== null && (typeof vendorTerms !== "string" || vendorTerms.length > MAX_TERMS_LENGTH)) {
    throw new https.HttpsError("invalid-argument", `vendorTerms must be ${MAX_TERMS_LENGTH} characters or fewer.`);
  }
  if ((type === "bogo" || type === "free_item") && data.applicableItemIds !== undefined) {
    if (!Array.isArray(data.applicableItemIds) || data.applicableItemIds.some((id) => typeof id !== "string")) {
      throw new https.HttpsError("invalid-argument", "applicableItemIds must be an array of item ID strings.");
    }
  }
}

/** Confirms every referenced catalog item actually belongs to this vendor —
 * never trust an item ID the client claims, same pattern as invoice
 * branding's logo-file check. */
async function requireOwnedCatalogItems(vendorId: string, itemIds: string[] | undefined | null): Promise<void> {
  if (!itemIds || itemIds.length === 0) return;
  const refs = itemIds.map((id) => db.collection("vendors").doc(vendorId).collection("catalogItems").doc(id));
  const snaps = await db.getAll(...refs);
  const missing = snaps.filter((s) => !s.exists).map((s) => s.id);
  if (missing.length > 0) {
    throw new https.HttpsError("invalid-argument", `Catalog item(s) not found for this vendor: ${missing.join(", ")}.`);
  }
}

export const createPromotion = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "createPromotion");
  const vendorId = requireVendor(request);
  const data = (request.data ?? {}) as Record<string, unknown>;

  validatePromotionInput(data);
  await requireOwnedCatalogItems(vendorId, data.applicableItemIds as string[] | undefined);

  const { limits: planLimits } = await resolveEffectivePlan(vendorId);
  const activeCountSnap = await db
    .collection("vendors").doc(vendorId).collection("promotions")
    .where("active", "==", true)
    .get();
  if (activeCountSnap.size >= planLimits.activePromotionsLimit) {
    throw new https.HttpsError(
      "resource-exhausted",
      `Your plan allows up to ${planLimits.activePromotionsLimit} active promotion(s). Deactivate one before creating another.`
    );
  }

  const now = FieldValue.serverTimestamp();
  const ref = db.collection("vendors").doc(vendorId).collection("promotions").doc();
  const promo: PromotionDoc = {
    promotionId: ref.id,
    vendorId,
    title: (data.title as string).trim(),
    shortDescription: (data.shortDescription as string).trim(),
    fullDescription: (data.fullDescription as string).trim(),
    type: data.type as PromotionType,
    discountValue: data.discountValue as number,
    minimumOrder: data.minimumOrder as number,
    maxDiscount: (data.maxDiscount as number | undefined) ?? null,
    freeItemName: (data.freeItemName as string | undefined) ?? null,
    bogoItemName: (data.bogoItemName as string | undefined) ?? null,
    applicableItemIds: (data.applicableItemIds as string[] | undefined) ?? null,
    applicableCategoryIds: (data.applicableCategoryIds as string[] | undefined) ?? null,
    active: true,
    startDate: data.startDate as string,
    endDate: data.endDate as string,
    icon: data.icon as PromotionDoc["icon"],
    eligibility: (data.eligibility as PromotionDoc["eligibility"] | undefined) ?? "all",
    vendorTerms: (data.vendorTerms as string | undefined) ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await ref.set(promo);

  await writeAuditLog({
    requestId, functionName: "createPromotion", actorUid: request.auth!.uid, actorRole: "vendor", actorType: "vendor",
    targetType: "promotion", targetId: ref.id, eventType: "promotion.created",
    after: { title: promo.title, type: promo.type }, appCheck,
  });

  return { success: true, promotionId: ref.id };
});

export const updatePromotion = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "updatePromotion");
  const vendorId = requireVendor(request);
  const data = (request.data ?? {}) as Record<string, unknown>;
  const promotionId = data.promotionId as string | undefined;
  if (!promotionId) throw new https.HttpsError("invalid-argument", "promotionId is required.");

  validatePromotionInput(data);
  await requireOwnedCatalogItems(vendorId, data.applicableItemIds as string[] | undefined);

  const ref = db.collection("vendors").doc(vendorId).collection("promotions").doc(promotionId);
  const snap = await ref.get();
  if (!snap.exists) throw new https.HttpsError("not-found", "Promotion not found.");

  await ref.update({
    title: (data.title as string).trim(),
    shortDescription: (data.shortDescription as string).trim(),
    fullDescription: (data.fullDescription as string).trim(),
    type: data.type,
    discountValue: data.discountValue,
    minimumOrder: data.minimumOrder,
    maxDiscount: (data.maxDiscount as number | undefined) ?? null,
    freeItemName: (data.freeItemName as string | undefined) ?? null,
    bogoItemName: (data.bogoItemName as string | undefined) ?? null,
    applicableItemIds: (data.applicableItemIds as string[] | undefined) ?? null,
    applicableCategoryIds: (data.applicableCategoryIds as string[] | undefined) ?? null,
    startDate: data.startDate,
    endDate: data.endDate,
    icon: data.icon,
    eligibility: (data.eligibility as PromotionDoc["eligibility"] | undefined) ?? "all",
    vendorTerms: (data.vendorTerms as string | undefined) ?? null,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeAuditLog({
    requestId, functionName: "updatePromotion", actorUid: request.auth!.uid, actorRole: "vendor", actorType: "vendor",
    targetType: "promotion", targetId: promotionId, eventType: "promotion.updated", appCheck,
  });

  return { success: true };
});

export const deletePromotion = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "deletePromotion");
  const vendorId = requireVendor(request);
  const promotionId = (request.data as { promotionId?: string } | undefined)?.promotionId;
  if (!promotionId) throw new https.HttpsError("invalid-argument", "promotionId is required.");

  const ref = db.collection("vendors").doc(vendorId).collection("promotions").doc(promotionId);
  const snap = await ref.get();
  if (!snap.exists) throw new https.HttpsError("not-found", "Promotion not found.");
  await ref.delete();

  await writeAuditLog({
    requestId, functionName: "deletePromotion", actorUid: request.auth!.uid, actorRole: "vendor", actorType: "vendor",
    targetType: "promotion", targetId: promotionId, eventType: "promotion.deleted", appCheck,
  });

  return { success: true };
});

/** Toggling ON re-checks activePromotionsLimit — the same check
 * createPromotion enforces, since activating is functionally identical
 * to creating a new active promotion from the limit's perspective. */
export const togglePromotionActive = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "togglePromotionActive");
  const vendorId = requireVendor(request);
  const promotionId = (request.data as { promotionId?: string } | undefined)?.promotionId;
  if (!promotionId) throw new https.HttpsError("invalid-argument", "promotionId is required.");

  const ref = db.collection("vendors").doc(vendorId).collection("promotions").doc(promotionId);
  const snap = await ref.get();
  if (!snap.exists) throw new https.HttpsError("not-found", "Promotion not found.");
  const promo = snap.data() as PromotionDoc;
  const activating = !promo.active;

  if (activating) {
    const { limits: planLimits } = await resolveEffectivePlan(vendorId);
    const activeCountSnap = await db
      .collection("vendors").doc(vendorId).collection("promotions")
      .where("active", "==", true)
      .get();
    if (activeCountSnap.size >= planLimits.activePromotionsLimit) {
      throw new https.HttpsError(
        "resource-exhausted",
        `Your plan allows up to ${planLimits.activePromotionsLimit} active promotion(s). Deactivate one before activating another.`
      );
    }
  }

  await ref.update({ active: activating, updatedAt: FieldValue.serverTimestamp() });

  await writeAuditLog({
    requestId, functionName: "togglePromotionActive", actorUid: request.auth!.uid, actorRole: "vendor", actorType: "vendor",
    targetType: "promotion", targetId: promotionId, eventType: activating ? "promotion.activated" : "promotion.deactivated", appCheck,
  });

  return { success: true, active: activating };
});

export const listVendorPromotions = https.onCall(async (request) => {
  checkAppCheck(request, "listVendorPromotions");
  const vendorId = requireVendor(request);
  const snap = await db.collection("vendors").doc(vendorId).collection("promotions").orderBy("createdAt", "desc").get();
  return { success: true, promotions: snap.docs.map((d) => d.data() as PromotionDoc) };
});
