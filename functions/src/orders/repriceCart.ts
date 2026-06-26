import { https } from "firebase-functions/v2";
import { db, FieldValue, Timestamp } from "../admin";
import { CartDoc, CartItem, CatalogItemDoc } from "../types2";
import { checkAppCheck } from "../utils/appCheck";

export const repriceCart = https.onCall(async (request) => {
  checkAppCheck(request, "repriceCart");
  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");
  const customerId = request.auth.uid;
  const { vendorId, items: clientItems, fulfillmentType, orderNote, cartId } = request.data ?? {};
  if (!vendorId) throw new https.HttpsError("invalid-argument", "vendorId is required.");
  if (!Array.isArray(clientItems) || clientItems.length === 0) throw new https.HttpsError("invalid-argument", "items array is required.");
  if (!["pickup","delivery","shipping"].includes(fulfillmentType)) throw new https.HttpsError("invalid-argument", "fulfillmentType must be pickup, delivery, or shipping.");
  const vendorRef = db.collection("vendors").doc(vendorId);
  const vendorSnap = await vendorRef.get();
  if (!vendorSnap.exists) throw new https.HttpsError("not-found", "Vendor not found.");
  if (vendorSnap.data()?.isDiscoverable !== true) throw new https.HttpsError("failed-precondition", "This vendor is not currently available.");
  const itemRefs = clientItems.map((ci: { itemId: string }) => vendorRef.collection("catalogItems").doc(ci.itemId));
  const itemSnaps = await db.getAll(...itemRefs);
  const pricedItems: CartItem[] = [];
  let subtotal = 0, totalQuantity = 0;
  for (let i = 0; i < clientItems.length; i++) {
    const ci = clientItems[i], snap = itemSnaps[i];
    if (!snap.exists) throw new https.HttpsError("not-found", `Item ${ci.itemId} not found.`);
    const item = snap.data() as CatalogItemDoc;
    if (!item.isAvailable || item.isHidden) throw new https.HttpsError("failed-precondition", `"${item.name}" is not available.`);
    if (item.isOutOfStock) throw new https.HttpsError("failed-precondition", `"${item.name}" is out of stock.`);
    const qty = Math.max(1, Math.floor(Number(ci.quantity) || 1));
    const unitPrice = item.salePrice ?? item.basePrice;
    const selectedAddOns: CartItem["selectedAddOns"] = [];
    let addOnTotal = 0;
    if (Array.isArray(ci.selectedAddOns) && Array.isArray(item.addOnGroups)) {
      for (const ca of ci.selectedAddOns) {
        const g = item.addOnGroups.find((g) => g.groupId === ca.groupId);
        if (!g) continue;
        const o = g.options.find((o) => o.optionId === ca.optionId);
        if (!o) continue;
        selectedAddOns.push({ groupId: g.groupId, groupName: g.name, optionId: o.optionId, optionName: o.name, priceModifier: o.priceModifier });
        addOnTotal += o.priceModifier;
      }
    }
    const lineTotal = (unitPrice + addOnTotal) * qty;
    subtotal += lineTotal; totalQuantity += qty;
    pricedItems.push({ itemId: item.itemId, name: item.name, basePrice: item.basePrice, salePrice: item.salePrice ?? null, quantity: qty, selectedAddOns, lineTotal });
  }
  const tax = 0, discount = 0, total = subtotal + tax - discount;
  const now = FieldValue.serverTimestamp();
  const expiresAt = Timestamp.fromMillis(Date.now() + 30 * 60 * 1000);
  const cartData: CartDoc = { cartId: cartId || "", customerId, vendorId, items: pricedItems, quantity: totalQuantity, subtotal, tax, discount, total, fulfillmentType, orderNote: orderNote ?? null, expiresAt, createdAt: now, updatedAt: now };
  let resolvedCartId = cartId;
  if (cartId) { await db.collection("carts").doc(cartId).set({ ...cartData, cartId, updatedAt: now }, { merge: false }); }
  else { const ref = db.collection("carts").doc(); resolvedCartId = ref.id; await ref.set({ ...cartData, cartId: resolvedCartId }); }
  return { success: true, cartId: resolvedCartId, subtotal, tax, discount, total, quantity: totalQuantity, items: pricedItems };
});
