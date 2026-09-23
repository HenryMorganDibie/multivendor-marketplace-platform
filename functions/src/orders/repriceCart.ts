import { https } from "firebase-functions/v2";
import { isCountryActive } from "../utils/countryAvailability";
import { db, FieldValue, Timestamp } from "../admin";
import { CartDoc, CartItem, CatalogItemDoc } from "../types2";
import { checkAppCheck } from "../utils/appCheck";
import { evaluateBestPromotion } from "../catalog/evaluatePromotions";

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
  const vendorData = vendorSnap.data() ?? {};
  // Checked here as well as at order creation, so a customer is told before
  // they fill a basket rather than after.
  const countryOk = await isCountryActive(vendorSnap.data()?.countryCode);
  if (!countryOk) throw new https.HttpsError("failed-precondition", "Platform is not currently available in this country.");

  // fulfillmentTypes is now the authoritative list of methods a vendor has
  // actually enabled (updateVendorSettings.ts). A vendor whose array is
  // empty/missing has simply never configured it yet through the real
  // settings screen — every existing vendor is in this state today, since
  // the writer for this field did not exist until now — so that case is
  // treated as "not yet configured, do not restrict" rather than rejecting
  // every legacy checkout. Once a vendor has configured at least one
  // method, only that vendor's own enabled methods are accepted.
  const vendorFulfillmentTypes = Array.isArray(vendorData.fulfillmentTypes)
    ? (vendorData.fulfillmentTypes as string[])
    : [];
  if (vendorFulfillmentTypes.length > 0 && !vendorFulfillmentTypes.includes(fulfillmentType)) {
    throw new https.HttpsError(
      "failed-precondition",
      "This vendor does not currently offer that fulfillment method."
    );
  }
  const itemRefs = clientItems.map((ci: { itemId: string }) => vendorRef.collection("catalogItems").doc(ci.itemId));
  const itemSnaps = await db.getAll(...itemRefs);
  const pricedItems: CartItem[] = [];
  let subtotal = 0, totalQuantity = 0;
  for (let i = 0; i < clientItems.length; i++) {
    const ci = clientItems[i], snap = itemSnaps[i];
    if (!snap.exists) throw new https.HttpsError("not-found", `Item ${ci.itemId} not found.`);
    const item = snap.data() as CatalogItemDoc;
    if (!item.isAvailable || item.isHidden) throw new https.HttpsError("failed-precondition", `"${item.name}" is not available.`);
    // Moderation gate: an item still under review, or one that was rejected,
    // must not be orderable. The Firestore read rule already hides these from
    // browsing, but cart pricing runs server-side with admin privileges and so
    // bypasses rules entirely — without this check a stale or hand-crafted
    // cart payload could order unreviewed content at a price nobody approved.
    if (item.moderationStatus !== "approved") {
      throw new https.HttpsError("failed-precondition", `"${item.name}" is not available.`);
    }
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
  // Minimum Order Amount - the setting already saved to the vendor document
  // (updateVendorSettings.ts, Phase 4), but nothing ever read it back; a cart
  // below the vendor's stated minimum priced and checked out with no
  // rejection. Checked against the raw item subtotal, before any promotion
  // discount, so a promo code can't be used to duck under a vendor's own floor.
  const minimumOrderAmount = vendorData.minimumOrderAmount as number | undefined;
  if (typeof minimumOrderAmount === "number" && minimumOrderAmount > 0 && subtotal < minimumOrderAmount) {
    throw new https.HttpsError(
      "failed-precondition",
      `This vendor requires a minimum order of ${minimumOrderAmount}.`
    );
  }
  const cartItemIds = pricedItems.map((i) => i.itemId);
  const cartItemQuantities: Record<string, number> = {};
  for (const i of pricedItems) cartItemQuantities[i.itemId] = (cartItemQuantities[i.itemId] ?? 0) + i.quantity;
  const bestPromotion = await evaluateBestPromotion(vendorId, subtotal, cartItemIds, cartItemQuantities);

  // Tax - Phase 2's Trusted Pricing Rules ("Backend computes: item price,
  // discounts, tax, delivery fees") and the repriceCart response contract in
  // frontend-contracts.md both name tax as a backend-computed field. It was
  // never implemented; this was hardcoded to 0 regardless of the vendor's
  // Collect Tax / Tax % settings. Applied to the post-discount amount, matching
  // that same sentence's listed order (discounts, then tax) and standard
  // practice — tax is owed on what the customer actually pays.
  const discount = bestPromotion?.discountAmount ?? 0;
  const taxableAmount = Math.max(0, subtotal - discount);
  const taxEnabled = vendorData.taxEnabled === true;
  const taxRate = typeof vendorData.taxRate === "number" ? vendorData.taxRate : 0;
  const tax = taxEnabled && taxRate > 0 ? Math.round(taxableAmount * (taxRate / 100)) : 0;
  const total = subtotal + tax - discount;
  const now = FieldValue.serverTimestamp();
  const expiresAt = Timestamp.fromMillis(Date.now() + 30 * 60 * 1000);
  const appliedPromotion = bestPromotion ? { promotionId: bestPromotion.promotionId, title: bestPromotion.title, discountAmount: bestPromotion.discountAmount } : null;
  const cartData: CartDoc = { cartId: cartId || "", customerId, vendorId, items: pricedItems, quantity: totalQuantity, subtotal, tax, discount, total, fulfillmentType, orderNote: orderNote ?? null, expiresAt, createdAt: now, updatedAt: now, appliedPromotion };
  let resolvedCartId = cartId;
  if (cartId) { await db.collection("carts").doc(cartId).set({ ...cartData, cartId, updatedAt: now }, { merge: false }); }
  else { const ref = db.collection("carts").doc(); resolvedCartId = ref.id; await ref.set({ ...cartData, cartId: resolvedCartId }); }
  return { success: true, cartId: resolvedCartId, subtotal, tax, discount, total, quantity: totalQuantity, items: pricedItems, appliedPromotion };
});
