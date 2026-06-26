import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { OrderDoc, OrderStatus } from "../types2";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { releaseInventory, adjustInventoryAfterOrder } from "../inventory/inventoryUtils";
import { writeOrderEvent } from "./orderEvents";
import { generateReceiptInternal } from "../receipts/receiptFunctions";

const VENDOR_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = { requested: ["accepted","rejected"], accepted: ["in_progress","rejected"], in_progress: ["completed"] };
const CUSTOMER_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = { requested: ["cancelled"], accepted: ["cancelled"] };

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
  if (newStatus === "rejected") ts.rejectedAt = now;
  if (newStatus === "completed") ts.completedAt = now;
  if (newStatus === "cancelled") ts.cancelledAt = now;
  await orderRef.update({ status: newStatus, ...ts, updatedAt: now });
  if (["rejected","cancelled","expired"].includes(newStatus)) await releaseInventory(order.vendorId, orderId, order.items, `order_${newStatus}`);
  if (newStatus === "completed") { await adjustInventoryAfterOrder(order.vendorId, order.items); await generateReceiptInternal(orderId, order); }
  await writeOrderEvent({ orderId, vendorId: order.vendorId, eventType: "STATUS_CHANGED", actorUid: uid, actorRole: role, before: { status: order.status }, after: { status: newStatus }, metadata: reason ? { reason } : undefined });
  await writeAuditLog({ requestId, functionName: "updateOrderStatus", actorUid: uid, actorRole: role as any, actorType: role === "vendor" ? "vendor" : "customer", targetType: "order", targetId: orderId, eventType: `order.${newStatus}`, before: { status: order.status }, after: { status: newStatus }, appCheck });
  return { success: true, orderId, newStatus };
});

export const handleChangeRequest = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "handleChangeRequest");
  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const role = request.auth.token.role as string;
  const { orderId, action, proposedChanges, message, changeRequestId } = request.data ?? {};
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
    const batch = db.batch();
    batch.update(crRef, { status: newStatus, updatedAt: FieldValue.serverTimestamp() });
    if (action === "accept" && crSnap.data()?.proposedChanges?.items) batch.update(orderRef, { items: crSnap.data()!.proposedChanges.items, updatedAt: FieldValue.serverTimestamp() });
    await batch.commit();
    return { success: true, status: newStatus };
  }
  throw new https.HttpsError("invalid-argument", "action must be 'create', 'accept', or 'reject'.");
});
