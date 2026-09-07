import { https, logger } from "firebase-functions/v2";
import { firestore as functionsFirestore } from "firebase-functions/v1";
import { db, FieldValue } from "../admin";
import { CatalogItemDoc, CatalogCategoryDoc, AddOnGroup, PENDING_REVISION_DOC_ID } from "../types2";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { applyUserModerationScore, recordModerationEvent, runModerationCheck } from "../moderation/moderationEngine";
import { resolveEffectivePlan } from "../subscriptions/resolveEffectivePlan";
import { enforceRateLimit } from "../subscriptions/rateLimit";
import { resolveVendorCurrencyById } from "../vendors/vendorCurrency";

/**
 * Phase 2 — fields whose change is a customer-facing content claim and so
 * needs re-review when the item is already approved and publicly visible.
 *
 * Everything NOT on this list is treated as operational and applies
 * immediately: inventoryQuantity, lowStockThreshold, isAvailable
 * ("Available to order") and isHidden ("Show in storefront"). Those are
 * trading controls a vendor must be able to change instantly — a vendor who
 * sells out at 9am cannot wait on moderation to stop taking orders.
 */
const MATERIAL_CATALOG_FIELDS: string[] = [
  "name",
  "description",
  "categoryId",
  "basePrice",
  "salePrice",
  "photos",
  "addOnGroups",
];

/** Sale price must be a genuine discount off the regular price, and add-on
 * groups must be internally consistent — none of this was previously
 * checked, so a vendor could save a sale price above the regular price or
 * a required group with zero options. */
function validateItemPricingAndAddOns(basePrice: number, salePrice: unknown, addOnGroups: unknown): void {
  if (salePrice !== undefined && salePrice !== null) {
    if (typeof salePrice !== "number" || salePrice < 0) {
      throw new https.HttpsError("invalid-argument", "salePrice must be a non-negative number.");
    }
    if (salePrice >= basePrice) {
      throw new https.HttpsError("invalid-argument", "salePrice must be less than basePrice.");
    }
  }

  if (addOnGroups === undefined) return;
  if (!Array.isArray(addOnGroups)) {
    throw new https.HttpsError("invalid-argument", "addOnGroups must be an array.");
  }
  for (const group of addOnGroups as AddOnGroup[]) {
    if (!group.name?.trim()) {
      throw new https.HttpsError("invalid-argument", "Every add-on group needs a name.");
    }
    if (!Array.isArray(group.options) || group.options.length === 0) {
      throw new https.HttpsError("invalid-argument", `Add-on group "${group.name}" must have at least one option.`);
    }
    if (group.required && group.options.length === 0) {
      throw new https.HttpsError("invalid-argument", `Required group "${group.name}" must have at least one option.`);
    }
    if (!group.multiSelect && group.maxSelections !== undefined && group.maxSelections > 1) {
      throw new https.HttpsError("invalid-argument", `Group "${group.name}" is single-choice but maxSelections is greater than 1.`);
    }
    if (group.maxSelections !== undefined && (typeof group.maxSelections !== "number" || group.maxSelections < 1)) {
      throw new https.HttpsError("invalid-argument", `Group "${group.name}" maxSelections must be at least 1 when provided.`);
    }
    if (group.multiSelect && group.maxSelections !== undefined && group.maxSelections > group.options.length) {
      throw new https.HttpsError("invalid-argument", `Group "${group.name}" maxSelections cannot exceed its number of options.`);
    }
    for (const option of group.options) {
      if (!option.name?.trim()) {
        throw new https.HttpsError("invalid-argument", `Every option in group "${group.name}" needs a name.`);
      }
      if (typeof option.priceModifier !== "number") {
        throw new https.HttpsError("invalid-argument", `Option "${option.name}" priceModifier must be a number.`);
      }
    }
  }
}

/** Catalog-only prohibited-item check (P3-FB-021 point 7) — firearms, drugs,
 * counterfeit documents, restricted raw food, etc. must never be listed
 * regardless of wording, so unlike chat, any match here blocks outright
 * (the seeded catalog-scoped rules are all severity critical / block). */
async function rejectIfListingUnsafe(vendorId: string, actorUid: string, name: string, description?: string | null): Promise<void> {
  const text = [name, description].filter(Boolean).join(" ");
  if (!text.trim()) return;
  const result = await runModerationCheck(text, "catalog");
  if (result.status === "clean") return;
  await recordModerationEvent({
    actorUid, actorRole: "vendor", vendorId, chatId: null, messageId: null, rawText: text, result,
  });
  await applyUserModerationScore(actorUid, result.score);
  if (!result.blocked) return;
  throw new https.HttpsError("invalid-argument", "This listing contains content that is not allowed on the platform.");
}

export const createCatalogCategory = https.onCall(async (request) => {
  await enforceRateLimit(
    request.auth?.uid ?? `ip:${request.rawRequest?.ip ?? "unknown"}`,
    "createCatalogCategory",
    30,
  );
  checkAppCheck(request, "createCatalogCategory");
  if (!request.auth || request.auth.token.role !== "vendor") throw new https.HttpsError("permission-denied", "Vendors only.");
  const vendorId = request.auth.token.vendorId as string;
  const { name, description, order } = request.data ?? {};
  if (!name?.trim()) throw new https.HttpsError("invalid-argument", "name is required.");
  const now = FieldValue.serverTimestamp();
  const catRef = db.collection("vendors").doc(vendorId).collection("catalogCategories").doc();
  const cat: CatalogCategoryDoc = { categoryId: catRef.id, vendorId, name: name.trim(), description: description?.trim() ?? null, order: typeof order === "number" ? order : 0, isSystem: false, itemCount: 0, visibleItemCount: 0, createdAt: now, updatedAt: now };
  await catRef.set(cat);
  return { success: true, categoryId: catRef.id };
});

export const deleteCatalogCategory = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "deleteCatalogCategory");
  if (!request.auth || request.auth.token.role !== "vendor") throw new https.HttpsError("permission-denied", "Vendors only.");
  const vendorId = request.auth.token.vendorId as string;
  const { categoryId } = request.data ?? {};
  if (!categoryId) throw new https.HttpsError("invalid-argument", "categoryId is required.");

  const vendorRef = db.collection("vendors").doc(vendorId);
  const catRef = vendorRef.collection("catalogCategories").doc(categoryId);
  const catSnap = await catRef.get();
  if (!catSnap.exists) throw new https.HttpsError("not-found", "Category not found.");
  if (catSnap.data()?.vendorId !== vendorId) throw new https.HttpsError("permission-denied", "You do not own this category.");
  if (catSnap.data()?.isSystem) throw new https.HttpsError("failed-precondition", "This category cannot be deleted.");

  // Items in this category move to uncategorized (categoryId: null) rather
  // than being left pointing at a category that no longer exists — the same
  // reassignment the client-only scaffold this replaces always intended,
  // just never persisted anywhere.
  const itemsSnap = await vendorRef.collection("catalogItems").where("categoryId", "==", categoryId).get();
  const batch = db.batch();
  itemsSnap.docs.forEach((doc) => {
    batch.update(doc.ref, { categoryId: null, updatedAt: FieldValue.serverTimestamp() });
  });
  batch.delete(catRef);
  await batch.commit();

  await writeAuditLog({
    requestId, functionName: "deleteCatalogCategory", actorUid: request.auth.uid, actorRole: "vendor",
    actorType: "vendor", targetType: "catalogCategory", targetId: categoryId,
    eventType: "catalog.category_deleted", metadata: { reassignedItemCount: itemsSnap.size }, appCheck,
  });
  return { success: true, reassignedItemCount: itemsSnap.size };
});

export const createCatalogItem = https.onCall(async (request) => {
  await enforceRateLimit(
    request.auth?.uid ?? `ip:${request.rawRequest?.ip ?? "unknown"}`,
    "createCatalogItem",
    30,
  );
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "createCatalogItem");
  if (!request.auth || request.auth.token.role !== "vendor") throw new https.HttpsError("permission-denied", "Vendors only.");
  const vendorId = request.auth.token.vendorId as string;
  if (!vendorId) throw new https.HttpsError("failed-precondition", "No vendorId on token.");
  const { name, description, basePrice, salePrice, categoryId, photos, isAvailable, isHidden, trackInventory, inventoryQuantity, lowStockThreshold, addOnGroups } = request.data ?? {};
  if (!name || typeof name !== "string" || name.trim().length === 0) throw new https.HttpsError("invalid-argument", "name is required.");
  if (typeof basePrice !== "number" || basePrice < 0) throw new https.HttpsError("invalid-argument", "basePrice must be a non-negative number.");
  // A category is required before an item can enter moderation. Approving an
  // uncategorised item would put it live with nowhere for customers to find it
  // by browsing, and it can't be placed in a storefront section — so the
  // requirement belongs here, at submission, rather than being discovered by a
  // reviewer or (worse) surfacing publicly as "Uncategorized".
  if (!categoryId || typeof categoryId !== "string" || categoryId.trim().length === 0) {
    throw new https.HttpsError("invalid-argument", "Choose a category before submitting this item.");
  }
  validateItemPricingAndAddOns(basePrice, salePrice, addOnGroups);
  await rejectIfListingUnsafe(vendorId, request.auth.uid, name, description);

  // Phase 4: catalog/photo limits come from resolveEffectivePlan, never a
  // hardcoded constant or the legacy vendors/{vendorId}.plan field directly.
  const { limits: planLimits, plan: effectivePlan } = await resolveEffectivePlan(vendorId);
  if (Array.isArray(photos) && photos.length > planLimits.photosPerItemLimit) {
    throw new https.HttpsError("resource-exhausted", `Your ${effectivePlan} plan allows up to ${planLimits.photosPerItemLimit} photos per item.`);
  }

  const vendorRef = db.collection("vendors").doc(vendorId);
  const itemsCollRef = vendorRef.collection("catalogItems");
  const newItemRef = itemsCollRef.doc();

  // Resolved before the transaction, not inside it. The country catalogue is
  // reference data that does not need transactional consistency, and reading it
  // mid-transaction would put an unguarded read in the middle of one.
  const vendorCurrency = await resolveVendorCurrencyById(vendorId);
  await db.runTransaction(async (tx) => {
    const vendorSnap = await tx.get(vendorRef);
    if (!vendorSnap.exists) throw new https.HttpsError("not-found", "Vendor not found.");
    const limit = planLimits.catalogItemLimit;
    const currentCountSnap = await tx.get(itemsCollRef.where("isHidden", "==", false));
    if (currentCountSnap.size >= limit) throw new https.HttpsError("resource-exhausted", `Your ${effectivePlan} plan allows up to ${limit} visible catalog items.`);
    const now = FieldValue.serverTimestamp();
    const item: CatalogItemDoc = { itemId: newItemRef.id, vendorId, categoryId: categoryId ?? null, name: name.trim(), description: description?.trim() ?? null, basePrice, salePrice: salePrice ?? null, currency: vendorCurrency, photos: Array.isArray(photos) ? photos.slice(0, 10) : [], thumbnailUrl: Array.isArray(photos) && photos.length > 0 ? photos[0] : null, isAvailable: isAvailable !== false, isHidden: isHidden === true, isOutOfStock: false, inventoryQuantity: typeof inventoryQuantity === "number" ? inventoryQuantity : 0, reservedQuantity: 0, trackInventory: trackInventory === true, lowStockThreshold: typeof lowStockThreshold === "number" ? lowStockThreshold : null, addOnGroups: Array.isArray(addOnGroups) ? addOnGroups : [], orderCount: 0, moderationStatus: "pending", createdAt: now, updatedAt: now };
    tx.set(newItemRef, item);
    if (categoryId) { const catRef = vendorRef.collection("catalogCategories").doc(categoryId); tx.update(catRef, { itemCount: FieldValue.increment(1), visibleItemCount: item.isHidden ? FieldValue.increment(0) : FieldValue.increment(1), updatedAt: now }); }
  });
  await writeAuditLog({ requestId, functionName: "createCatalogItem", actorUid: request.auth.uid, actorRole: "vendor", actorType: "vendor", targetType: "catalogItem", targetId: newItemRef.id, eventType: "catalog.item_created", after: { itemId: newItemRef.id, name, basePrice }, appCheck });
  return { success: true, itemId: newItemRef.id };
});

export const updateCatalogItem = https.onCall(async (request) => {
  await enforceRateLimit(
    request.auth?.uid ?? `ip:${request.rawRequest?.ip ?? "unknown"}`,
    "updateCatalogItem",
    60,
  );
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "updateCatalogItem");
  if (!request.auth || request.auth.token.role !== "vendor") throw new https.HttpsError("permission-denied", "Vendors only.");
  const vendorId = request.auth.token.vendorId as string;
  const { itemId, ...updates } = request.data ?? {};
  if (!itemId) throw new https.HttpsError("invalid-argument", "itemId is required.");
  const itemRef = db.collection("vendors").doc(vendorId).collection("catalogItems").doc(itemId);
  const itemSnap = await itemRef.get();
  if (!itemSnap.exists) throw new https.HttpsError("not-found", "Catalog item not found.");
  if (itemSnap.data()?.vendorId !== vendorId) throw new https.HttpsError("permission-denied", "You do not own this item.");
  // hasPendingRevision and moderationNotes are server-controlled: a vendor who
  // could set them directly would be able to clear their own "under review"
  // flag, or wipe a rejection reason, and so route unreviewed edits straight to
  // customers. Moderation state is only ever set by these functions.
  const forbidden = [
    "itemId", "vendorId", "reservedQuantity", "orderCount",
    "moderationStatus", "moderationNotes", "hasPendingRevision", "createdAt",
  ];
  const safeUpdates: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(updates)) { if (!forbidden.includes(key)) safeUpdates[key] = val; }
  safeUpdates.updatedAt = FieldValue.serverTimestamp();
  if (typeof safeUpdates.basePrice === "number" && safeUpdates.basePrice < 0) throw new https.HttpsError("invalid-argument", "basePrice cannot be negative.");
  const before = itemSnap.data();
  if ("name" in updates || "description" in updates) {
    const effectiveName = typeof safeUpdates.name === "string" ? safeUpdates.name : before?.name;
    const effectiveDescription = "description" in updates ? safeUpdates.description as string | null : before?.description;
    await rejectIfListingUnsafe(vendorId, request.auth.uid, effectiveName, effectiveDescription);
  }
  if ("basePrice" in updates || "salePrice" in updates || "addOnGroups" in updates) {
    const effectiveBasePrice = typeof safeUpdates.basePrice === "number" ? safeUpdates.basePrice : before?.basePrice;
    const effectiveSalePrice = "salePrice" in updates ? safeUpdates.salePrice : before?.salePrice;
    const effectiveAddOnGroups = "addOnGroups" in updates ? safeUpdates.addOnGroups : undefined;
    validateItemPricingAndAddOns(effectiveBasePrice, effectiveSalePrice, effectiveAddOnGroups);
  }
  if (Array.isArray(safeUpdates.photos)) {
    const { limits: planLimits, plan: effectivePlan } = await resolveEffectivePlan(vendorId);
    if (safeUpdates.photos.length > planLimits.photosPerItemLimit) {
      throw new https.HttpsError("resource-exhausted", `Your ${effectivePlan} plan allows up to ${planLimits.photosPerItemLimit} photos per item.`);
    }
  }

  // ── Phase 2: pending-revision routing ──────────────────────────────────
  // Editing an item that customers can already see must not silently change
  // what they see. Material edits to an approved item are held as a pending
  // revision and the live version is left untouched; operational edits
  // (stock, visibility, availability) always apply immediately, because
  // those are day-to-day trading controls, not content claims.
  const isApproved = before?.moderationStatus === "approved";
  const materialEdits: Record<string, unknown> = {};
  const operationalEdits: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(safeUpdates)) {
    if (key === "updatedAt") continue;
    if (MATERIAL_CATALOG_FIELDS.includes(key)) materialEdits[key] = val;
    else operationalEdits[key] = val;
  }
  const hasMaterialEdit = Object.keys(materialEdits).length > 0;

  if (isApproved && hasMaterialEdit) {
    // The proposed values go into a private subcollection, never onto the item
    // itself: customers read the item document directly and Firestore rules
    // cannot hide individual fields, so storing an unreviewed edit there would
    // publish it. Only a boolean flag lives on the item.
    const revisionRef = itemRef.collection("moderation").doc(PENDING_REVISION_DOC_ID);
    const existingRevision = await revisionRef.get();
    const previousChanges = (existingRevision.data()?.changes as Record<string, unknown> | undefined) ?? {};

    const batch = db.batch();
    batch.update(itemRef, {
      ...operationalEdits,
      hasPendingRevision: true,
      updatedAt: FieldValue.serverTimestamp(),
    });
    // Editing again after a revision was refused replaces the refused edit and
    // clears the rejection note — that IS the resubmission, so a vendor never
    // has to find a separate "resubmit" button to get back in the queue.
    batch.set(revisionRef, {
      // Merge onto any still-pending edit so changing one field at a time
      // across several saves builds up one coherent revision rather than
      // each save silently discarding the last.
      changes: { ...previousChanges, ...materialEdits },
      submittedAt: FieldValue.serverTimestamp(),
      rejectionReason: null,
      status: "pending",
    });
    await batch.commit();

    await writeAuditLog({
      requestId, functionName: "updateCatalogItem", actorUid: request.auth.uid, actorRole: "vendor",
      actorType: "vendor", targetType: "catalogItem", targetId: itemId,
      eventType: "catalog.revision_submitted",
      before: { name: before?.name, basePrice: before?.basePrice },
      after: { pendingRevision: materialEdits, appliedImmediately: operationalEdits }, appCheck,
    });
    return { success: true, pendingRevision: true, appliedImmediately: Object.keys(operationalEdits) };
  }

  // Not yet approved (still pending first review, or rejected), or purely
  // operational: apply directly. A material edit to a rejected item is the
  // vendor fixing it, so it also clears the old rejection note and puts the
  // item back in the queue.
  if (before?.moderationStatus === "rejected" && hasMaterialEdit) {
    safeUpdates.moderationStatus = "pending";
    safeUpdates.moderationNotes = null;
  }

  await itemRef.update(safeUpdates);
  await writeAuditLog({ requestId, functionName: "updateCatalogItem", actorUid: request.auth.uid, actorRole: "vendor", actorType: "vendor", targetType: "catalogItem", targetId: itemId, eventType: "catalog.item_updated", before: { name: before?.name, basePrice: before?.basePrice }, after: safeUpdates, appCheck });
  return { success: true, pendingRevision: false };
});

/**
 * getCatalogItemModeration — a vendor's view of their own item's review state.
 *
 * The proposed edit and any rejection reason live in a private subcollection
 * that customers cannot read, so the vendor needs a function to get at their
 * own copy. Returns the live approved values alongside the proposed ones, since
 * the whole point of the pending-revision model is that those differ and the
 * vendor should be able to see both.
 */
export const getCatalogItemModeration = https.onCall(async (request) => {
  checkAppCheck(request, "getCatalogItemModeration");
  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string | undefined;
  if (!vendorId) throw new https.HttpsError("failed-precondition", "No vendorId on auth token.");

  const { itemId } = request.data ?? {};
  if (!itemId) throw new https.HttpsError("invalid-argument", "itemId is required.");

  const itemRef = db.collection("vendors").doc(vendorId).collection("catalogItems").doc(itemId);
  const itemSnap = await itemRef.get();
  if (!itemSnap.exists) throw new https.HttpsError("not-found", "Catalog item not found.");
  const item = itemSnap.data()!;
  // Ownership is already implied by the path, but checked explicitly so a
  // mismatched document can never leak through a malformed write elsewhere.
  if (item.vendorId !== vendorId) {
    throw new https.HttpsError("permission-denied", "You do not own this item.");
  }

  const revisionSnap = await itemRef.collection("moderation").doc(PENDING_REVISION_DOC_ID).get();
  const revision = revisionSnap.exists ? revisionSnap.data() : null;

  return {
    success: true,
    moderationStatus: item.moderationStatus,
    // Only set when the item itself was refused on first review.
    rejectionReason: item.moderationNotes ?? null,
    isVisibleToCustomers: item.moderationStatus === "approved" && item.isHidden === false,
    hasPendingRevision: Boolean(item.hasPendingRevision),
    pendingRevision: revision
      ? {
          status: revision.status,
          submittedAt: revision.submittedAt ?? null,
          rejectionReason: revision.rejectionReason ?? null,
          proposedChanges: revision.changes ?? {},
          // The values customers are still seeing while the edit is reviewed,
          // so the vendor can compare the two rather than guess.
          liveValues: Object.fromEntries(
            Object.keys((revision.changes as Record<string, unknown>) ?? {}).map((k) => [k, item[k] ?? null]),
          ),
        }
      : null,
  };
});

export const deleteCatalogItem = https.onCall(async (request) => {
  await enforceRateLimit(
    request.auth?.uid ?? `ip:${request.rawRequest?.ip ?? "unknown"}`,
    "deleteCatalogItem",
    30,
  );
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "deleteCatalogItem");
  if (!request.auth || request.auth.token.role !== "vendor") throw new https.HttpsError("permission-denied", "Vendors only.");
  const vendorId = request.auth.token.vendorId as string;
  const { itemId } = request.data ?? {};
  if (!itemId) throw new https.HttpsError("invalid-argument", "itemId is required.");
  const vendorRef = db.collection("vendors").doc(vendorId);
  const itemRef = vendorRef.collection("catalogItems").doc(itemId);
  await db.runTransaction(async (tx) => {
    const itemSnap = await tx.get(itemRef);
    if (!itemSnap.exists) throw new https.HttpsError("not-found", "Catalog item not found.");
    if (itemSnap.data()?.vendorId !== vendorId) throw new https.HttpsError("permission-denied", "You do not own this item.");
    if ((itemSnap.data()?.reservedQuantity ?? 0) > 0) throw new https.HttpsError("failed-precondition", "Cannot delete an item with active inventory reservations.");
    const categoryId = itemSnap.data()?.categoryId;
    const isHidden = itemSnap.data()?.isHidden;
    tx.delete(itemRef);
    if (categoryId) { const catRef = vendorRef.collection("catalogCategories").doc(categoryId); tx.update(catRef, { itemCount: FieldValue.increment(-1), visibleItemCount: isHidden ? FieldValue.increment(0) : FieldValue.increment(-1), updatedAt: FieldValue.serverTimestamp() }); }
  });
  await writeAuditLog({ requestId, functionName: "deleteCatalogItem", actorUid: request.auth.uid, actorRole: "vendor", actorType: "vendor", targetType: "catalogItem", targetId: itemId, eventType: "catalog.item_deleted", appCheck });
  return { success: true };
});

export const onCatalogItemWrite = functionsFirestore.document("vendors/{vendorId}/catalogItems/{itemId}").onWrite(async (change, context) => {
  const { vendorId } = context.params;
  if (!change.after.exists) return;
  const before = change.before.exists ? change.before.data() : null;
  const after = change.after.data()!;
  if (before && after.categoryId && before.categoryId === after.categoryId && before.isHidden !== after.isHidden) {
    const catRef = db.collection("vendors").doc(vendorId).collection("catalogCategories").doc(after.categoryId);
    await catRef.update({ visibleItemCount: FieldValue.increment(after.isHidden ? -1 : 1), updatedAt: FieldValue.serverTimestamp() }).catch(() => null);
  }
});
