import { https, logger } from "firebase-functions/v2";
import { db, FieldValue, Timestamp } from "../admin";
import { OrderDoc, OrderItemSnapshot, OrderVendorSnapshot, OrderCustomerSnapshot, CartDoc } from "../types2";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { getNextOrderNumber } from "./orderNumbers";
import { reserveInventory } from "../inventory/inventoryUtils";
import { writeOrderEvent } from "./orderEvents";
import { isCountryActive } from "../utils/countryAvailability";
import { canStartNewCommerce } from "../blocks/blockUtils";
import { injectOrderContext } from "../chat/injectOrderContext";
import { resolveEffectivePlan } from "../subscriptions/resolveEffectivePlan";

const SLA_HOURS = 48;

/**
 * NOTE (Phase 3 change): conversationId is NO LONGER accepted as
 * client-supplied input. Per the client's spec, the commerce thread is
 * canonical per (customerId, vendorId) and the backend derives/creates it
 * automatically via injectOrderContext — the frontend never passes a
 * chatId when placing an order.
 */

export const createOrderFromCart = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "createOrderFromCart");
  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");
  const customerId = request.auth.uid;
  const { cartId } = request.data ?? {};
  if (!cartId) throw new https.HttpsError("invalid-argument", "cartId is required.");

  const cartRef = db.collection("carts").doc(cartId);
  const cartSnap = await cartRef.get();
  if (!cartSnap.exists) throw new https.HttpsError("not-found", "Cart not found or has expired.");
  const cart = cartSnap.data() as CartDoc;
  if (cart.customerId !== customerId) throw new https.HttpsError("permission-denied", "This cart does not belong to you.");
  const cartExpiry = (cart.expiresAt as Timestamp).toMillis?.() ?? 0;
  if (cartExpiry > 0 && Date.now() > cartExpiry) throw new https.HttpsError("failed-precondition", "Cart has expired. Please rebuild your cart.");
  if (!cart.items || cart.items.length === 0) throw new https.HttpsError("failed-precondition", "Cart is empty.");

  const [vendorSnap, userSnap] = await Promise.all([db.collection("vendors").doc(cart.vendorId).get(), db.collection("users").doc(customerId).get()]);
  if (!vendorSnap.exists) throw new https.HttpsError("not-found", "Vendor not found.");
  if (!userSnap.exists) throw new https.HttpsError("not-found", "User profile not found.");
  const vendor = vendorSnap.data()!;
  const user = userSnap.data()!;
  if (!vendor.isDiscoverable) throw new https.HttpsError("failed-precondition", "This vendor is not currently accepting orders.");

  // Phase 3 additions: country availability + block check before allowing
  // new commerce (a new order is "new commerce" — no active-order
  // exception applies here, since this order doesn't exist yet).
  const countryOk = await isCountryActive(vendor.countryCode);
  if (!countryOk) {
    throw new https.HttpsError("failed-precondition", "the platform is not currently available in this vendor's region.");
  }
  const blockCheck = await canStartNewCommerce(customerId, vendor.ownerUid);
  if (!blockCheck.allowed) {
    throw new https.HttpsError("failed-precondition", "You are unable to place an order with this vendor.");
  }

  const publicOrderId = await getNextOrderNumber(cart.vendorId, vendor.slug ?? vendor.username, "internal");
  const items: OrderItemSnapshot[] = cart.items.map((ci) => ({ itemId: ci.itemId, name: ci.name, basePrice: ci.basePrice, salePrice: ci.salePrice ?? null, quantity: ci.quantity, selectedAddOns: ci.selectedAddOns, lineTotal: ci.lineTotal }));
  const vendorSnapshot: OrderVendorSnapshot = { vendorId: vendor.vendorId, name: vendor.name, username: vendor.username, slug: vendor.slug ?? vendor.username, phone: vendor.phone ?? null, email: vendor.email ?? null, area: vendor.area ?? null, state: vendor.state ?? null, country: vendor.country ?? null };
  const fullName: string = user.profile?.fullName ?? user.displayName ?? "Customer";
  const parts = fullName.trim().split(/\s+/);
  const displayName = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
  const customerSnapshot: OrderCustomerSnapshot = { customerId, displayName, photoURL: user.photoURL ?? null };
  const now = FieldValue.serverTimestamp();
  const acceptanceDeadlineAt = Timestamp.fromMillis(Date.now() + SLA_HOURS * 60 * 60 * 1000);
  const orderRef = db.collection("orders").doc();

  // conversationId is deterministic — computed the same way
  // createCommerceConversation / injectOrderContext compute it, so it's
  // stable and resolvable even before the thread doc is guaranteed to exist.
  const conversationId = `commerce_${customerId}_${cart.vendorId}`;

  const orderDoc: OrderDoc & { conversationId: string } = {
    orderId: orderRef.id, publicOrderId, vendorId: cart.vendorId, customerId, linkedCustomerId: null,
    orderSource: "internal", conversationId, createdByVendor: false,
    externalCustomerName: null, externalCustomerPhone: null,
    status: "requested", paymentStatus: "UNPAID", fulfillmentType: cart.fulfillmentType,
    orderNote: cart.orderNote ?? null, items,
    orderSnapshot: { subtotal: cart.subtotal, tax: cart.tax, discount: cart.discount, total: cart.total, currency: "NGN" },
    vendorSnapshot, customerSnapshot, acceptanceDeadlineAt,
    acceptedAt: null, rejectedAt: null, completedAt: null, cancelledAt: null, expiredAt: null,
    createdAt: now, updatedAt: now,
  };

  try {
    await db.runTransaction(async (tx) => { await reserveInventory(tx, cart.vendorId, orderRef.id, items); tx.set(orderRef, orderDoc); tx.delete(cartRef); });
  } catch (err: any) {
    if (err.message?.startsWith("INVENTORY_INSUFFICIENT:")) { const p = err.message.split(":"); throw new https.HttpsError("failed-precondition", `"${p[2]}" does not have enough stock (requested: ${p[3]?.split("=")[1]}, available: ${p[4]?.split("=")[1]}).`); }
    throw err;
  }

  await writeOrderEvent({ orderId: orderRef.id, vendorId: cart.vendorId, eventType: "ORDER_CREATED", actorUid: customerId, actorRole: "customer", after: { status: "requested", publicOrderId } });

  // Phase 3: inject order_context into the canonical commerce thread —
  // creates the thread if it doesn't already exist (e.g. customer placed
  // an order via a flow that skipped the pre-order chat step).
  await injectOrderContext({
    orderId: orderRef.id,
    publicOrderId,
    vendorId: cart.vendorId,
    vendorOwnerUid: vendor.ownerUid,
    vendorName: vendor.name,
    customerId,
    customerName: displayName,
    status: "requested",
    total: cart.total,
    currency: "NGN",
  }).catch((err) => logger.error(`injectOrderContext failed for order ${orderRef.id}`, err));

  await writeAuditLog({ requestId, functionName: "createOrderFromCart", actorUid: customerId, actorRole: "customer", actorType: "customer", targetType: "order", targetId: orderRef.id, eventType: "order.created", after: { orderId: orderRef.id, publicOrderId, total: cart.total }, appCheck });
  logger.info(`Order ${publicOrderId} created by customer ${customerId}`);
  return { success: true, orderId: orderRef.id, publicOrderId, conversationId };
});

export const createExternalOrder = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "createExternalOrder");
  if (!request.auth || request.auth.token.role !== "vendor") throw new https.HttpsError("permission-denied", "Only vendors can create external orders.");
  const vendorId = request.auth.token.vendorId as string;
  const { externalCustomerName, externalCustomerPhone, items: rawItems, fulfillmentType, orderNote } = request.data ?? {};
  if (!externalCustomerName?.trim()) throw new https.HttpsError("invalid-argument", "externalCustomerName is required.");
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new https.HttpsError("invalid-argument", "items is required.");

  // Phase 4 gate: recording orders placed outside the app is a paid feature
  // (Basic cannot). Platform orders via createOrderFromCart are unaffected.
  const { limits: planLimits } = await resolveEffectivePlan(vendorId);
  if (!planLimits.canAccessExternalOrders) {
    throw new https.HttpsError("permission-denied", "External order recording is not available on your current plan.");
  }

  const vendorSnap = await db.collection("vendors").doc(vendorId).get();
  if (!vendorSnap.exists) throw new https.HttpsError("not-found", "Vendor not found.");
  const vendor = vendorSnap.data()!;

  const itemRefs = rawItems.map((i: { itemId: string }) => vendorSnap.ref.collection("catalogItems").doc(i.itemId));
  const itemSnaps = await db.getAll(...itemRefs);
  const items: OrderItemSnapshot[] = [];
  let subtotal = 0;
  for (let i = 0; i < rawItems.length; i++) {
    const snap = itemSnaps[i], raw = rawItems[i];
    if (!snap.exists) throw new https.HttpsError("not-found", `Item ${raw.itemId} not found.`);
    const item = snap.data()!;
    const qty = Math.max(1, Number(raw.quantity) || 1);
    const lineTotal = (item.salePrice ?? item.basePrice) * qty;
    subtotal += lineTotal;
    items.push({ itemId: item.itemId, name: item.name, basePrice: item.basePrice, salePrice: item.salePrice ?? null, quantity: qty, lineTotal });
  }

  const publicOrderId = await getNextOrderNumber(vendorId, vendor.slug ?? vendor.username, "external");
  const now = FieldValue.serverTimestamp();
  const orderRef = db.collection("orders").doc();

  // External orders use a placeholder customerId (ext_{orderId}), so they
  // do NOT participate in the canonical commerce-thread model the same
  // way — there is no real customer uid to key a thread on unless
  // linkedCustomerId is set. For MVP, external orders get order_context
  // injected into a synthetic per-order thread rather than a persistent
  // customer-vendor thread, since there's no authenticated customer to
  // link to. This is a known simplification, documented for the client.
  const conversationId = `external_${orderRef.id}`;

  const orderDoc: OrderDoc & { conversationId: string } = {
    orderId: orderRef.id, publicOrderId, vendorId, customerId: `ext_${orderRef.id}`, linkedCustomerId: null,
    orderSource: "external", conversationId, createdByVendor: true,
    externalCustomerName: externalCustomerName.trim(), externalCustomerPhone: externalCustomerPhone?.trim() ?? null,
    status: "requested", paymentStatus: "UNPAID", fulfillmentType: fulfillmentType ?? "pickup",
    orderNote: orderNote ?? null, items,
    orderSnapshot: { subtotal, tax: 0, discount: 0, total: subtotal, currency: "NGN" },
    vendorSnapshot: { vendorId, name: vendor.name, username: vendor.username, slug: vendor.slug ?? vendor.username },
    customerSnapshot: { customerId: `ext_${orderRef.id}`, displayName: externalCustomerName.trim(), photoURL: null },
    acceptanceDeadlineAt: Timestamp.fromMillis(Date.now() + 48 * 60 * 60 * 1000),
    acceptedAt: null, rejectedAt: null, completedAt: null, cancelledAt: null, expiredAt: null,
    createdAt: now, updatedAt: now,
  };

  await db.runTransaction(async (tx) => { await reserveInventory(tx, vendorId, orderRef.id, items); tx.set(orderRef, orderDoc); });
  await writeOrderEvent({ orderId: orderRef.id, vendorId, eventType: "ORDER_CREATED", actorUid: request.auth!.uid, actorRole: "vendor", after: { publicOrderId, orderSource: "external" } });
  await writeAuditLog({ requestId, functionName: "createExternalOrder", actorUid: request.auth!.uid, actorRole: "vendor", actorType: "vendor", targetType: "order", targetId: orderRef.id, eventType: "order.external_created", after: { orderId: orderRef.id, publicOrderId }, appCheck });
  return { success: true, orderId: orderRef.id, publicOrderId, conversationId };
});
