import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { CatalogItemDoc, OrderDoc, OrderItemSnapshot, OrderStatus } from "../types2";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { releaseInventory, adjustInventoryAfterOrder } from "../inventory/inventoryUtils";
import { writeOrderEvent } from "./orderEvents";
import { isOrderTerminal } from "./orderStatus";
import { generateReceiptInternal } from "../receipts/receiptFunctions";
import { createNotificationInternal } from "../notifications/notificationFunctions";


// accepted -> cancelled added: the mobile app has a dedicated vendor "cancel
// order" flow (reason codes, its own modal) distinct from reject, but the
// server never had a legal transition for it. The client-side optimistic
// update let a vendor "cancel" an accepted order, the illegal backend call
// silently failed, and the next Firestore snapshot just reverted the status
// with no error ever shown.
const VENDOR_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = { requested: ["accepted","rejected"], accepted: ["in_progress","rejected","cancelled"], in_progress: ["completed"] };
const CUSTOMER_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = { requested: ["cancelled"], accepted: ["cancelled"] };

/**
 * Re-derives each proposed change-request item's price from the live catalog,
 * the same way repriceCart.ts does for a fresh cart. handleChangeRequest used
 * to accept whatever lineTotal the vendor put in proposedChanges.items
 * verbatim - the one place in the pricing pipeline that trusted a
 * client-supplied number instead of recomputing it server-side. Quantity and
 * selected add-on choices are the vendor's real intent and are kept; only the
 * price math is recomputed, from the catalog, not from what was submitted.
 */
async function repriceProposedItems(
  vendorId: string,
  proposedItems: Array<{ itemId: string; quantity: number; selectedAddOns?: { groupId: string; optionId: string }[] }>
): Promise<OrderItemSnapshot[]> {
  const vendorRef = db.collection("vendors").doc(vendorId);
  const itemRefs = proposedItems.map((pi) => vendorRef.collection("catalogItems").doc(pi.itemId));
  const itemSnaps = await db.getAll(...itemRefs);

  const repriced: OrderItemSnapshot[] = [];
  for (let i = 0; i < proposedItems.length; i++) {
    const pi = proposedItems[i];
    const snap = itemSnaps[i];
    if (!snap.exists) throw new https.HttpsError("not-found", `Item ${pi.itemId} no longer exists.`);
    const item = snap.data() as CatalogItemDoc;
    if (!item.isAvailable || item.isHidden) throw new https.HttpsError("failed-precondition", `"${item.name}" is no longer available.`);
    if (item.moderationStatus !== "approved") throw new https.HttpsError("failed-precondition", `"${item.name}" is no longer available.`);

    const qty = Math.max(1, Math.floor(Number(pi.quantity) || 1));
    const unitPrice = item.salePrice ?? item.basePrice;
    const selectedAddOns: NonNullable<OrderItemSnapshot["selectedAddOns"]> = [];
    let addOnTotal = 0;
    if (Array.isArray(pi.selectedAddOns) && Array.isArray(item.addOnGroups)) {
      for (const sa of pi.selectedAddOns) {
        const g = item.addOnGroups.find((g) => g.groupId === sa.groupId);
        if (!g) continue;
        const o = g.options.find((o) => o.optionId === sa.optionId);
        if (!o) continue;
        selectedAddOns.push({ groupId: g.groupId, groupName: g.name, optionId: o.optionId, optionName: o.name, priceModifier: o.priceModifier });
        addOnTotal += o.priceModifier;
      }
    }
    const lineTotal = (unitPrice + addOnTotal) * qty;
    repriced.push({ itemId: item.itemId, name: item.name, basePrice: item.basePrice, salePrice: item.salePrice ?? null, quantity: qty, selectedAddOns, lineTotal });
  }
  return repriced;
}

export const updateOrderStatus = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "updateOrderStatus");
  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");
  const { orderId, newStatus, reason } = request.data ?? {};
  if (!orderId) throw new https.HttpsError("invalid-argument", "orderId is required.");
  if (!newStatus) throw new https.HttpsError("invalid-argument", "newStatus is required.");
  const orderRef = db.collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw new https.HttpsError("not-found", "Order not found.");
  const order = orderSnap.data() as OrderDoc;
  const role = request.auth.token.role as string;
  const uid = request.auth.uid;
  const vendorId = request.auth.token.vendorId as string | undefined;
  if (role === "vendor") {
    if (order.vendorId !== vendorId) throw new https.HttpsError("permission-denied", "This order does not belong to your store.");
    if (!(VENDOR_TRANSITIONS[order.status] ?? []).includes(newStatus as OrderStatus)) throw new https.HttpsError("failed-precondition", `Vendors cannot transition from "${order.status}" to "${newStatus}".`);
  } else if (role === "customer") {
    if (order.customerId !== uid) throw new https.HttpsError("permission-denied", "This is not your order.");
    if (!(CUSTOMER_TRANSITIONS[order.status] ?? []).includes(newStatus as OrderStatus)) throw new https.HttpsError("failed-precondition", `You cannot change this order from "${order.status}" to "${newStatus}".`);
  } else { throw new https.HttpsError("permission-denied", "Insufficient permissions."); }
  const now = FieldValue.serverTimestamp();
  const ts: Record<string, unknown> = {};
  if (newStatus === "accepted") ts.acceptedAt = now;
  if (newStatus === "rejected") {
    ts.rejectedAt = now;
    // Already used for the push notification body and the order-events log
    // below; the order document itself never got it, so the customer's own
    // order detail screen (which reads rejectionReason directly) could never
    // show why once the notification was gone.
    if (typeof reason === "string" && reason.trim()) ts.rejectionReason = reason.trim();
  }
  if (newStatus === "completed") ts.completedAt = now;
  if (newStatus === "cancelled") {
    ts.cancelledAt = now;
    if (typeof reason === "string" && reason.trim()) ts.cancellationReason = reason.trim();
  }
  // The status write is a compare-and-set rather than a blind update. The guard
  // above read the order, then decided; without this, two calls arriving
  // together could both read "in_progress", both pass the guard, and both go on
  // to complete the order, incrementing the sales counter twice for one sale.
  // The state machine prevents that happening in sequence, not in parallel.
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(orderRef);
    if (fresh.data()?.status !== order.status) {
      throw new https.HttpsError(
        "aborted",
        "This order changed while your request was in flight. Reload and try again."
      );
    }
    tx.update(orderRef, { status: newStatus, ...ts, updatedAt: now });
  });

  if (isOrderTerminal(newStatus) && newStatus !== "completed") await releaseInventory(order.vendorId, orderId, order.items, `order_${newStatus}`);
  if (newStatus === "completed") {
    // Independent of each other — the receipt is generated from the order
    // snapshot already in hand, not from post-adjustment inventory state —
    // so run together instead of one after another.
    await Promise.all([
      // External orders move stock but do not count as sales: the vendor
      // typed them in, so counting them would let a vendor manufacture
      // their own Popular tag.
      adjustInventoryAfterOrder(order.vendorId, order.items, order.orderSource === "internal"),
      generateReceiptInternal(orderId, order),
    ]);
  }

  // Named as an expected notification trigger in the Phase 3 spec alongside
  // onMessageCreate and verification decisions, but never actually wired —
  // a vendor accepting, rejecting, or completing an order never notified the
  // customer, and a customer cancelling never notified the vendor. Skipped
  // for external orders' synthetic customerId the same way
  // expireStaleOrders.ts does, since there is no real users/{uid} document
  // behind it.
  if (role === "vendor" && order.orderSource === "internal") {
    const statusCopy: Partial<Record<OrderStatus, { title: string; body: string; isCritical: boolean }>> = {
      accepted: {
        title: "Order accepted",
        body: `${order.vendorSnapshot.name} accepted your order and will get started.`,
        isCritical: true,
      },
      rejected: {
        title: "Order declined",
        body: reason
          ? `${order.vendorSnapshot.name} declined your order: ${reason}`
          : `${order.vendorSnapshot.name} wasn't able to accept your order.`,
        isCritical: true,
      },
      in_progress: {
        title: "Order in progress",
        body: `${order.vendorSnapshot.name} is now preparing your order.`,
        isCritical: false,
      },
      completed: {
        title: "Order completed",
        body: `${order.vendorSnapshot.name} marked your order as complete.`,
        isCritical: false,
      },
      cancelled: {
        title: "Order cancelled",
        body: reason
          ? `${order.vendorSnapshot.name} cancelled your order: ${reason}`
          : `${order.vendorSnapshot.name} cancelled your order.`,
        isCritical: true,
      },
    };
    const copy = statusCopy[newStatus as OrderStatus];
    if (copy) {
      await createNotificationInternal({
        recipientUid: order.customerId,
        recipientRole: "customer",
        vendorId: order.vendorId,
        customerId: order.customerId,
        type: `order_${newStatus}`,
        domain: "order",
        title: copy.title,
        body: copy.body,
        deepLink: `platform://chat/${order.conversationId}`,
        metadata: { orderId },
        isCritical: copy.isCritical,
      });
    }
  } else if (role === "customer" && newStatus === "cancelled") {
    const vendorSnap = await db.collection("vendors").doc(order.vendorId).get();
    const vendorOwnerUid = vendorSnap.data()?.ownerUid as string | undefined;
    if (vendorOwnerUid) {
      await createNotificationInternal({
        recipientUid: vendorOwnerUid,
        recipientRole: "vendor",
        vendorId: order.vendorId,
        customerId: order.customerId,
        type: "order_cancelled",
        domain: "order",
        title: "Order cancelled",
        body: `${order.customerSnapshot.displayName} cancelled their order.`,
        deepLink: `platform://chat/${order.conversationId}`,
        metadata: { orderId },
        isCritical: false,
      });
    }
  }

  // Two independent log writes to different collections — run together.
  await Promise.all([
    writeOrderEvent({ orderId, vendorId: order.vendorId, eventType: "STATUS_CHANGED", actorUid: uid, actorRole: role, before: { status: order.status }, after: { status: newStatus }, metadata: reason ? { reason } : undefined }),
    writeAuditLog({ requestId, functionName: "updateOrderStatus", actorUid: uid, actorRole: role as any, actorType: role === "vendor" ? "vendor" : "customer", targetType: "order", targetId: orderId, eventType: `order.${newStatus}`, before: { status: order.status }, after: { status: newStatus }, appCheck }),
  ]);
  return { success: true, orderId, newStatus };
});

export const handleChangeRequest = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "handleChangeRequest");
  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const role = request.auth.token.role as string;
  const { orderId, action, proposedChanges, message, changeRequestId, customerItems } = request.data ?? {};
  if (!orderId) throw new https.HttpsError("invalid-argument", "orderId is required.");
  const orderRef = db.collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw new https.HttpsError("not-found", "Order not found.");
  const order = orderSnap.data() as OrderDoc;
  if (order.status !== "requested") throw new https.HttpsError("failed-precondition", "Change requests are only allowed on 'requested' orders.");
  if (action === "create") {
    if (role !== "vendor" || order.vendorId !== request.auth.token.vendorId) throw new https.HttpsError("permission-denied", "Only the vendor can propose changes.");
    if (!message?.trim()) throw new https.HttpsError("invalid-argument", "A message is required.");
    const crRef = orderRef.collection("changeRequests").doc();
    await crRef.set({ changeRequestId: crRef.id, orderId, vendorId: order.vendorId, status: "PENDING", proposedChanges: proposedChanges ?? {}, message: message.trim(), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return { success: true, changeRequestId: crRef.id };
  }
  if (action === "accept" || action === "reject") {
    if (role !== "customer" || order.customerId !== uid) throw new https.HttpsError("permission-denied", "Only the customer can respond.");
    if (!changeRequestId) throw new https.HttpsError("invalid-argument", "changeRequestId is required.");
    const crRef = orderRef.collection("changeRequests").doc(changeRequestId);
    const crSnap = await crRef.get();
    if (!crSnap.exists) throw new https.HttpsError("not-found", "Change request not found.");
    if (crSnap.data()?.status !== "PENDING") throw new https.HttpsError("failed-precondition", "Change request is no longer pending.");
    const newStatus = action === "accept" ? "ACCEPTED" : "REJECTED";
    // The customer's own review screen lets them further adjust quantities
    // or remove items from what the vendor proposed before accepting -
    // customerItems, when sent, is that final list and wins over the
    // vendor's original proposedChanges.items. Neither is trusted for price;
    // repriceProposedItems re-derives everything from the live catalog
    // either way, same as every other order-pricing path in this app.
    const proposedItems = Array.isArray(customerItems) ? customerItems : crSnap.data()?.proposedChanges?.items;

    let newSnapshot: OrderDoc["orderSnapshot"] | undefined;
    let repricedItems: OrderItemSnapshot[] | undefined;
    if (action === "accept" && Array.isArray(proposedItems)) {
      repricedItems = await repriceProposedItems(order.vendorId, proposedItems);
      const newSubtotal = repricedItems.reduce((sum, item) => sum + item.lineTotal, 0);
      const { tax, discount, currency } = order.orderSnapshot;
      newSnapshot = { subtotal: newSubtotal, tax, discount, total: newSubtotal + tax - discount, currency };
    }

    const batch = db.batch();
    batch.update(crRef, { status: newStatus, updatedAt: FieldValue.serverTimestamp() });
    if (newSnapshot && repricedItems) {
      batch.update(orderRef, { items: repricedItems, orderSnapshot: newSnapshot, updatedAt: FieldValue.serverTimestamp() });
    }
    await batch.commit();

    await writeOrderEvent({
      orderId, vendorId: order.vendorId, eventType: action === "accept" ? "CHANGE_REQUEST_ACCEPTED" : "CHANGE_REQUEST_DECLINED",
      actorUid: uid, actorRole: role,
      before: { items: order.items, orderSnapshot: order.orderSnapshot },
      after: newSnapshot ? { items: repricedItems, orderSnapshot: newSnapshot } : undefined,
    });

    return { success: true, status: newStatus };
  }
  throw new https.HttpsError("invalid-argument", "action must be 'create', 'accept', or 'reject'.");
});
