import { https, logger } from "firebase-functions/v2";
import { firestore as functionsFirestore } from "firebase-functions/v1";
import { db, FieldValue } from "../admin";
import { CatalogItemDoc, CatalogCategoryDoc, PLAN_CATALOG_LIMITS } from "../types2";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";

export const createCatalogCategory = https.onCall(async (request) => {
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

export const createCatalogItem = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "createCatalogItem");
  if (!request.auth || request.auth.token.role !== "vendor") throw new https.HttpsError("permission-denied", "Vendors only.");
  const vendorId = request.auth.token.vendorId as string;
  if (!vendorId) throw new https.HttpsError("failed-precondition", "No vendorId on token.");
  const { name, description, basePrice, salePrice, currency, categoryId, photos, isAvailable, isHidden, trackInventory, inventoryQuantity, lowStockThreshold, addOnGroups } = request.data ?? {};
  if (!name || typeof name !== "string" || name.trim().length === 0) throw new https.HttpsError("invalid-argument", "name is required.");
  if (typeof basePrice !== "number" || basePrice < 0) throw new https.HttpsError("invalid-argument", "basePrice must be a non-negative number.");
  const vendorRef = db.collection("vendors").doc(vendorId);
  const itemsCollRef = vendorRef.collection("catalogItems");
  const newItemRef = itemsCollRef.doc();
  await db.runTransaction(async (tx) => {
    const vendorSnap = await tx.get(vendorRef);
    if (!vendorSnap.exists) throw new https.HttpsError("not-found", "Vendor not found.");
    const plan: string = vendorSnap.data()?.plan ?? "basic";
    const limit = PLAN_CATALOG_LIMITS[plan] ?? 10;
    const currentCountSnap = await tx.get(itemsCollRef.where("isHidden", "==", false));
    if (currentCountSnap.size >= limit) throw new https.HttpsError("resource-exhausted", `Your ${plan} plan allows up to ${limit} visible catalog items.`);
    const now = FieldValue.serverTimestamp();
    const item: CatalogItemDoc = { itemId: newItemRef.id, vendorId, categoryId: categoryId ?? null, name: name.trim(), description: description?.trim() ?? null, basePrice, salePrice: salePrice ?? null, currency: currency ?? "NGN", photos: Array.isArray(photos) ? photos.slice(0, 10) : [], thumbnailUrl: Array.isArray(photos) && photos.length > 0 ? photos[0] : null, isAvailable: isAvailable !== false, isHidden: isHidden === true, isOutOfStock: false, inventoryQuantity: typeof inventoryQuantity === "number" ? inventoryQuantity : 0, reservedQuantity: 0, trackInventory: trackInventory === true, lowStockThreshold: typeof lowStockThreshold === "number" ? lowStockThreshold : null, addOnGroups: Array.isArray(addOnGroups) ? addOnGroups : [], orderCount: 0, moderationStatus: "pending", createdAt: now, updatedAt: now };
    tx.set(newItemRef, item);
    if (categoryId) { const catRef = vendorRef.collection("catalogCategories").doc(categoryId); tx.update(catRef, { itemCount: FieldValue.increment(1), visibleItemCount: item.isHidden ? FieldValue.increment(0) : FieldValue.increment(1), updatedAt: now }); }
  });
  await writeAuditLog({ requestId, functionName: "createCatalogItem", actorUid: request.auth.uid, actorRole: "vendor", actorType: "vendor", targetType: "catalogItem", targetId: newItemRef.id, eventType: "catalog.item_created", after: { itemId: newItemRef.id, name, basePrice }, appCheck });
  return { success: true, itemId: newItemRef.id };
});

export const updateCatalogItem = https.onCall(async (request) => {
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
  const forbidden = ["itemId", "vendorId", "reservedQuantity", "orderCount", "moderationStatus", "createdAt"];
  const safeUpdates: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(updates)) { if (!forbidden.includes(key)) safeUpdates[key] = val; }
  safeUpdates.updatedAt = FieldValue.serverTimestamp();
  if (typeof safeUpdates.basePrice === "number" && safeUpdates.basePrice < 0) throw new https.HttpsError("invalid-argument", "basePrice cannot be negative.");
  const before = itemSnap.data();
  await itemRef.update(safeUpdates);
  await writeAuditLog({ requestId, functionName: "updateCatalogItem", actorUid: request.auth.uid, actorRole: "vendor", actorType: "vendor", targetType: "catalogItem", targetId: itemId, eventType: "catalog.item_updated", before: { name: before?.name, basePrice: before?.basePrice }, after: safeUpdates, appCheck });
  return { success: true };
});

export const deleteCatalogItem = https.onCall(async (request) => {
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
