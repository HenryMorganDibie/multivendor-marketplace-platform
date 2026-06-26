import { https } from "firebase-functions/v2";
import { firestore as functionsFirestore } from "firebase-functions/v1";
import { db, FieldValue, admin } from "../admin";
import { VerificationDocumentDoc } from "../types";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";

/**
 * Vendor verification submission flow (P1-FB-005 — previously missing).
 *
 * Flow:
 *  1. Vendor uploads documents to Storage at
 *     verificationDocuments/{vendorId}/{docId} (rules in storage.rules).
 *  2. Client calls `recordVerificationDocument` with the storage path for
 *     each uploaded file -> the function fetches the REAL object metadata
 *     from Cloud Storage (not client-supplied claims) and creates
 *     vendorVerification/{vendorId}/documents/{docId}, increments
 *     documentCount.
 *  3. Client calls `submitVendorVerification` once all required documents
 *     are uploaded -> moves verificationStatus from 'not_started' (or
 *     'retry_required') to 'pending_review', sets submittedAt.
 *
 * Vendors CANNOT set verificationStatus to 'pending_review' directly via
 * Firestore writes — only through this callable, which validates that all
 * `requiredSteps` have a corresponding document before allowing the
 * transition.
 */

const ALLOWED_DOC_TYPES = ["business_info", "identity_document", "proof_of_address", "other"] as const;
const ALLOWED_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"];
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // matches storage.rules underMb(15)

// ---------------------------------------------------------------------------
// recordVerificationDocument
// ---------------------------------------------------------------------------
export const recordVerificationDocument = https.onCall(
  async (request): Promise<{ success: true; docId: string }> => {
    const requestId = newRequestId();
    const appCheck = checkAppCheck(request, "recordVerificationDocument");

    if (!request.auth || request.auth.token.role !== "vendor") {
      throw new https.HttpsError("permission-denied", "Only vendors can record verification documents.");
    }

    const vendorId = request.auth.token.vendorId as string | undefined;
    if (!vendorId) {
      throw new https.HttpsError("failed-precondition", "No vendorId on auth token.");
    }

    const type = String(request.data?.type ?? "");
    const storagePath = String(request.data?.storagePath ?? "");

    if (!ALLOWED_DOC_TYPES.includes(type as typeof ALLOWED_DOC_TYPES[number])) {
      throw new https.HttpsError("invalid-argument", `type must be one of: ${ALLOWED_DOC_TYPES.join(", ")}`);
    }

    // Canonical path must match firestore/storage.rules exactly:
    // verificationDocuments/{vendorId}/{docId}
    if (!storagePath.startsWith(`verificationDocuments/${vendorId}/`)) {
      throw new https.HttpsError(
        "invalid-argument",
        `storagePath must be under verificationDocuments/${vendorId}/.`
      );
    }

    // SECURITY FIX (audit Medium-1): do NOT trust client-supplied
    // contentType/sizeBytes. Fetch the REAL object metadata from Cloud
    // Storage and validate against that instead. This also confirms the
    // object actually exists at the claimed path before we record it.
    const bucket = admin.storage().bucket();
    const file = bucket.file(storagePath);
    const [exists] = await file.exists();

    if (!exists) {
      throw new https.HttpsError(
        "failed-precondition",
        "No uploaded file found at the given storagePath. Upload the file before recording it."
      );
    }

    const [metadata] = await file.getMetadata();
    const contentType = metadata.contentType ?? "";
    const sizeBytes = Number(metadata.size ?? 0);

    if (!ALLOWED_MIME_TYPES.includes(contentType)) {
      throw new https.HttpsError(
        "invalid-argument",
        `Uploaded file has unsupported content type "${contentType}". Allowed: ${ALLOWED_MIME_TYPES.join(", ")}.`
      );
    }

    if (sizeBytes <= 0 || sizeBytes > MAX_FILE_SIZE_BYTES) {
      throw new https.HttpsError(
        "invalid-argument",
        `Uploaded file size (${sizeBytes} bytes) is invalid or exceeds the ${MAX_FILE_SIZE_BYTES} byte limit.`
      );
    }

    const verificationRef = db.collection("vendorVerification").doc(vendorId);
    const verificationSnap = await verificationRef.get();
    if (!verificationSnap.exists) {
      throw new https.HttpsError("not-found", "Vendor verification record not found.");
    }

    const docRef = verificationRef.collection("documents").doc();
    const docData: VerificationDocumentDoc = {
      docId: docRef.id,
      vendorId,
      type: type as VerificationDocumentDoc["type"],
      storagePath,
      contentType,
      sizeBytes,
      uploadedByUid: request.auth.uid,
      status: "uploaded",
      createdAt: FieldValue.serverTimestamp(),
    };

    await db.runTransaction(async (tx) => {
      tx.set(docRef, docData);
      tx.update(verificationRef, {
        documentCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });

    await writeAuditLog({
      requestId,
      functionName: "recordVerificationDocument",
      actorUid: request.auth.uid,
      actorRole: "vendor",
      actorType: "vendor",
      targetType: "vendorVerification",
      targetId: vendorId,
      eventType: "vendor.verification_document_recorded",
      after: { docId: docRef.id, type, contentType, sizeBytes },
      appCheck,
    });

    return { success: true, docId: docRef.id };
  }
);

// ---------------------------------------------------------------------------
// submitVendorVerification
// ---------------------------------------------------------------------------
export const submitVendorVerification = https.onCall(
  async (request): Promise<{ success: true; verificationStatus: "pending_review" }> => {
    const requestId = newRequestId();
    const appCheck = checkAppCheck(request, "submitVendorVerification");

    if (!request.auth || request.auth.token.role !== "vendor") {
      throw new https.HttpsError("permission-denied", "Only vendors can submit verification.");
    }

    const vendorId = request.auth.token.vendorId as string | undefined;
    if (!vendorId) {
      throw new https.HttpsError("failed-precondition", "No vendorId on auth token.");
    }

    const verificationRef = db.collection("vendorVerification").doc(vendorId);
    const vendorRef = db.collection("vendors").doc(vendorId);

    const verificationSnap = await verificationRef.get();
    if (!verificationSnap.exists) {
      throw new https.HttpsError("not-found", "Vendor verification record not found.");
    }

    const verification = verificationSnap.data()!;
    const before = { verificationStatus: verification.verificationStatus };

    if (!["not_started", "retry_required"].includes(verification.verificationStatus)) {
      throw new https.HttpsError(
        "failed-precondition",
        `Cannot submit for review from status "${verification.verificationStatus}".`
      );
    }

    // Validate all required steps have at least one uploaded document.
    const requiredSteps: string[] = verification.requiredSteps ?? [];
    const documentsSnap = await verificationRef.collection("documents").get();
    const uploadedTypes = new Set(documentsSnap.docs.map((d) => d.data().type));

    const missingSteps = requiredSteps.filter((step) => !uploadedTypes.has(step));
    if (missingSteps.length > 0) {
      throw new https.HttpsError(
        "failed-precondition",
        `Missing required documents: ${missingSteps.join(", ")}.`
      );
    }

    const now = FieldValue.serverTimestamp();

    const batch = db.batch();
    batch.update(verificationRef, {
      verificationStatus: "pending_review",
      submittedAt: now,
      manualReviewStatus: "pending",
      retryReason: null,
      updatedAt: now,
    });
    batch.update(vendorRef, {
      verificationStatus: "pending_review",
      updatedAt: now,
    });
    await batch.commit();

    await writeAuditLog({
      requestId,
      functionName: "submitVendorVerification",
      actorUid: request.auth.uid,
      actorRole: "vendor",
      actorType: "vendor",
      targetType: "vendorVerification",
      targetId: vendorId,
      eventType: "vendor.verification_submitted",
      before,
      after: { verificationStatus: "pending_review" },
      appCheck,
    });

    return { success: true, verificationStatus: "pending_review" };
  }
);

/**
 * onVendorVerificationDocumentWrite — Firestore trigger, currently a no-op
 * placeholder for future virus-scan/MIME-revalidation hooks. Included so
 * the trigger registration exists and is documented for Phase 2 extension.
 */
export const onVendorVerificationDocumentWrite = functionsFirestore
  .document("vendorVerification/{vendorId}/documents/{docId}")
  .onCreate(async () => {
    // Reserved for future virus-scan / re-validation pipeline.
    return null;
  });
