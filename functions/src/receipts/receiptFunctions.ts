import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { OrderDoc, ReceiptDoc } from "../types2";
import { checkAppCheck } from "../utils/appCheck";
import { getNextReceiptNumber } from "../orders/orderNumbers";
import { writeOrderEvent } from "../orders/orderEvents";
export async function generateReceiptInternal(orderId: string, order: OrderDoc): Promise<string> {
  const vendorSnap = await db.collection("vendors").doc(order.vendorId).get();
  const vendor = vendorSnap.data()!;
  const receiptNumber = await getNextReceiptNumber(order.vendorId, vendor.slug ?? vendor.username);
  const receiptRef = db.collection("orders").doc(orderId).collection("receipts").doc();
  const receipt: ReceiptDoc = { receiptId: receiptRef.id, receiptNumber, orderId, vendorId: order.vendorId, customerId: order.customerId, items: order.items, subtotal: order.orderSnapshot.subtotal, tax: order.orderSnapshot.tax, discount: order.orderSnapshot.discount, total: order.orderSnapshot.total, currency: order.orderSnapshot.currency, generatedAt: FieldValue.serverTimestamp() };
  await receiptRef.set(receipt);
  await writeOrderEvent({ orderId, vendorId: order.vendorId, eventType: "RECEIPT_GENERATED", actorUid: null, actorRole: "system", after: { receiptId: receiptRef.id, receiptNumber } });
  return receiptRef.id;
}
export const getReceipt = https.onCall(async (request) => {
  checkAppCheck(request, "getReceipt");
  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");
  const { orderId } = request.data ?? {};
  if (!orderId) throw new https.HttpsError("invalid-argument", "orderId is required.");
  const orderSnap = await db.collection("orders").doc(orderId).get();
  if (!orderSnap.exists) throw new https.HttpsError("not-found", "Order not found.");
  const order = orderSnap.data() as OrderDoc;
  const uid = request.auth.uid;
  const role = request.auth.token.role as string;
  const vendorId = request.auth.token.vendorId as string | undefined;
  if (order.customerId !== uid && !(role === "vendor" && order.vendorId === vendorId) && role !== "admin") throw new https.HttpsError("permission-denied", "You do not have access to this receipt.");
  const receiptsSnap = await db.collection("orders").doc(orderId).collection("receipts").orderBy("generatedAt","desc").limit(1).get();
  if (receiptsSnap.empty) throw new https.HttpsError("not-found", "No receipt has been generated yet.");
  return { success: true, receipt: receiptsSnap.docs[0].data() };
});
