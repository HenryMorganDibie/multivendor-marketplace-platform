import { firestore as functionsFirestore } from "firebase-functions/v1";
import { db } from "../admin";
import { VendorDoc } from "../types";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { isCountryActive } from "../utils/countryAvailability";

/**
 * Recomputes derived discovery flags on every vendor write:
 *
 *   isVerified     = verificationStatus === 'approved'
 *   isDiscoverable = isPublished && isVerified && vendorStatus === 'active'
 *                    && the vendor's country is available
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

    /**
     * Country availability is part of this, not separate from it.
     *
     * It used to be left out, which meant the two rules disagreed. Closing a
     * country hid its vendors, and then the next write to any of those vendor
     * documents recomputed the flag from the other three conditions and put them
     * straight back into discovery. The country was closed for orders and
     * conversations, and open for browsing, indefinitely.
     *
     * A missing availability document counts as closed, matching isCountryActive
     * and the client's instruction to reject safely when a country is unknown.
     */
    const countryOpen = await isCountryActive(data.countryCode ?? "");

    const computedIsDiscoverable =
      Boolean(data.isPublished) &&
      computedIsVerified &&
      data.vendorStatus === "active" &&
      countryOpen;

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
