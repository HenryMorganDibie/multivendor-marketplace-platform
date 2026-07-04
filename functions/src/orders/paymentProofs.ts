import { https } from "firebase-functions/v2";
import { db, FieldValue, Timestamp } from "../admin";
import { OrderDoc, PaymentProofDoc, PaymentProofImage } from "../types2";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { writeOrderEvent } from "./orderEvents";
import { sendPickupDetailsIfEligible } from "../chat/sendPickupDetails";
import { logOperationalEvent } from "../utils/operationalLogging";
const MAX_SUBMISSIONS = 2, MAX_IMAGES = 3;
export const submitPaymentProof = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "submitPaymentProof");
  if (!request.auth) throw new https.HttpsError("unauthenticated", "Sign in required.");
  const customerId = request.auth.uid;
  const { orderId, images, notes } = request.data ?? {};
  if (!orderId) throw new https.HttpsError("invalid-argument", "orderId is required.");
  if (!Array.isArray(images) || images.length === 0) throw new https.HttpsError("invalid-argument", "At least one image is required.");
  if (images.length > MAX_IMAGES) throw new https.HttpsError("invalid-argument", `Maximum ${MAX_IMAGES} images per submission.`);
  for (const img of images) { if (!img.storagePath?.trim()) throw new https.HttpsError("invalid-argument", "Each image must have a storagePath."); }
  const orderRef = db.collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw new https.HttpsError("not-found", "Order not found.");
  const order = orderSnap.data() as OrderDoc;
  if (order.customerId !== customerId) throw new https.HttpsError("permission-denied", "This is not your order.");
  const existingSnap = await orderRef.collection("paymentProofs").orderBy("createdAt","desc").limit(1).get();
  const lastProof = existingSnap.size > 0 ? existingSnap.docs[0].data() as PaymentProofDoc : null;
  const totalSubmissions = lastProof ? lastProof.submissionCount : 0;
  if (lastProof?.status === "LOCKED") throw new https.HttpsError("failed-precondition", "Payment proof submissions are locked after 2 rejected attempts.");
  if (lastProof?.status === "SUBMITTED") throw new https.HttpsError("failed-precondition", "A proof is already under review. Wait for the vendor to respond.");
  if (lastProof?.status === "REVIEWED") throw new https.HttpsError("failed-precondition", "Payment has already been confirmed.");
  if (totalSubmissions >= MAX_SUBMISSIONS) {
    if (lastProof && existingSnap.docs.length > 0) { await existingSnap.docs[0].ref.update({ status: "LOCKED", updatedAt: FieldValue.serverTimestamp() }); await orderRef.update({ paymentStatus: "PROOF_LOCKED", updatedAt: FieldValue.serverTimestamp() }); }
    await writeOrderEvent({ orderId, vendorId: order.vendorId, eventType: "PAYMENT_PROOF_LIMIT_REACHED", actorUid: customerId, actorRole: "customer", metadata: { submissionCount: totalSubmissions } });
    logOperationalEvent({
      functionName: "submitPaymentProof",
      event: "PAYMENT_PROOF_LIMIT_REACHED",
      severity: "WARNING",
      metadata: { orderId, vendorId: order.vendorId, customerId, submissionCount: totalSubmissions },
    });
    throw new https.HttpsError("resource-exhausted", "Maximum payment proof submissions reached (2). Contact the vendor directly.");
  }
  const now = FieldValue.serverTimestamp();
  const proofRef = orderRef.collection("paymentProofs").doc();
  const newCount = totalSubmissions + 1;
  const proofDoc: PaymentProofDoc = { proofId: proofRef.id, orderId, vendorId: order.vendorId, customerId, submissionCount: newCount, status: "SUBMITTED", notes: notes?.trim() ?? null, reviewReason: null, reviewedBy: null, reviewedAt: null, images: images.map((img: any) => ({ storagePath: img.storagePath.trim(), thumbnailPath: img.thumbnailPath?.trim() ?? img.storagePath.trim(), uploadedAt: Timestamp.now(), uploadedBy: customerId })), createdAt: now, updatedAt: now, uploadedBy: customerId };
  const batch = db.batch();
  batch.set(proofRef, proofDoc);
  batch.update(orderRef, { paymentStatus: "PROOF_SUBMITTED", updatedAt: now });
  await batch.commit();
  await writeOrderEvent({ orderId, vendorId: order.vendorId, eventType: "PAYMENT_PROOF_SUBMITTED", actorUid: customerId, actorRole: "customer", after: { proofId: proofRef.id, submissionCount: newCount } });
  await writeAuditLog({ requestId, functionName: "submitPaymentProof", actorUid: customerId, actorRole: "customer", actorType: "customer", targetType: "paymentProof", targetId: proofRef.id, eventType: "payment.proof_submitted", after: { submissionCount: newCount }, appCheck });
  return { success: true, proofId: proofRef.id, submissionCount: newCount };
});
export const reviewPaymentProof = https.onCall(async (request) => {
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "reviewPaymentProof");
  if (!request.auth || request.auth.token.role !== "vendor") throw new https.HttpsError("permission-denied", "Only vendors can review payment proofs.");
  const vendorId = request.auth.token.vendorId as string;
  const { orderId, proofId, decision, reviewReason } = request.data ?? {};
  if (!orderId) throw new https.HttpsError("invalid-argument", "orderId is required.");
  if (!proofId) throw new https.HttpsError("invalid-argument", "proofId is required.");
  if (!["accept","reject"].includes(decision)) throw new https.HttpsError("invalid-argument", "decision must be 'accept' or 'reject'.");
  if (decision === "reject" && !reviewReason?.trim()) throw new https.HttpsError("invalid-argument", "reviewReason is required when rejecting.");
  const orderRef = db.collection("orders").doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw new https.HttpsError("not-found", "Order not found.");
  const order = orderSnap.data() as OrderDoc;
  if (order.vendorId !== vendorId) throw new https.HttpsError("permission-denied", "This order does not belong to your store.");
  const proofRef = orderRef.collection("paymentProofs").doc(proofId);
  const proofSnap = await proofRef.get();
  if (!proofSnap.exists) throw new https.HttpsError("not-found", "Payment proof not found.");
  if (proofSnap.data()?.status !== "SUBMITTED") throw new https.HttpsError("failed-precondition", "This proof is not awaiting review.");
  const isAccept = decision === "accept";
  const now = FieldValue.serverTimestamp();
  const batch = db.batch();
  batch.update(proofRef, { status: isAccept ? "REVIEWED" : "REJECTED", reviewedBy: request.auth.uid, reviewedAt: now, reviewReason: reviewReason?.trim() ?? null, updatedAt: now });
  batch.update(orderRef, { paymentStatus: isAccept ? "PROOF_ACCEPTED" : "PROOF_REJECTED", updatedAt: now });
  await batch.commit();
  await writeOrderEvent({ orderId, vendorId: order.vendorId, eventType: isAccept ? "PAYMENT_PROOF_APPROVED" : "PAYMENT_PROOF_REJECTED", actorUid: request.auth.uid, actorRole: "vendor", after: { status: isAccept ? "REVIEWED" : "REJECTED" } });

  // Phase 3: pickup auto-send eligibility check — only fires on accept,
  // and sendPickupDetailsIfEligible internally re-validates every
  // condition (fulfillmentType, settings, idempotency) rather than
  // trusting this call site.
  if (isAccept) {
    await sendPickupDetailsIfEligible(orderId).catch((err) =>
      console.error(`sendPickupDetailsIfEligible failed for order ${orderId}`, err)
    );
  }
  await writeAuditLog({ requestId, functionName: "reviewPaymentProof", actorUid: request.auth.uid, actorRole: "vendor", actorType: "vendor", targetType: "paymentProof", targetId: proofId, eventType: `payment.proof_${decision}ed`, metadata: reviewReason ? { reviewReason } : undefined, appCheck });
  return { success: true, proofId, status: isAccept ? "REVIEWED" : "REJECTED" };
});
