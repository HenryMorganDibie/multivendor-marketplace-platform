import { firestore as functionsFirestore } from "firebase-functions/v1";
import { db, FieldValue, admin } from "../admin";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";

/**
 * Keeps discovery in step with country availability.
 *
 * `isDiscoverable` is recomputed by onVendorWrite from
 * `isPublished && isVerified && vendorStatus === 'active'`. Country
 * availability is not part of that, and it could not be: it lives in a
 * different collection, and a vendor document is not written when a country is
 * switched off.
 *
 * So switching a country off closed the front door and left the back one open.
 * Orders and conversations were refused at the point of creation, but every
 * vendor in that country stayed in the listings, searchable and openable, until
 * something unrelated happened to touch their record. A customer could browse
 * them, open a storefront, fill a basket, and only be refused at checkout.
 *
 * This closes that. Switching a country off hides its vendors immediately;
 * switching it back on restores the ones that qualify on their own merits.
 *
 * Reinstating is deliberately not a blanket `isDiscoverable = true`: a vendor
 * who was unpublished, unverified or suspended while their country was off must
 * stay hidden. The same formula is applied, so the country is one condition
 * among four rather than an override of the others.
 */

const BATCH_LIMIT = 400;

export const onCountryAvailabilityWrite = functionsFirestore
  .document("countryAvailability/{countryCode}")
  .onWrite(async (change, context) => {
    const countryCode = context.params.countryCode as string;
    const before = change.before.exists ? change.before.data() : undefined;
    const after = change.after.exists ? change.after.data() : undefined;

    const wasActive = before?.status === "ACTIVE";
    const isActive = after?.status === "ACTIVE";

    // Only a change in availability matters. Editing a country's display name
    // should not touch a single vendor.
    if (wasActive === isActive) return;

    const requestId = newRequestId();

    // Paginated, not "every vendor in the country in one read": the write side
    // already respected Firestore's 500-write batch cap, but the read above it
    // still pulled the whole country into memory first. Fine at two hundred
    // vendors, a real risk at fifty thousand. Ordering by document id gives a
    // stable cursor to page on without needing a new index.
    let lastDocId: string | null = null;
    let totalVendors = 0;
    let changed = 0;

    for (;;) {
      let query = db
        .collection("vendors")
        .where("countryCode", "==", countryCode)
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(BATCH_LIMIT);
      if (lastDocId) query = query.startAfter(lastDocId);

      const page = await query.get();
      if (page.empty) break;

      totalVendors += page.size;
      const batch = db.batch();
      let queued = 0;

      for (const doc of page.docs) {
        const data = doc.data();

        // The same formula onVendorWrite applies, with the country's new state
        // substituted in. Both places have to agree: they did not before, and
        // the two triggers undid each other's work on every vendor write.
        const shouldBeDiscoverable =
          isActive &&
          data.isPublished === true &&
          data.isVerified === true &&
          data.vendorStatus === "active";

        if (data.isDiscoverable === shouldBeDiscoverable) continue;

        batch.update(doc.ref, {
          isDiscoverable: shouldBeDiscoverable,
          updatedAt: FieldValue.serverTimestamp(),
        });
        queued += 1;
        changed += 1;
      }

      if (queued > 0) await batch.commit();

      lastDocId = page.docs[page.docs.length - 1].id;
      if (page.size < BATCH_LIMIT) break;
    }

    if (totalVendors === 0) return;

    await writeAuditLog({
      requestId,
      functionName: "onCountryAvailabilityWrite",
      actorUid: "system",
      actorRole: "admin",
      actorType: "system",
      targetType: "country",
      targetId: countryCode,
      eventType: isActive ? "country.reopened" : "country.closed",
      message: `${countryCode} ${isActive ? "reopened" : "closed"}; discovery updated for ${changed} of ${totalVendors} vendors.`,
      appCheck: { present: false, verified: null },
    });
  });
