import { firestore as functionsFirestore } from "firebase-functions/v1";
import { db } from "../admin";
import { VendorDoc } from "../types";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";

/**
 * Recomputes derived discovery flags on every vendor write:
 *
 *   isVerified     = verificationStatus === 'approved'
 *   isDiscoverable = isPublished && isVerified && vendorStatus === 'active'
 *
 * Audits derived-flag changes (review fix: previously not audited).
 */
export const onVendorWrite = functionsFirestore
  .document("vendors/{vendorId}")
  .onWrite(async (change, context) => {
    if (!change.after.exists) {
      return;
    }

    const data = change.after.data() as VendorDoc;

    const computedIsVerified = data.verificationStatus === "approved";
    const computedIsDiscoverable =
      Boolean(data.isPublished) &&
      computedIsVerified &&
      data.vendorStatus === "active";

    if (
      data.isVerified === computedIsVerified &&
      data.isDiscoverable === computedIsDiscoverable
    ) {
      return;
    }

    const vendorId = context.params.vendorId;

    await db.collection("vendors").doc(vendorId).update({
      isVerified: computedIsVerified,
      isDiscoverable: computedIsDiscoverable,
    });

    await writeAuditLog({
      requestId: newRequestId(),
      functionName: "onVendorWrite",
      actorUid: null,
      actorRole: "system",
      actorType: "system",
      targetType: "vendor",
      targetId: vendorId,
      eventType: "vendor.discoverability_recomputed",
      before: { isVerified: data.isVerified, isDiscoverable: data.isDiscoverable },
      after: { isVerified: computedIsVerified, isDiscoverable: computedIsDiscoverable },
      appCheck: { present: false, verified: null },
    });
  });
